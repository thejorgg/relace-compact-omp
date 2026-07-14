import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import {
	callRelace,
	summaryFromRelace,
	targetTokensForModel,
	toAgentMessages,
} from "./api.js";
import { findOmpSettings, SettingsStore } from "./settings.js";
import type {
	CompactCallbacks,
	NoticeLevel,
	RelaceConfig,
	RelaceMessage,
	SessionState,
} from "./types.js";
import { globMatches, isPromiseLike, isRecord, toError } from "./utils.js";

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

function parseTarget(val: string): number | undefined {
	const trimmed = val.trim();
	const clean = trimmed.endsWith("%") ? trimmed.slice(0, -1).trim() : trimmed;
	const num = Number(clean);
	if (!Number.isNaN(num) && num >= 1 && num <= 100) {
		return num;
	}
	return undefined;
}

function parsePercentOrTokens(
	val: string,
): { value: number; type?: "percentage" | "tokens" } | undefined {
	const trimmed = val.trim();
	if (trimmed.endsWith("%")) {
		const num = Number(trimmed.slice(0, -1).trim());
		if (!Number.isNaN(num) && num > 0 && num <= 100) {
			return { value: num, type: "percentage" };
		}
		return undefined;
	}
	const tokensMatch = trimmed.match(/^(\d+)\s*tokens?$/i);
	if (tokensMatch) {
		const num = Number(tokensMatch[1]);
		if (!Number.isNaN(num) && num > 0) {
			return { value: num, type: "tokens" };
		}
		return undefined;
	}
	const num = Number(trimmed);
	if (!Number.isNaN(num) && num > 0) {
		return { value: num, type: num > 100 ? "tokens" : undefined };
	}
	return undefined;
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
			const trimmed = args.trim();
			const spaceIndex = trimmed.indexOf(" ");
			const cmd =
				spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex).trim();
			const cmdArgs = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex).trim();

			if (cmd === "status") await status(ctx);
			else if (cmd === "disable") {
				await settings.setEnabled(ctx.cwd, false);
				for (const state of sessions.values()) clearTimer(state);
				commandOutput(ctx, "Relace Compact disabled.", "info");
			} else if (cmd === "enable") {
				await settings.setEnabled(ctx.cwd, true);
				commandOutput(ctx, "Relace Compact enabled.", "info");
			} else if (cmd === "reset") {
				const state = sessionState(ctx);
				state.replacement = undefined;
				state.compactions = 0;
				commandOutput(ctx, "Relace session state cleared.", "info");
			} else if (cmd === "compact") await compact(ctx);
			else if (cmd === "target" || cmd === "set-target") {
				const config = await settings.getConfig(ctx);
				if (!cmdArgs) {
					commandOutput(
						ctx,
						`Current target percentage: ${config.targetPercent}%`,
						"info",
					);
				} else {
					const value = parseTarget(cmdArgs);
					if (value === undefined) {
						commandOutput(
							ctx,
							`Invalid target value: "${cmdArgs}". Must be a percentage between 1% and 100%.`,
							"error",
						);
					} else {
						await settings.setSetting(ctx.cwd, "relace.targetPercent", value);
						commandOutput(
							ctx,
							`Relace target percentage set to ${value}%.`,
							"info",
						);
					}
				}
			} else if (cmd === "threshold" || cmd === "set-threshold") {
				const config = await settings.getConfig(ctx);
				if (!cmdArgs) {
					const thresholdStr =
						config.piThresholdType === "percentage"
							? `${config.piThreshold}%`
							: `${config.piThreshold} tokens`;
					commandOutput(ctx, `Current threshold: ${thresholdStr}`, "info");
				} else {
					const parsed = parsePercentOrTokens(cmdArgs);
					if (parsed === undefined) {
						commandOutput(
							ctx,
							`Invalid threshold value: "${cmdArgs}". Must be a percentage (e.g. 66%) or a positive number of tokens (e.g. 5000).`,
							"error",
						);
					} else {
						if (parsed.type) {
							await settings.setSetting(
								ctx.cwd,
								"relace.pi.thresholdType",
								parsed.type,
							);
						}
						await settings.setSetting(
							ctx.cwd,
							"relace.pi.threshold",
							parsed.value,
						);
						const newType = parsed.type ?? config.piThresholdType;
						const thresholdStr =
							newType === "percentage"
								? `${parsed.value}%`
								: `${parsed.value} tokens`;
						commandOutput(
							ctx,
							`Relace threshold set to ${thresholdStr}.`,
							"info",
						);
					}
				}
			} else {
				commandOutput(
					ctx,
					"Usage: /compact-relace [compact|status|disable|enable|reset|target <value>|threshold <value>]",
					"info",
				);
			}
		},
	});
}
