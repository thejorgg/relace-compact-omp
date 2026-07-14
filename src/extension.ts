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
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionSummaryMessage,
	estimateTokens,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@oh-my-pi/pi-coding-agent";
import { settings } from "@oh-my-pi/pi-coding-agent";

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
let yamlConfig: Record<string, any> = {};
let lastLoadedTime = 0;

function getAgentDirFallback(): string {
	if (process.env.PI_CODING_AGENT_DIR) {
		return process.env.PI_CODING_AGENT_DIR;
	}
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return path.join(home, ".omp", "agent");
}

function loadYamlSettings(agentDir: string, cwd: string): Record<string, any> {
	const config: Record<string, any> = {};

	// 1. Read global config
	const globalConfigPath = path.join(agentDir, "config.yml");
	if (fs.existsSync(globalConfigPath)) {
		try {
			const content = fs.readFileSync(globalConfigPath, "utf8");
			const parsed = Bun.YAML.parse(content);
			if (parsed && typeof parsed === "object") {
				Object.assign(config, parsed);
			}
		} catch (e) {
			// ignore
		}
	}

	// 2. Read project config (check cwd/.omp/config.yml or cwd/config.yml or cwd/.claude/config.yml)
	const projectPaths = [
		path.join(cwd, ".omp", "config.yml"),
		path.join(cwd, "config.yml"),
		path.join(cwd, ".claude", "config.yml"),
	];
	for (const p of projectPaths) {
		if (fs.existsSync(p)) {
			try {
				const content = fs.readFileSync(p, "utf8");
				const parsed = Bun.YAML.parse(content);
				if (parsed && typeof parsed === "object") {
					Object.assign(config, parsed);
				}
				break; // Only load the first matching project config
			} catch (e) {
				// ignore
			}
		}
	}

	return config;
}

function getFromConfig(config: Record<string, any>, key: string): any {
	if (key in config) {
		return config[key];
	}
	const parts = key.split(".");
	let val: any = config;
	for (const part of parts) {
		if (val && typeof val === "object" && part in val) {
			val = val[part];
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

		// 3. Fallback to OMP-initialized settings instance (if it doesn't throw)
		try {
			const hostVal = settings.get(key as any);
			if (hostVal !== undefined) {
				return hostVal;
			}
		} catch (e) {
			// ignore
		}

		// 4. Default fallbacks
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

/**
 * Returns true if the active compaction strategy is one that Relace can honor.
 * Relace does in-place summarization (context-full) and can feed a handoff doc.
 * It cannot do snapcompact (vision bitmap), shake (surgical drop), or off.
 */
function isRelaceCompatibleStrategy(): boolean {
	const strategy = looseSettings.get("compaction.strategy");
	return strategy === "context-full" || strategy === "handoff";
}

function getCompactionStrategy(): string {
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

function getTargetTokens(model?: Model): number {
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
		if (role === "user" || role === "assistant" || role === "developer") {
			const content = msg.content;
			if (typeof content === "string" || Array.isArray(content)) {
				result.push({ role, content });
			}
		} else if (role === "toolResult") {
			if (msg && typeof msg === "object" && "toolCallId" in msg) {
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
	model: Model | undefined,
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
		const idleDelayMs =
			(get<number>("compaction.idleTimeoutSeconds") ?? 300) * 1000;
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

function handleStatusCommand(ctx: ExtensionCommandContext): void {
	const sessionId = ctx.sessionManager.getSessionId();
	const state = getSessionState(sessionId);
	const currentTokens = ctx.getContextUsage()?.tokens ?? 0;
	const isEnabled = isPluginEnabled();
	const strategy = getCompactionStrategy();
	const strategyHonored = isRelaceCompatibleStrategy();

	console.log(`Relace Compact Status — Session ${sessionId}:`);
	console.log(`  Plugin enabled: ${isEnabled}`);
	console.log(
		`  Strategy:       ${strategy}${strategyHonored ? " (honored)" : " (ignored — Relace only handles context-full and handoff)"}`,
	);
	console.log(
		`  Cached:         ${state.compactedMessages ? `Yes (${state.compactedMessages.length} messages, ${state.compactionCount} compactions)` : "No"}`,
	);
	console.log(`  Current tokens: ${currentTokens.toLocaleString()}`);
	console.log(`  Target tokens:  ${getTargetTokens().toLocaleString()}`);
	console.log(`  Endpoint:       ${getEndpoint()}`);
}

function handleResetCommand(ctx: ExtensionCommandContext): void {
	const sessionId = ctx.sessionManager.getSessionId();
	sessionStates.delete(sessionId);
	console.log(
		`Relace compact cache cleared for session ${sessionId}. Next turn will re-compact if thresholds are met.`,
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
	const sessionId = ctx.sessionManager.getSessionId();
	const apiKey = getApiKey();

	if (!isPluginEnabled()) {
		console.log("Relace Compact is disabled. Enable it with relace.enabled.");
		return;
	}
	if (!isRelaceCompatibleStrategy()) {
		console.log(
			`Current compaction strategy "${getCompactionStrategy()}" is not compatible with Relace. Set compaction.strategy to "context-full" or "handoff".`,
		);
		return;
	}
	if (!apiKey) {
		console.log(
			"Relace API key not configured. Set relace.apiKey in settings or RELACE_API_KEY env var.",
		);
		return;
	}

	// Clear cache so the next context event doesn't skip
	sessionStates.delete(sessionId);

	console.log("Forcing Relace compaction via native /compact...");
	try {
		await ctx.compact("Compact via Relace Compact");
		console.log("Relace compaction triggered successfully.");
	} catch (err) {
		console.error(
			"[relace-compact] forced compaction failed:",
			err instanceof Error ? err.message : err,
		);
	}
}

// ============================================================================
// Extension Registration
// ============================================================================

export default function relaceCompactExtension(pi: ExtensionAPI): void {
	if (pi.pi?.Settings?.instance) {
		try {
			activeAgentDir = pi.pi.Settings.instance.getAgentDir();
			activeCwd = pi.pi.Settings.instance.getCwd();
		} catch (e) {
			// ignore
		}
	}
	pi.setLabel("Relace Compact");

	// Core event: intercept outbound LLM context to inject compacted messages.
	pi.on("context", onContext);

	// Track turn boundaries for cache miss detection.
	pi.on("turn_end", (_, ctx: ExtensionContext) => onTurnEnd(ctx));

	// Hook for OMP native compaction to reroute via Relace.
	pi.on("session_before_compact", onSessionBeforeCompact);

	// Slash commands for introspection and forced compaction.
	pi.registerCommand("relace", {
		description: "Inspect or manage Relace Compact state",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				const sub = args.trim();
				if (sub === "status") handleStatusCommand(ctx);
				else if (sub === "reset") handleResetCommand(ctx);
				else if (sub === "compact") await handleCompactCommand(ctx);
				else {
					console.log(
						"Usage: /relace status | /relace reset | /relace compact",
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
