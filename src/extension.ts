/**
 * Relace Compact Extension — high-speed trace compaction for oh-my-pi.
 *
 * Overrides the compaction transport so that, instead of calling a provider's
 * native summarize endpoint (OpenAI, Claude, etc.), it sends the trace to
 * Relace Compact (or any compatible API) and returns the result.
 *
 * The extension pairs with OMP's built-in auto-compact settings
 * (`compaction.strategy`, `compaction.thresholdTokens`, etc.) rather than
 * duplicating them.
 *
 * Compaction strategy guidance:
 *   - "context-full" — compact the trace in-place (most sessions).
 *   - "snapcompact"  — archive history to dense images (vision models only).
 *   - "off"           — disable auto-compaction entirely; plugin still honors
 *                       manual /compact via session_before_compact (if enabled).
 *
 * Settings it declares:
 *   - relace.apiKey          — API key for the compaction service.
 *   - relace.endpoint        — compaction endpoint URL.
 *   - relace.targetTokens    — approximate token budget post-compaction.
 *
 * Slash commands:
 *   - /relace status        — session compaction cache & settings state.
 *   - /relace reset         — clear cache and force re-compaction next turn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AgentMessage,
	type CompactionSummaryMessage,
	estimateTokens,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

interface RelaceMessage {
	role: "user" | "assistant" | "developer" | "tool" | "system";
	content: string | unknown[];
	tool_call_id?: string;
}

interface CompactResponse {
	messages: Message[];
}

interface SessionState {
	compactedMessages: Message[] | undefined;
	/** Number of original messages captured in compactedMessages (for slicing new turns). */
	originalCountCompacted: number;
	/** Timestamp when the previous turn ended (for cache miss detection). */
	lastTurnEndTime: number;
	/** Number of times this session has been compacted. */
	compactionCount: number;
}

// ============================================================================
// Custom Settings Loader (Workaround for OMP dynamic registration & duplicate package bugs)
// ============================================================================

interface LooseSettings {
	get(key: string): unknown;
}

let activeAgentDir = "";
let activeCwd = "";
let yamlConfig: Record<string, unknown> = {};
let lastLoadedTime = 0;

function getAgentDirFallback(): string {
	if (process.env.PI_CODING_AGENT_DIR) {
		return process.env.PI_CODING_AGENT_DIR;
	}
	const home = process.env.HOME || process.env.USERPROFILE || "";
	// Check pi-agent path first, then OMP path
	const piAgentDir = path.join(home, ".pi", "agent");
	if (fs.existsSync(piAgentDir)) {
		return piAgentDir;
	}
	return path.join(home, ".omp", "agent");
}

/**
 * Minimal YAML subset parser — handles flat keys, nested maps, and simple lists.
 * Supports the OMP/pi config.yml format:
 *   key: value
 *   parent:
 *     child: value
 *   list:
 *     - item1
 *     - item2
 * Does NOT support: multiline strings, anchors, aliases, flow style, tags.
 * Works in both Bun and Node.js runtimes (no Bun.YAML dependency).
 */
function parseSimpleYAML(content: string): Record<string, unknown> {
	return _parseYAMLInternal(content.split("\n"));
}

function _parseYAMLInternal(lines: string[]): Record<string, unknown> {
	const root: Record<string, unknown> = {};

	type Frame = {
		obj: Record<string, unknown> | unknown[];
		indent: number;
	};

	// Root frame sits at indent -2 so any indent >= 0 stays inside it
	const stack: Frame[] = [{ obj: root, indent: -2 }];

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const commentIdx = rawLine.indexOf("#");
		const line = commentIdx !== -1 ? rawLine.slice(0, commentIdx) : rawLine;
		if (line.trim() === "") continue;

		const indent = line.search(/\S/);
		const trimmed = line.trim();

		// Pop stack to find the correct parent: pop frames at the same or deeper indent
		while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
			stack.pop();
		}

		const parentFrame = stack[stack.length - 1];
		const parent = parentFrame.obj;

		// List item at this level
		if (trimmed.startsWith("- ")) {
			if (!Array.isArray(parent)) continue;
			const val = trimmed.slice(2).trim();
			parent.push(parseYAMLValue(val));
			continue;
		}

		// Key: value pair
		const colonIdx = trimmed.indexOf(":");
		if (colonIdx === -1) continue;
		const key = trimmed.slice(0, colonIdx).trim();
		const rawVal = trimmed.slice(colonIdx + 1).trim();

		if (rawVal === "") {
			// Nested structure follows — peek ahead to determine if it's a map or list
			let nextIndent = -1;
			let nextIsList = false;
			for (let j = i + 1; j < lines.length; j++) {
				const nl = lines[j].replace(/#.*$/, "");
				if (nl.trim() === "") continue;
				nextIndent = nl.search(/\S/);
				nextIsList = nl.trim().startsWith("- ");
				break;
			}

			if (nextIndent > indent) {
				if (nextIsList) {
					const arr: unknown[] = [];
					if (Array.isArray(parent)) continue;
					parent[key] = arr;
					// Frame indent = current indent (children are deeper)
					stack.push({ obj: arr, indent });
				} else {
					const obj: Record<string, unknown> = {};
					if (Array.isArray(parent)) continue;
					parent[key] = obj;
					// Frame indent = current indent (children are deeper)
					stack.push({ obj, indent });
				}
			} else {
				// Nothing follows at deeper indent — null value
				if (!Array.isArray(parent)) {
					parent[key] = null;
				}
			}
		} else {
			const val = parseYAMLValue(rawVal);
			if (Array.isArray(parent)) continue;
			parent[key] = val;
		}
	}

	return root;
}

function parseYAMLValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed === "null" || trimmed === "~") return null;
	if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
	if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function loadYamlSettings(
	agentDir: string,
	cwd: string,
): Record<string, unknown> {
	const config: Record<string, unknown> = {};

	// 1. Read global config (config.yml or settings.json)
	const globalConfigPath = path.join(agentDir, "config.yml");
	const globalSettingsPath = path.join(agentDir, "settings.json");

	if (fs.existsSync(globalConfigPath)) {
		try {
			const content = fs.readFileSync(globalConfigPath, "utf8");
			const parsed = parseSimpleYAML(content);
			if (parsed && typeof parsed === "object") {
				Object.assign(config, parsed);
			}
		} catch (_e) {
			// ignore
		}
	} else if (fs.existsSync(globalSettingsPath)) {
		try {
			const content = fs.readFileSync(globalSettingsPath, "utf8");
			const parsed = JSON.parse(content) as Record<string, unknown>;
			if (parsed && typeof parsed === "object") {
				Object.assign(config, parsed);
			}
		} catch (_e) {
			// ignore
		}
	}

	// 2. Read project config (check .omp, .pi, and .claude config locations)
	const projectPaths = [
		path.join(cwd, ".omp", "config.yml"),
		path.join(cwd, ".pi", "config.yml"),
		path.join(cwd, "config.yml"),
		path.join(cwd, ".claude", "config.yml"),
		path.join(cwd, ".pi", "settings.json"),
		path.join(cwd, "settings.json"),
	];
	for (const p of projectPaths) {
		if (fs.existsSync(p)) {
			try {
				const content = fs.readFileSync(p, "utf8");
				const parsed = p.endsWith(".json")
					? (JSON.parse(content) as Record<string, unknown>)
					: parseSimpleYAML(content);
				if (parsed && typeof parsed === "object") {
					Object.assign(config, parsed);
				}
				break; // Only load the first matching project config
			} catch (_e) {
				// ignore
			}
		}
	}

	return config;
}

function getFromConfig(config: Record<string, unknown>, key: string): unknown {
	if (key in config) {
		return config[key];
	}
	const parts = key.split(".");
	let val: unknown = config;
	for (const part of parts) {
		if (
			val &&
			typeof val === "object" &&
			part in (val as Record<string, unknown>)
		) {
			val = (val as Record<string, unknown>)[part];
		} else {
			return undefined;
		}
	}
	return val;
}

function ensureConfigLoaded() {
	const agentDir = activeAgentDir || getAgentDirFallback();
	const cwd = activeCwd || process.cwd();

	// Throttle config file reads to at most once every 5 seconds
	if (Date.now() - lastLoadedTime < 5000) {
		return;
	}
	yamlConfig = loadYamlSettings(agentDir, cwd);
	lastLoadedTime = Date.now();
}

const looseSettings: LooseSettings = {
	get(key: string): unknown {
		// 1. Environment variables override
		if (key === "relace.apiKey") {
			if (process.env.RELACE_API_KEY) return process.env.RELACE_API_KEY;
			if (process.env.RELACE_API_TOKEN) return process.env.RELACE_API_TOKEN;
		}

		// 2. Read config from files
		ensureConfigLoaded();
		const val = getFromConfig(yamlConfig, key);
		if (val !== undefined) {
			return val;
		}

		// 3. Default fallbacks
		switch (key) {
			case "relace.enabled":
				return true;
			case "relace.apiKey":
				return "";
			case "relace.endpoint":
				return RELACE_ENDPOINT_DEFAULT;
			case "relace.targetTokens":
				return 128000;
			case "relace.thresholdtype":
				return "integer";
			case "relace.idleCompactionThresholds":
				return {};
			case "compaction.idleTimeoutSeconds":
				return 300;
			case "compaction.idleThresholdTokens":
				return 200000;
			case "compaction.tokenLimit":
				return 0;
			default:
				return undefined;
		}
	},
};

// ============================================================================
// Constants
// ============================================================================

const COMPACTION_SUMMARY_ROLE = "compactionSummary";
const RELACE_ENDPOINT_DEFAULT =
	"https://compact.endpoint.relace.run/v1/code/compact";

// ============================================================================
// Session State
// ============================================================================

const sessionStates = new Map<string, SessionState>();

function getSessionState(sessionId: string): SessionState {
	let state = sessionStates.get(sessionId);
	if (!state) {
		state = {
			compactedMessages: undefined,
			originalCountCompacted: 0,
			lastTurnEndTime: Date.now(),
			compactionCount: 0,
		};
		sessionStates.set(sessionId, state);
	}
	return state;
}

// ============================================================================
// Settings
// ============================================================================

function isPluginEnabled(): boolean {
	const val = looseSettings.get("relace.enabled");
	return typeof val === "boolean" ? val : true;
}

function isOmp(): boolean {
	const agentDir = activeAgentDir || getAgentDirFallback();
	return agentDir.includes(".omp");
}

/**
 * Returns true if the active compaction strategy is one that Relace can honor.
 * Relace does in-place summarization (context-full) and can feed a handoff doc.
 * It cannot do snapcompact (vision bitmap), shake (surgical drop), or off.
 */
function isRelaceCompatibleStrategy(): boolean {
	if (!isOmp()) {
		// In regular pi-agent, we always run context-full compaction
		return true;
	}
	const strategy = looseSettings.get("compaction.strategy");
	return strategy === "context-full" || strategy === "handoff";
}

function getCompactionStrategy(): string {
	if (!isOmp()) {
		return "context-full";
	}
	const val = looseSettings.get("compaction.strategy");
	return typeof val === "string" ? val : "snapcompact";
}

function getApiKey(): string {
	const val = looseSettings.get("relace.apiKey");
	return typeof val === "string" ? val : "";
}

function getEndpoint(): string {
	const val = looseSettings.get("relace.endpoint");
	return typeof val === "string" ? val : RELACE_ENDPOINT_DEFAULT;
}

function getTargetTokens(model?: Model<Api>): number {
	const val = looseSettings.get("relace.targetTokens");
	const target =
		typeof val === "number" && Number.isFinite(val) && val > 0 ? val : 128_000;
	const thresholdType = looseSettings.get("relace.thresholdtype");
	if (
		thresholdType === "percentage" &&
		model?.contextWindow &&
		model.contextWindow > 0
	) {
		return Math.round((model.contextWindow * Math.min(target, 100)) / 100);
	}
	return Math.round(target);
}

function matchGlob(str: string, pattern: string): boolean {
	const escapeRegex = (s: string) =>
		s.replace(/([.*+?^=!:${}()|[\]/\\])/g, "\\$1");
	const regexStr = `^${pattern.split("*").map(escapeRegex).join(".*")}$`;
	return new RegExp(regexStr, "i").test(str);
}

function matchesModelPattern(
	modelId: string,
	provider: string,
	pattern: string,
): boolean {
	const fullId = `${provider}/${modelId}`;
	if (pattern.includes("/")) {
		return matchGlob(fullId, pattern);
	}
	return matchGlob(modelId, pattern) || matchGlob(provider, pattern);
}

function getIdleTimeoutSeconds(model: Model<Api> | undefined): number {
	const defaultFallback =
		(looseSettings.get("compaction.idleTimeoutSeconds") as number) ?? 300;
	if (!model) {
		return defaultFallback;
	}

	const modelId = model.id;
	const provider = model.provider || "";

	// 1. Check custom overrides from settings
	const customThresholds =
		(looseSettings.get("relace.idleCompactionThresholds") as Record<
			string,
			number
		>) || {};

	for (const pattern of Object.keys(customThresholds)) {
		if (matchesModelPattern(modelId, provider, pattern)) {
			const seconds = customThresholds[pattern];
			if (typeof seconds === "number" && seconds > 0) {
				return seconds;
			}
		}
	}

	// 2. If running under pi-agent, check default family rules
	const isPi = activeAgentDir.includes(".pi");
	if (isPi) {
		if (
			matchesModelPattern(modelId, provider, "openai*/gpt*") ||
			matchesModelPattern(modelId, provider, "openai-codex/gpt*") ||
			modelId.toLowerCase().startsWith("gpt") ||
			provider.toLowerCase() === "openai"
		) {
			return 1800; // 30 minutes
		}
		if (
			matchesModelPattern(modelId, provider, "claude*/*") ||
			matchesModelPattern(modelId, provider, "anthropic/*") ||
			modelId.toLowerCase().includes("claude") ||
			provider.toLowerCase() === "anthropic"
		) {
			return 300; // 5 minutes
		}
	}

	// 3. Fall back to OMP default
	return defaultFallback;
}

// ============================================================================
// Helpers
// ============================================================================

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		total += estimateTokens(msg);
	}
	return total;
}

function convertToLlmFormat(messages: AgentMessage[]): RelaceMessage[] {
	const result: RelaceMessage[] = [];
	for (const msg of messages) {
		const role = msg.role;
		if (
			role === "user" ||
			role === "assistant" ||
			(role as string) === "developer"
		) {
			if ("content" in msg) {
				const content = msg.content;
				if (typeof content === "string" || Array.isArray(content)) {
					result.push({
						role: role as "user" | "assistant" | "developer",
						content,
					});
				}
			}
		} else if (role === "toolResult") {
			if (
				msg &&
				typeof msg === "object" &&
				"toolCallId" in msg &&
				"content" in msg
			) {
				const content = msg.content;
				if (typeof content === "string" || Array.isArray(content)) {
					result.push({
						role: "tool",
						tool_call_id: String(msg.toolCallId),
						content,
					});
				}
			}
		}
	}
	return result;
}

function isCompactionSummaryMessage(
	msg: AgentMessage,
): msg is CompactionSummaryMessage {
	return msg.role === COMPACTION_SUMMARY_ROLE;
}

// ============================================================================
// Relace Compact API
// ============================================================================

async function callRelaceCompact(
	apiKey: string,
	endpoint: string,
	messages: RelaceMessage[],
	targetTokens: number,
	modelId: string,
	signal?: AbortSignal,
): Promise<CompactResponse> {
	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			messages,
			target_tokens: targetTokens,
			agent_model: modelId,
		}),
		signal,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(
			`Relace API error: ${res.status} ${res.statusText} — ${text}`,
		);
	}

	const data: unknown = await res.json();
	if (
		!data ||
		typeof data !== "object" ||
		!("messages" in data) ||
		!Array.isArray(data.messages)
	) {
		throw new Error(
			"Relace API returned an unexpected shape (missing messages array).",
		);
	}

	return data as CompactResponse;
}

// ============================================================================
// Compaction Logic
// ============================================================================

async function performCompaction(
	messages: AgentMessage[],
	model: Model<Api> | undefined,
	ctx: ExtensionContext,
): Promise<SessionState> {
	const sessionId = ctx.sessionManager.getSessionId();
	const state = getSessionState(sessionId);
	const apiKey = getApiKey();
	if (!apiKey) {
		throw new Error(
			"Relace API key not configured. Set relace.apiKey in settings.",
		);
	}

	const targetTokens = getTargetTokens(model);
	const endpoint = getEndpoint();
	const modelId = model?.id ?? "gpt-5.5";

	const llmMessages = convertToLlmFormat(messages);
	const response = await callRelaceCompact(
		apiKey,
		endpoint,
		llmMessages,
		targetTokens,
		modelId,
	);

	state.compactedMessages = response.messages;
	state.originalCountCompacted = messages.length;
	state.compactionCount += 1;

	return state;
}

/**
 * Compact if the context size meets OMP's configured idle or safety threshold.
 * OMP already provides these settings via the standard UI / settings.jsonl:
 *   - compaction.idleThresholdTokens
 *   - compaction.idleTimeoutSeconds (idle delay)
 *   - compaction.thresholdTokens / compaction.thresholdPercent (generic trigger)
 *
 * The plugin also requires the cache-miss (idle) gate to hold for "idle"-reason
 * compactions — compaction triggered by crossing a threshold mid-session keeps
 * the LLM running without interruption.
 */
function shouldCompact(messages: AgentMessage[]): {
	should: boolean;
	reason: "idle" | "threshold" | "none";
} {
	const totalTokens = estimateMessagesTokens(messages);
	const idleThreshold =
		get<number>("compaction.idleThresholdTokens") ?? 200_000;
	const tokenLimit = get<number>("compaction.tokenLimit") ?? 0;
	const thresholdTokens = tokenLimit > 0 ? tokenLimit : idleThreshold;

	if (totalTokens >= thresholdTokens) {
		return { should: true, reason: "threshold" };
	}
	if (totalTokens >= idleThreshold) {
		return { should: true, reason: "idle" };
	}
	return { should: false, reason: "none" };
}

function get<K = unknown>(key: string): K {
	return looseSettings.get(key) as K;
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Hook into OMP's native `session_before_compact` to reroute compaction to
 * Relace. This handles OpenAI Responses (via `preserveData.openaiRemoteCompaction`)
 * so native replay works, and also handles Claude via the `context` hook.
 */
async function onSessionBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
) {
	updateActivePaths(ctx);
	if (!isPluginEnabled()) {
		return;
	}
	if (!isRelaceCompatibleStrategy()) {
		return;
	}
	const apiKey = getApiKey();
	if (!apiKey) {
		return;
	}

	const messages = event.preparation.messagesToSummarize.concat(
		event.preparation.turnPrefixMessages,
	);
	const targetTokens = getTargetTokens(ctx.model);
	const endpoint = getEndpoint();
	const modelId = ctx.model?.id ?? "gpt-5.5";

	try {
		const wireMessages = convertToLlmFormat(messages);
		const response = await callRelaceCompact(
			apiKey,
			endpoint,
			wireMessages,
			targetTokens,
			modelId,
			event.signal,
		);

		const state = getSessionState(ctx.sessionManager.getSessionId());
		state.compactedMessages = response.messages;
		state.originalCountCompacted = messages.length;
		state.compactionCount += 1;

		return {
			compaction: {
				summary: `Compacted via Relace from ${event.preparation.tokensBefore} tokens.`,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				preserveData: {
					openaiRemoteCompaction: {
						provider: ctx.model?.provider ?? "openai",
						replacementHistory: response.messages,
					},
				},
			},
		};
	} catch (err) {
		console.error(
			"[relace-compact] native compaction hook failed:",
			err instanceof Error ? err.message : err,
		);
		return;
	}
}

/**
 * Hook into the `context` event to replace OMP's `compactionSummary` message with
 * the actual Relace-compacted message array. This is required for providers
 * that do not support stateful history replay (e.g., Claude/Anthropic Messages).
 *
 * It also triggers its own compaction on cache-miss idle turns or when the
 * configured safety threshold is crossed — covering the case where OMP's own
 * compaction is disabled (`compaction.strategy = "off"`) but the plugin is still
 * expected to do the right thing.
 */
async function onContext(
	event: ContextEvent,
	ctx: ExtensionContext,
): Promise<{ messages: AgentMessage[] } | undefined> {
	updateActivePaths(ctx);
	if (!isPluginEnabled()) {
		return undefined;
	}
	if (!isRelaceCompatibleStrategy()) {
		return undefined;
	}

	const messages = event.messages;
	const state = getSessionState(ctx.sessionManager.getSessionId());

	// Case 1: sessionManager already wrote a compactionSummary entry via OMP's
	// native flow. Swap it with our cached Relace messages (for non-OpenAI models).
	const compactionIdx = messages.findIndex(isCompactionSummaryMessage);
	if (compactionIdx !== -1 && state.compactedMessages) {
		const newTurns = messages.slice(compactionIdx + 1);
		const isOpenAi =
			ctx.model?.api === "openai-responses" ||
			ctx.model?.api === "openai-codex-responses" ||
			ctx.model?.api === "openai-completions";
		if (!isOpenAi) {
			return { messages: [...state.compactedMessages, ...newTurns] };
		}
	}

	// Case 2: we compacted in-memory but OMP has not yet written a compactionSummary
	// entry. Append any new turns since compaction.
	if (state.compactedMessages && state.originalCountCompacted > 0) {
		if (state.originalCountCompacted <= messages.length) {
			const newTurns = messages.slice(state.originalCountCompacted);
			return { messages: [...state.compactedMessages, ...newTurns] };
		}
	}

	// Case 3: no cache yet; decide whether to compact now based on thresholds.
	const { should, reason } = shouldCompact(messages);
	if (!should) {
		return undefined;
	}

	// Honor the idle gate for "idle"-reason triggers — don't fire mid-session.
	if (reason === "idle") {
		const idleDelayMs = getIdleTimeoutSeconds(ctx.model) * 1000;
		if (Date.now() - state.lastTurnEndTime <= idleDelayMs) {
			return undefined;
		}
	}

	try {
		await performCompaction(messages, ctx.model, ctx);
		return { messages };
	} catch (err) {
		console.error(
			"[relace-compact] compaction failed:",
			err instanceof Error ? err.message : err,
		);
		return undefined;
	}
}

function onTurnEnd(ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager.getSessionId();
	const state = getSessionState(sessionId);
	state.lastTurnEndTime = Date.now();
}

// ============================================================================
// Commands
// ============================================================================

function outputCommandMessage(
	ctx: ExtensionCommandContext,
	text: string,
	level: "info" | "warning" | "error",
): void {
	ctx.ui.notify(text, level);
	if (ctx.mode !== "tui") {
		if (level === "error") {
			console.error(text);
		} else {
			console.log(text);
		}
	}
}

function handleStatusCommand(ctx: ExtensionCommandContext): void {
	updateActivePaths(ctx);
	const sessionId = ctx.sessionManager.getSessionId();
	const state = getSessionState(sessionId);
	const currentTokens = ctx.getContextUsage()?.tokens ?? 0;
	const isEnabled = isPluginEnabled();
	const strategy = getCompactionStrategy();
	const strategyHonored = isRelaceCompatibleStrategy();
	const idleTimeout = getIdleTimeoutSeconds(ctx.model);

	const report = [
		`Relace Compact Status — Session ${sessionId}:`,
		`  Plugin enabled: ${isEnabled}`,
		`  Strategy:       ${strategy}${strategyHonored ? " (honored)" : " (ignored — Relace only handles context-full and handoff)"}`,
		`  Idle timeout:   ${idleTimeout} seconds (${(idleTimeout / 60).toFixed(1)} minutes)`,
		`  Cached:         ${state.compactedMessages ? `Yes (${state.compactedMessages.length} messages, ${state.compactionCount} compactions)` : "No"}`,
		`  Current tokens: ${currentTokens.toLocaleString()}`,
		`  Target tokens:  ${getTargetTokens().toLocaleString()}`,
		`  Endpoint:       ${getEndpoint()}`,
	].join("\n");

	outputCommandMessage(ctx, report, "info");
}

function handleResetCommand(ctx: ExtensionCommandContext): void {
	const sessionId = ctx.sessionManager.getSessionId();
	sessionStates.delete(sessionId);
	outputCommandMessage(
		ctx,
		`Relace compact cache cleared for session ${sessionId}. Next turn will re-compact if thresholds are met.`,
		"info",
	);
}

/**
 * Force a compaction immediately. This clears the cache and triggers performCompaction
 * on the current session messages via ctx.compact(), which fires the session_before_compact
 * hook that routes through Relace.
 */
async function handleCompactCommand(
	ctx: ExtensionCommandContext,
): Promise<void> {
	updateActivePaths(ctx);
	const sessionId = ctx.sessionManager.getSessionId();
	const apiKey = getApiKey();

	if (!isPluginEnabled()) {
		outputCommandMessage(
			ctx,
			"Relace Compact is disabled. Enable it with relace.enabled.",
			"warning",
		);
		return;
	}
	if (!isRelaceCompatibleStrategy()) {
		outputCommandMessage(
			ctx,
			`Current compaction strategy "${getCompactionStrategy()}" is not compatible with Relace. Set compaction.strategy to "context-full" or "handoff".`,
			"warning",
		);
		return;
	}
	if (!apiKey) {
		outputCommandMessage(
			ctx,
			"Relace API key not configured. Set relace.apiKey in settings or RELACE_API_KEY env var.",
			"warning",
		);
		return;
	}

	// Clear cache so the next context event doesn't skip
	sessionStates.delete(sessionId);

	outputCommandMessage(
		ctx,
		"Forcing Relace compaction via native /compact...",
		"info",
	);
	try {
		ctx.compact({
			customInstructions: "Compact via Relace Compact",
		});
		outputCommandMessage(
			ctx,
			"Relace compaction triggered successfully.",
			"info",
		);
	} catch (err) {
		outputCommandMessage(
			ctx,
			`Forced compaction failed: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

// ============================================================================
// Extension Registration
// ============================================================================

function updateActivePaths(ctx: ExtensionContext) {
	activeCwd = ctx.cwd;
	try {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) {
			activeAgentDir = path.resolve(sessionFile, "../..");
		}
	} catch (_e) {
		// ignore
	}
}

export default function relaceCompactExtension(pi: ExtensionAPI): void {
	const untypedPi = pi as unknown as Record<string, unknown>;
	if (untypedPi.pi) {
		const piSdk = untypedPi.pi as Record<string, unknown>;
		const SettingsClass = piSdk.Settings as Record<string, unknown>;
		if (SettingsClass?.instance) {
			try {
				const settingsInstance = SettingsClass.instance as Record<
					string,
					unknown
				>;
				if (typeof settingsInstance.getAgentDir === "function") {
					activeAgentDir = (settingsInstance.getAgentDir as () => string)();
				}
				if (typeof settingsInstance.getCwd === "function") {
					activeCwd = (settingsInstance.getCwd as () => string)();
				}
			} catch (_e) {
				// ignore
			}
		}
	}

	if (typeof untypedPi.setLabel === "function") {
		try {
			if (untypedPi.setLabel.length === 1) {
				(untypedPi.setLabel as (label: string) => void)("Relace Compact");
			}
		} catch (_e) {
			// ignore
		}
	}

	// Core event: intercept outbound LLM context to inject compacted messages.
	pi.on("context", onContext);

	// Track turn boundaries for cache miss detection.
	pi.on("turn_end", (_, ctx: ExtensionContext) => onTurnEnd(ctx));

	// Hook for OMP native compaction to reroute via Relace.
	pi.on("session_before_compact", onSessionBeforeCompact);

	// Slash commands for introspection and forced compaction.
	pi.registerCommand("compact-relace", {
		description: "Inspect or manage Relace Compact state",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				const sub = args.trim();
				if (sub === "status") handleStatusCommand(ctx);
				else if (sub === "reset") handleResetCommand(ctx);
				else if (sub === "compact") await handleCompactCommand(ctx);
				else {
					ctx.ui.notify(
						"Usage: /compact-relace status | /compact-relace reset | /compact-relace compact",
						"info",
					);
				}
			} catch (err) {
				console.error("[relace-compact] Command execution error:", err);
				if (err instanceof Error) {
					console.error(err.stack);
				}
				throw err;
			}
		},
	});
}
