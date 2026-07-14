import * as fs from "node:fs";
import * as path from "node:path";
import type { SettingsRecord } from "./types.js";

export function isRecord(value: unknown): value is SettingsRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return isRecord(value) && typeof value.then === "function";
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export function getPathValue(values: SettingsRecord, key: string): unknown {
	if (key in values) return values[key];
	let current: unknown = values;
	for (const segment of key.split(".")) {
		if (!isRecord(current) || !(segment in current)) return undefined;
		current = current[segment];
	}
	return current;
}

export function setPathValue(
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

export function mergeSettings(
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

export function readJsonObject(filePath: string): SettingsRecord {
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

export function writeJsonObject(
	filePath: string,
	values: SettingsRecord,
): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(
		temporaryPath,
		`${JSON.stringify(values, null, "\t")}\n`,
		"utf8",
	);
	fs.renameSync(temporaryPath, filePath);
}

export function globMatches(value: string, pattern: string): boolean {
	const escaped = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "i").test(value);
}

export function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

export function nonNegativeNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: fallback;
}
