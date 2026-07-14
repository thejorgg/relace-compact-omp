import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "relace-compact-omp";
const RELACE_ENDPOINT = "https://compact.endpoint.relace.run/v1/code/compact";
const OMP_PLUGINS_MODULE = "@oh-my-pi/pi-coding-agent/extensibility/plugins";
const DEFAULT_IDLE_SECONDS = 300;
const DEFAULT_TARGET_PERCENT = 50;
const DEFAULT_PI_THRESHOLD = 80;

type HostKind = "omp" | "pi";
type PiThresholdType = "percentage" | "tokens";
type NoticeLevel = "info" | "warning" | "error";
type SettingsRecord = Record<string, unknown>;

interface DynamicSettings {
	get(key: string): unknown;
}

interface OmpPluginManager {
	setPluginSetting(name: string, key: string, value: unknown): Promise<void>;
}

interface OmpPluginModule {
	getPluginSettings(name: string, cwd: string): Promise<SettingsRecord>;
	PluginManager: new (cwd?: string) => OmpPluginManager;
}

interface RelaceMessage {
	role: "user" | "assistant" | "developer" | "tool" | "system";
	content: string | unknown[];
	tool_call_id?: string;
}

interface RelaceConfig {
	enabled: boolean;
	apiKey: string;
	endpoint: string;
	targetPercent: number;
	idleTimeoutSeconds: number;
	idleModelOverrides: ReadonlyArray<readonly [string, number]>;
	piThresholdType: PiThresholdType;
	piThreshold: number;
}

interface SessionState {
	replacement: Message[] | undefined;
	compactions: number;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	compactPending: boolean;
}

interface CompactCallbacks {
	onComplete?: () => void;
	onError?: (error: Error) => void;
}

function isRecord(value: unknown): value is SettingsRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return isRecord(value) && typeof value.then === "function";
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function getPathValue(values: SettingsRecord, key: string): unknown {
	if (key in values) return values[key];
	let current: unknown = values;
	for (const segment of key.split(".")) {
		if (!isRecord(current) || !(segment in current)) return undefined;
		current = current[segment];
	}
	return current;
}

function setPathValue(
	values: SettingsRecord,
	key: string,
	value: unknown,
): void {
	const segments = key.split(".");
	let current = values;
	for (const segment of segments.slice(0, -1)) {
		const child = current[segment];
		if (isRecord(child)) current = child;
		else {
			const created: SettingsRecord = {};
			current[segment] = created;
			current = created;
		}
	}
	const leaf = segments.at(-1);
	if (leaf) current[leaf] = value;
}

function mergeSettings(
	base: SettingsRecord,
	override: SettingsRecord,
): SettingsRecord {
	const merged: SettingsRecord = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const baseValue = merged[key];
		merged[key] =
			isRecord(baseValue) && isRecord(value)
				? mergeSettings(baseValue, value)
				: value;
	}
	return merged;
}

function readJsonObject(filePath: string): SettingsRecord {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (!isRecord(parsed))
			throw new Error(`${filePath} must contain a JSON object.`);
		return parsed;
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return {};
		throw error;
	}
}

function writeJsonObject(filePath: string, values: SettingsRecord): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(
		temporaryPath,
		`${JSON.stringify(values, null, "\t")}\n`,
		"utf8",
	);
	fs.renameSync(temporaryPath, filePath);
}

function findOmpSettings(pi: ExtensionAPI): DynamicSettings | undefined {
	const extensionApi: unknown = pi;
	if (!isRecord(extensionApi) || !isRecord(extensionApi.pi)) return undefined;
	const candidate = extensionApi.pi.settings;
	if (!isRecord(candidate) || typeof candidate.get !== "function")
		return undefined;
	return candidate as unknown as DynamicSettings;
}

async function loadOmpPluginModule(): Promise<OmpPluginModule> {
	const loaded: unknown = await import(OMP_PLUGINS_MODULE);
	if (
		!isRecord(loaded) ||
		typeof loaded.getPluginSettings !== "function" ||
		typeof loaded.PluginManager !== "function"
	) {
		throw new Error("OMP plugin settings API is unavailable.");
	}
	return {
		getPluginSettings:
			loaded.getPluginSettings as OmpPluginModule["getPluginSettings"],
		PluginManager: loaded.PluginManager as OmpPluginModule["PluginManager"],
	};
}

function parseIdleOverrides(
	value: unknown,
): ReadonlyArray<readonly [string, number]> {
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			return [];
		}
	}
	if (!isRecord(parsed)) return [];
	const overrides: Array<readonly [string, number]> = [];
	for (const [pattern, seconds] of Object.entries(parsed)) {
		if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0)
			overrides.push([pattern, seconds]);
	}
	return overrides;
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: fallback;
}

function endpointSetting(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return RELACE_ENDPOINT;
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:" || parsed.protocol === "http:"
			? parsed.toString()
			: RELACE_ENDPOINT;
	} catch {
		return RELACE_ENDPOINT;
	}
}

function buildConfig(
	values: SettingsRecord,
	enabledOverride: boolean | undefined,
): RelaceConfig {
	const configuredKey = getPathValue(values, "relace.apiKey");
	const apiKey =
		process.env.RELACE_API_KEY ??
		process.env.RELACE_API_TOKEN ??
		(typeof configuredKey === "string" ? configuredKey : "");
	const thresholdType = getPathValue(values, "relace.pi.thresholdType");
	return {
		enabled:
			enabledOverride ?? getPathValue(values, "relace.enabled") !== false,
		apiKey,
		endpoint: endpointSetting(getPathValue(values, "relace.endpoint")),
		targetPercent: Math.min(
			100,
			Math.max(
				1,
				positiveNumber(
					getPathValue(values, "relace.targetPercent"),
					DEFAULT_TARGET_PERCENT,
				),
			),
		),
		idleTimeoutSeconds: nonNegativeNumber(
			getPathValue(values, "relace.idleTimeoutSeconds"),
			DEFAULT_IDLE_SECONDS,
		),
		idleModelOverrides: parseIdleOverrides(
			getPathValue(values, "relace.idleModelOverrides"),
		),
		piThresholdType: thresholdType === "tokens" ? "tokens" : "percentage",
		piThreshold: positiveNumber(
			getPathValue(values, "relace.pi.threshold"),
			DEFAULT_PI_THRESHOLD,
		),
	};
}

class SettingsStore {
	readonly host: HostKind;
	readonly #ompSettings: DynamicSettings | undefined;
	#cacheKey = "";
	#cachedConfig: RelaceConfig | undefined;
	#enabledOverride: boolean | undefined;
	#ompModule: Promise<OmpPluginModule> | undefined;

	constructor(host: HostKind, ompSettings: DynamicSettings | undefined) {
		this.host = host;
		this.#ompSettings = ompSettings;
	}

	async getConfig(ctx: ExtensionContext): Promise<RelaceConfig> {
		const trusted = this.host === "omp" || ctx.isProjectTrusted();
		const cacheKey = `${ctx.cwd}\u0000${trusted}`;
		if (this.#cachedConfig && this.#cacheKey === cacheKey)
			return this.#cachedConfig;
		let values: SettingsRecord;
		if (this.host === "omp")
			values = await (await this.#getOmpModule()).getPluginSettings(
				PACKAGE_NAME,
				ctx.cwd,
			);
		else {
			const agentDir =
				process.env.PI_CODING_AGENT_DIR ??
				path.join(process.env.HOME ?? "", ".pi", "agent");
			const globalValues = readJsonObject(path.join(agentDir, "settings.json"));
			const projectValues = trusted
				? readJsonObject(path.join(ctx.cwd, ".pi", "settings.json"))
				: {};
			values = mergeSettings(globalValues, projectValues);
		}
		this.#cacheKey = cacheKey;
		this.#cachedConfig = buildConfig(values, this.#enabledOverride);
		return this.#cachedConfig;
	}

	getOmpStrategy(): "context-full" | "handoff" | undefined {
		const value = this.#ompSettings?.get("compaction.strategy");
		return value === "context-full" || value === "handoff" ? value : undefined;
	}

	async setEnabled(cwd: string, enabled: boolean): Promise<void> {
		this.#enabledOverride = enabled;
		if (this.host === "omp") {
			const module = await this.#getOmpModule();
			await new module.PluginManager(cwd).setPluginSetting(
				PACKAGE_NAME,
				"relace.enabled",
				enabled,
			);
		} else {
			const agentDir =
				process.env.PI_CODING_AGENT_DIR ??
				path.join(process.env.HOME ?? "", ".pi", "agent");
			const settingsPath = path.join(agentDir, "settings.json");
			const values = readJsonObject(settingsPath);
			setPathValue(values, "relace.enabled", enabled);
			writeJsonObject(settingsPath, values);
		}
		this.#cachedConfig = undefined;
	}

	#getOmpModule(): Promise<OmpPluginModule> {
		this.#ompModule ??= loadOmpPluginModule();
		return this.#ompModule;
	}
}

function globMatches(value: string, pattern: string): boolean {
	const escaped = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "i").test(value);
}

function idleTimeoutForModel(
	config: RelaceConfig,
	model: Model<Api> | undefined,
): number {
	if (!model) return config.idleTimeoutSeconds;
	const fullName = `${model.provider}/${model.id}`;
	for (const [pattern, seconds] of config.idleModelOverrides) {
		if (globMatches(pattern.includes("/") ? fullName : model.id, pattern))
			return seconds;
	}
	return config.idleTimeoutSeconds;
}

function piThresholdTokens(
	config: RelaceConfig,
	model: Model<Api> | undefined,
): number | undefined {
	if (config.piThresholdType === "tokens")
		return Math.round(config.piThreshold);
	if (!model?.contextWindow) return undefined;
	return Math.round(
		(model.contextWindow * Math.min(config.piThreshold, 100)) / 100,
	);
}

function supportsRoute(settings: SettingsStore): boolean {
	return settings.host === "pi" || settings.getOmpStrategy() !== undefined;
}

function toRelaceMessages(messages: AgentMessage[]): RelaceMessage[] {
	const converted: RelaceMessage[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "user":
			case "assistant":
				converted.push({ role: message.role, content: message.content });
				break;
			case "toolResult":
				converted.push({
					role: "tool",
					tool_call_id: message.toolCallId,
					content: message.content,
				});
				break;
			case "compactionSummary":
			case "branchSummary":
				converted.push({ role: "developer", content: message.summary });
				break;
			case "custom":
				converted.push({ role: "developer", content: message.content });
				break;
			case "bashExecution":
				converted.push({
					role: "tool",
					content: `$ ${message.command}\n${message.output}`,
				});
				break;
			default:
				converted.push({ role: "developer", content: JSON.stringify(message) });
		}
	}
	return converted;
}

function parseRelaceMessages(value: unknown): RelaceMessage[] {
	if (
		!isRecord(value) ||
		!Array.isArray(value.messages) ||
		value.messages.length === 0
	)
		throw new Error("Relace API returned no compacted messages.");
	const messages: RelaceMessage[] = [];
	for (const candidate of value.messages) {
		if (!isRecord(candidate))
			throw new Error("Relace API returned an invalid message.");
		const role = candidate.role;
		const content = candidate.content;
		if (
			(role !== "user" &&
				role !== "assistant" &&
				role !== "developer" &&
				role !== "tool" &&
				role !== "system") ||
			(typeof content !== "string" && !Array.isArray(content))
		)
			throw new Error("Relace API returned an invalid message shape.");
		const toolCallId = candidate.tool_call_id;
		if (toolCallId !== undefined && typeof toolCallId !== "string")
			throw new Error("Relace API returned an invalid tool_call_id.");
		messages.push({
			role,
			content,
			...(toolCallId ? { tool_call_id: toolCallId } : {}),
		});
	}
	return messages;
}

function contentText(content: string | unknown[]): string {
	if (typeof content === "string") return content;
	return content
		.map((block) => {
			if (isRecord(block)) {
				if (typeof block.text === "string") return block.text;
				if (typeof block.thinking === "string") return block.thinking;
			}
			return JSON.stringify(block);
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

function toAgentMessages(
	messages: RelaceMessage[],
	model: Model<Api> | undefined,
): Message[] {
	const converted: Message[] = [];
	const baseTimestamp = Date.now();
	for (const [index, message] of messages.entries()) {
		const text = contentText(message.content);
		const timestamp = baseTimestamp + index;
		if (message.role === "assistant") {
			converted.push({
				role: "assistant",
				content: [{ type: "text", text }],
				api: model?.api ?? "openai-responses",
				provider: model?.provider ?? "openai",
				model: model?.id ?? "relace-compact",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp,
			});
		} else if (message.role === "user")
			converted.push({ role: "user", content: text, timestamp });
		else {
			const suffix = message.tool_call_id ? ` (${message.tool_call_id})` : "";
			converted.push({
				role: "user",
				content: `[${message.role}${suffix}]\n${text}`,
				timestamp,
			});
		}
	}
	return converted;
}

function summaryFromRelace(messages: RelaceMessage[]): string {
	return messages
		.map((message) => `[${message.role}] ${contentText(message.content)}`)
		.join("\n\n");
}

function targetTokensForModel(
	config: RelaceConfig,
	model: Model<Api> | undefined,
): number {
	const contextWindow = model?.contextWindow ?? 0;
	if (contextWindow <= 0) return Math.round(config.targetPercent * 1000);
	return Math.max(1, Math.round((contextWindow * config.targetPercent) / 100));
}

async function callRelace(
	config: RelaceConfig,
	messages: AgentMessage[],
	model: Model<Api> | undefined,
	signal: AbortSignal,
): Promise<RelaceMessage[]> {
	const response = await fetch(config.endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			messages: toRelaceMessages(messages),
			target_tokens: targetTokensForModel(config, model),
			agent_model: model?.id ?? "unknown",
		}),
		signal,
	});
	if (!response.ok)
		throw new Error(
			`Relace API error ${response.status}: ${await response.text()}`,
		);
	const body: unknown = await response.json();
	return parseRelaceMessages(body);
}

function commandOutput(
	ctx: ExtensionCommandContext,
	text: string,
	level: NoticeLevel,
): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else if (level === "error") console.error(text);
	else console.log(text);
}

function eventError(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "error");
	else console.error(message);
}

function lastCompactionIndex(messages: AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--)
		if (messages[index]?.role === "compactionSummary") return index;
	return -1;
}

function clearTimer(state: SessionState): void {
	if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
	state.idleTimer = undefined;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	if (isRecord(timer) && typeof timer.unref === "function") timer.unref();
}

function invokeCompact(
	ctx: ExtensionContext,
	callbacks: CompactCallbacks,
): void {
	let settled = false;
	const complete = () => {
		if (!settled) {
			settled = true;
			callbacks.onComplete?.();
		}
	};
	const fail = (error: unknown) => {
		if (!settled) {
			settled = true;
			callbacks.onError?.(toError(error));
		}
	};
	try {
		const compact = ctx.compact as unknown as (
			options: CompactCallbacks,
		) => unknown;
		const result = compact({
			onComplete: complete,
			onError: (error) => fail(error),
		});
		if (isPromiseLike(result))
			void Promise.resolve(result).then(complete, fail);
	} catch (error) {
		fail(error);
	}
}

export default function relaceCompactExtension(pi: ExtensionAPI): void {
	const ompSettings = findOmpSettings(pi);
	const settings = new SettingsStore(ompSettings ? "omp" : "pi", ompSettings);
	const sessions = new Map<string, SessionState>();

	const sessionState = (ctx: ExtensionContext): SessionState => {
		const sessionId = ctx.sessionManager.getSessionId();
		let state = sessions.get(sessionId);
		if (!state) {
			state = {
				replacement: undefined,
				compactions: 0,
				idleTimer: undefined,
				compactPending: false,
			};
			sessions.set(sessionId, state);
		}
		return state;
	};

	const requestCompact = (ctx: ExtensionContext, announce: boolean): void => {
		const state = sessionState(ctx);
		if (state.compactPending) return;
		state.compactPending = true;
		clearTimer(state);
		invokeCompact(ctx, {
			onComplete: () => {
				state.compactPending = false;
				if (announce && ctx.hasUI)
					ctx.ui.notify("Relace compaction complete.", "info");
			},
			onError: (error) => {
				state.compactPending = false;
				const benign =
					error.message.includes("Already compacted") ||
					error.message.includes("Nothing to compact");
				if (announce || !benign)
					eventError(ctx, `Relace compaction failed: ${error.message}`);
			},
		});
	};

	const onBeforeCompact = async (
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
	) => {
		const state = sessionState(ctx);
		clearTimer(state);
		const config = await settings.getConfig(ctx);
		if (!config.enabled || !supportsRoute(settings)) return;
		if (!config.apiKey) {
			eventError(ctx, "Relace API key is not configured.");
			return { cancel: true };
		}
		const sourceMessages = event.preparation.messagesToSummarize.concat(
			event.preparation.turnPrefixMessages,
		);
		try {
			const relaceMessages = await callRelace(
				config,
				sourceMessages,
				ctx.model,
				event.signal,
			);
			state.replacement = toAgentMessages(relaceMessages, ctx.model);
			state.compactions += 1;
			return {
				compaction: {
					summary: summaryFromRelace(relaceMessages),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: { relaceMessages },
				},
			};
		} catch (error) {
			eventError(ctx, `Relace compaction failed: ${toError(error).message}`);
			return { cancel: true };
		}
	};

	const recoverReplacement = (ctx: ExtensionContext): Message[] | undefined => {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type !== "compaction") continue;
			const details = entry.details as unknown as
				| { relaceMessages?: RelaceMessage[] }
				| undefined;
			if (!isRecord(details) || !Array.isArray(details.relaceMessages))
				continue;
			return toAgentMessages(details.relaceMessages, ctx.model);
		}
		return undefined;
	};

	const onContext = async (
		event: ContextEvent,
		ctx: ExtensionContext,
	): Promise<{ messages: AgentMessage[] } | undefined> => {
		if (!(await settings.getConfig(ctx)).enabled) return undefined;
		const state = sessionState(ctx);
		if (state.replacement === undefined) {
			state.replacement = recoverReplacement(ctx);
		}
		if (!state.replacement) return undefined;
		const index = lastCompactionIndex(event.messages);
		if (index < 0) return undefined;
		return {
			messages: [...state.replacement, ...event.messages.slice(index + 1)],
		};
	};

	const onAgentEnd = async (
		_event: unknown,
		ctx: ExtensionContext,
	): Promise<void> => {
		const config = await settings.getConfig(ctx);
		const state = sessionState(ctx);
		clearTimer(state);
		if (
			!config.enabled ||
			!config.apiKey ||
			!supportsRoute(settings) ||
			state.compactPending
		)
			return;
		if (settings.host === "pi") {
			const usage = ctx.getContextUsage();
			const threshold = piThresholdTokens(config, ctx.model);
			if (
				usage?.tokens !== null &&
				usage?.tokens !== undefined &&
				threshold !== undefined &&
				usage.tokens >= threshold
			) {
				requestCompact(ctx, false);
				return;
			}
		}
		const idleSeconds = idleTimeoutForModel(config, ctx.model);
		if (idleSeconds === 0) return;
		const sessionId = ctx.sessionManager.getSessionId();
		state.idleTimer = setTimeout(() => {
			if (
				ctx.sessionManager.getSessionId() === sessionId &&
				ctx.isIdle() &&
				!ctx.hasPendingMessages() &&
				!state.compactPending
			)
				requestCompact(ctx, false);
		}, idleSeconds * 1000);
		unrefTimer(state.idleTimer);
	};

	const status = async (ctx: ExtensionCommandContext): Promise<void> => {
		const config = await settings.getConfig(ctx);
		const state = sessionState(ctx);
		const usage = ctx.getContextUsage();
		const idleSeconds = idleTimeoutForModel(config, ctx.model);
		const strategy = settings.getOmpStrategy();
		const route =
			settings.host === "pi"
				? "all pi compactions → Relace"
				: strategy === "context-full"
					? "OMP full-context → Relace"
					: strategy === "handoff"
						? "OMP handoff compact hook → Relace"
						: "OMP native (Relace routing inactive)";
		const lines = [
			"Relace Compact",
			`Host: ${settings.host === "omp" ? "OMP" : "pi-agent"}`,
			`Enabled: ${config.enabled ? "yes" : "no"}`,
			`API key: ${config.apiKey ? "configured" : "missing"}`,
			`Route: ${route}`,
			`Idle: ${idleSeconds}s`,
			`Target: ${config.targetPercent}% (${targetTokensForModel(config, ctx.model).toLocaleString()} tokens)`,
			`Context: ${usage?.tokens?.toLocaleString() ?? "unknown"} / ${usage?.contextWindow.toLocaleString() ?? "unknown"}`,
			`Session compactions: ${state.compactions}`,
		];
		if (settings.host === "pi") {
			const threshold = piThresholdTokens(config, ctx.model);
			const trigger =
				config.piThresholdType === "percentage"
					? `${config.piThreshold}%${threshold ? ` (${threshold.toLocaleString()} tokens)` : ""}`
					: `${Math.round(config.piThreshold).toLocaleString()} tokens`;
			lines.splice(6, 0, `Pi trigger: ${trigger}`);
		}
		if (settings.host === "omp" && strategy === undefined) {
			lines.push(
				"Notice: change Compaction Strategy to context-full to use Relace.",
			);
		}
		commandOutput(ctx, lines.join("\n"), "info");
	};

	const compact = async (ctx: ExtensionCommandContext): Promise<void> => {
		const config = await settings.getConfig(ctx);
		if (!config.enabled) {
			commandOutput(
				ctx,
				"Relace Compact is disabled. Run /compact-relace enable.",
				"warning",
			);
			return;
		}
		if (!supportsRoute(settings)) {
			commandOutput(
				ctx,
				"Relace routing is inactive for the current OMP compaction strategy.",
				"warning",
			);
			return;
		}
		if (!config.apiKey) {
			commandOutput(ctx, "Relace API key is not configured.", "warning");
			return;
		}
		commandOutput(ctx, "Starting Relace compaction…", "info");
		requestCompact(ctx, true);
	};

	pi.on("session_before_compact", onBeforeCompact);
	pi.on("context", onContext);
	pi.on("agent_end", onAgentEnd);
	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const state = sessions.get(sessionId);
		if (state) clearTimer(state);
		sessions.delete(sessionId);
	});

	pi.registerCommand("compact-relace", {
		description: "Compact with Relace or inspect its state",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const command = args.trim();
			if (command === "status") await status(ctx);
			else if (command === "disable") {
				await settings.setEnabled(ctx.cwd, false);
				for (const state of sessions.values()) clearTimer(state);
				commandOutput(ctx, "Relace Compact disabled.", "info");
			} else if (command === "enable") {
				await settings.setEnabled(ctx.cwd, true);
				commandOutput(ctx, "Relace Compact enabled.", "info");
			} else if (command === "reset") {
				const state = sessionState(ctx);
				state.replacement = undefined;
				state.compactions = 0;
				commandOutput(ctx, "Relace session state cleared.", "info");
			} else if (command === "compact") await compact(ctx);
			else
				commandOutput(
					ctx,
					"Usage: /compact-relace [compact|status|disable|enable|reset]",
					"info",
				);
		},
	});
}
