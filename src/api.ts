import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { RelaceConfig, RelaceMessage } from "./types.js";
import { isRecord } from "./utils.js";

export function toRelaceMessages(messages: AgentMessage[]): RelaceMessage[] {
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

export function parseRelaceMessages(value: unknown): RelaceMessage[] {
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

export function contentText(content: string | unknown[]): string {
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

export function toAgentMessages(
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

export function summaryFromRelace(messages: RelaceMessage[]): string {
	return messages
		.map((message) => `[${message.role}] ${contentText(message.content)}`)
		.join("\n\n");
}

export function targetTokensForModel(
	config: RelaceConfig,
	model: Model<Api> | undefined,
): number {
	const contextWindow = model?.contextWindow ?? 0;
	if (contextWindow <= 0) return Math.round(config.targetPercent * 1000);
	return Math.max(1, Math.round((contextWindow * config.targetPercent) / 100));
}

export async function callRelace(
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
