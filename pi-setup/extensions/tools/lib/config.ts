/**
 * shared config reader for pi extensions.
 *
 * reads per-extension configuration from a dedicated config file,
 * keyed by extension namespace (e.g. `"finder"`, `"oracle"`).
 *
 * merge order: defaults → global config file → project-local (.pi/settings.json).
 * project-local is opt-in via `allowProjectConfig` to prevent malicious repo overrides.
 *
 * ported from @bds_pi/config by bdsqqq.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let _globalSettingsPath: string | null = null;

export function setGlobalSettingsPath(p: string): void {
	_globalSettingsPath = p;
}

const _cache = new Map<string, unknown>();

export function clearConfigCache(): void {
	_cache.clear();
}

export function resolveGlobalSettingsPath(): string {
	return (
		_globalSettingsPath ??
		process.env.PI_EXT_CONFIG_PATH ??
		path.join(os.homedir(), ".pi", "agent", "ext-config.json")
	);
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
	if (_cache.has(filePath)) {
		return _cache.get(filePath) as Record<string, unknown> | null;
	}

	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		_cache.set(filePath, parsed);
		return parsed;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`[config] failed to read ${filePath}:`, err);
		}
		_cache.set(filePath, null);
		return null;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: Record<string, unknown>): T {
	const result = { ...(base as Record<string, unknown>) };
	for (const key of Object.keys(override)) {
		const baseVal = result[key];
		const overVal = override[key];
		if (isPlainObject(baseVal) && isPlainObject(overVal)) {
			result[key] = deepMerge(baseVal, overVal);
		} else {
			result[key] = overVal;
		}
	}
	return result as T;
}

export interface GetExtensionConfigOpts {
	cwd?: string;
	allowProjectConfig?: boolean;
}

export interface ExtensionConfigSchema<T extends Record<string, unknown>> {
	validate?: (value: Record<string, unknown>) => value is T;
	normalize?: (value: T) => T;
}

export interface GetExtensionConfigWithSchemaOpts<
	T extends Record<string, unknown>,
> extends GetExtensionConfigOpts {
	schema?: ExtensionConfigSchema<T>;
}

export interface EnabledExtensionConfig<T extends Record<string, unknown>> {
	enabled: boolean;
	config: T;
}

type RawExtensionConfig = Record<string, unknown> & {
	enabled?: unknown;
};

function stripEnabledFlag(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const { enabled: _enabled, ...rest } = value as RawExtensionConfig;
	return rest;
}

function applyExtensionSchema<T extends Record<string, unknown>>(
	namespace: string,
	candidate: Record<string, unknown>,
	defaults: T,
	schema?: ExtensionConfigSchema<T>,
): T {
	if (schema?.validate && !schema.validate(candidate)) {
		console.error(
			`[config] invalid config for ${namespace}; falling back to defaults.`,
		);
		return schema.normalize ? schema.normalize(defaults) : defaults;
	}

	const config = candidate as T;
	return schema?.normalize ? schema.normalize(config) : config;
}

export function getExtensionConfig<T extends Record<string, unknown>>(
	namespace: string,
	defaults: T,
	opts?: GetExtensionConfigOpts,
): T {
	let merged = { ...defaults };

	const globalPath = resolveGlobalSettingsPath();
	const globalSettings = readJsonFile(globalPath);
	if (globalSettings && isPlainObject(globalSettings[namespace])) {
		merged = deepMerge(
			merged,
			globalSettings[namespace] as Record<string, unknown>,
		);
	}

	if (opts?.allowProjectConfig && opts.cwd) {
		const projectPath = path.join(opts.cwd, ".pi", "settings.json");
		const projectSettings = readJsonFile(projectPath);
		if (projectSettings && isPlainObject(projectSettings[namespace])) {
			merged = deepMerge(
				merged,
				projectSettings[namespace] as Record<string, unknown>,
			);
		}
	}

	return merged;
}

export function getExtensionConfigWithSchema<T extends Record<string, unknown>>(
	namespace: string,
	defaults: T,
	opts?: GetExtensionConfigWithSchemaOpts<T>,
): T {
	const merged = getExtensionConfig(namespace, defaults, opts);
	return applyExtensionSchema(namespace, merged, defaults, opts?.schema);
}

export function getEnabledExtensionConfig<T extends Record<string, unknown>>(
	namespace: string,
	defaults: T,
	opts?: GetExtensionConfigWithSchemaOpts<T>,
): EnabledExtensionConfig<T> {
	const merged = getExtensionConfig(
		namespace,
		defaults,
		opts,
	) as RawExtensionConfig;
	const enabled = typeof merged.enabled === "boolean" ? merged.enabled : true;
	const config = applyExtensionSchema(
		namespace,
		stripEnabledFlag(merged),
		defaults,
		opts?.schema,
	);

	return { enabled, config };
}

export function getGlobalConfig<T>(key: string): T | undefined {
	const globalPath = resolveGlobalSettingsPath();
	const settings = readJsonFile(globalPath);
	if (!settings || !(key in settings)) return undefined;
	return settings[key] as T;
}

export function resolveConfigDir(): string {
	return path.dirname(resolveGlobalSettingsPath());
}
