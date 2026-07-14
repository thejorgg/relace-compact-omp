import type { Message } from "@earendil-works/pi-ai";

export type HostKind = "omp" | "pi";
export type PiThresholdType = "percentage" | "tokens";
export type NoticeLevel = "info" | "warning" | "error";
export type SettingsRecord = Record<string, unknown>;

export interface DynamicSettings {
	get(key: string): unknown;
}

export interface OmpPluginManager {
	setPluginSetting(name: string, key: string, value: unknown): Promise<void>;
}

export interface OmpPluginModule {
	getPluginSettings(name: string, cwd: string): Promise<SettingsRecord>;
	PluginManager: new (cwd?: string) => OmpPluginManager;
}

export interface RelaceMessage {
	role: "user" | "assistant" | "developer" | "tool" | "system";
	content: string | unknown[];
	tool_call_id?: string;
}

export interface RelaceConfig {
	enabled: boolean;
	apiKey: string;
	endpoint: string;
	targetPercent: number;
	idleTimeoutSeconds: number;
	idleModelOverrides: ReadonlyArray<readonly [string, number]>;
	piThresholdType: PiThresholdType;
	piThreshold: number;
}

export interface SessionState {
	replacement: Message[] | undefined;
	compactions: number;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	compactPending: boolean;
}

export interface CompactCallbacks {
	onComplete?: () => void;
	onError?: (error: Error) => void;
}
