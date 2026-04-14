/**
 * psst vault integration — loads secrets from the global psst vault,
 * injects them into bash subprocess env vars, scrubs them from output.
 *
 * vault resolution order:
 *   1. local vault (cwd/.psst/) — for per-project secrets
 *   2. global vault (~/.psst/) — for cross-project secrets
 *
 * tags filter which secrets are loaded. set PSST_TAGS env var or
 * use /psst-tag command. cleared = all secrets loaded.
 *
 * the agent never sees secret values — only names in the system prompt,
 * and $NAME references in bash commands that resolve at spawn time.
 *
 * scrubbing covers THREE sources (not just vault):
 *   1. psst vault secrets (user-managed, injected into bash via $NAME)
 *   2. auth.json tokens (pi's OAuth/API keys — read tool blocks the file,
 *      but bash/cat/etc could still leak them)
 *   3. env var values matching sensitive patterns (*KEY*, *TOKEN*, *SECRET*,
 *      *PASSWORD*) — these come from the shell and could be dumped via `env`
 */

import { Vault } from "psst-cli";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REDACTED_PREFIX = "[REDACTED";

export interface SecretEntry {
	name: string;
	value: string;
	tags: string[];
}

// --- vault resolution ---

/**
 * find the best vault path: local first, then global.
 * matches psst-cli's own resolution logic.
 */
function findVaultPath(): string | null {
	// local vault: <cwd>/.psst/
	const localPath = Vault.findVaultPath({ global: false });
	if (localPath) return localPath;

	// global vault: ~/.psst/
	const globalPath = Vault.findVaultPath({ global: true });
	if (globalPath) return globalPath;

	return null;
}

// --- loading ---

let cachedSecrets: SecretEntry[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds — balance between freshness and vault I/O

/** active tag filter. empty = load all secrets. */
let activeTags: string[] = [];

export function setActiveTags(tags: string[]): void {
	activeTags = tags;
	invalidateCache();
}

export function getActiveTags(): string[] {
	return [...activeTags];
}

export function invalidateCache(): void {
	cachedSecrets = null;
	cacheExpiry = 0;
}

/**
 * load vault secrets — only secrets the agent can USE (via $NAME in bash).
 * used for: bash env injection, system prompt (names only).
 */
export async function loadSecrets(): Promise<SecretEntry[]> {
	const now = Date.now();
	if (cachedSecrets && now < cacheExpiry) return cachedSecrets;

	const vaultPath = findVaultPath();
	if (!vaultPath) return [];

	try {
		const vault = new Vault(vaultPath);
		const unlocked = await vault.unlock();
		if (!unlocked) {
			vault.close();
			return [];
		}

		const filterTags = activeTags.length > 0 ? activeTags : undefined;
		const list = vault.listSecrets(filterTags);
		const secrets: SecretEntry[] = [];

		for (const entry of list) {
			const value = await vault.getSecret(entry.name);
			if (value) {
				secrets.push({
					name: entry.name,
					value,
					tags: entry.tags ?? [],
				});
			}
		}

		vault.close();
		cachedSecrets = secrets;
		cacheExpiry = now + CACHE_TTL_MS;
		return secrets;
	} catch {
		return [];
	}
}

// --- comprehensive scrubbing values ---

/**
 * load ALL sensitive string values for output scrubbing.
 * covers vault secrets + auth.json tokens + sensitive env vars.
 * names are NOT included — only values to redact.
 */
export async function loadAllScrubValues(): Promise<string[]> {
	const values: string[] = [];

	// 1. vault secrets
	const vaultSecrets = await loadSecrets();
	for (const s of vaultSecrets) {
		if (s.value.length >= 4) values.push(s.value);
	}

	// 2. auth.json tokens
	try {
		const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
		if (fs.existsSync(authPath)) {
			const raw = fs.readFileSync(authPath, "utf-8");
			const auth = JSON.parse(raw);
			for (const provider of Object.values(auth) as any[]) {
				for (const field of ["key", "refresh", "access"] as const) {
					const val = provider[field];
					if (typeof val === "string" && val.length >= 8) {
						values.push(val);
					}
				}
			}
		}
	} catch { /* ignore */ }

	// 3. sensitive env vars
	const sensitiveEnvPatterns = [
		/KEY$/i, /API_KEY$/i, /_TOKEN$/i, /_SECRET$/i, /PASSWORD$/i,
	];
	const env = process.env;
	for (const [key, val] of Object.entries(env)) {
		if (typeof val !== "string" || val.length < 8) continue;
		if (sensitiveEnvPatterns.some((p) => p.test(key))) {
			values.push(val);
		}
	}

	return values;
}

// --- scrubbing ---

/**
 * replace secret values in text with named redaction marker.
 * sorts by value length (longest first) to prevent partial replacement.
 * skips secrets shorter than 4 chars — too likely to cause false positives.
 */
export function scrubOutput(text: string, secrets: SecretEntry[]): string {
	if (secrets.length === 0) return text;

	let result = text;
	const sorted = [...secrets].sort((a, b) => b.value.length - a.value.length);

	for (const secret of sorted) {
		if (secret.value.length < 4) continue;
		result = result.replaceAll(secret.value, `${REDACTED_PREFIX}:${secret.name}]`);
	}
	return result;
}

/**
 * scrub raw string values from text (anonymous redaction).
 * used for auth.json tokens and env var keys where we don't want to
 * reveal which provider/env var was redacted.
 */
export function scrubValues(text: string, values: string[]): string {
	if (values.length === 0) return text;

	let result = text;
	const sorted = [...values].sort((a, b) => b.length - a.length);

	for (const val of sorted) {
		result = result.replaceAll(val, `${REDACTED_PREFIX}]`);
	}
	return result;
}

/**
 * comprehensive scrub: vault secrets (named) + all other sensitive values.
 * this is what the tool_result hook calls.
 */
export async function scrubAll(text: string): Promise<string> {
	let result = text;

	// vault secrets — named redaction so agent knows which $NAME was involved
	const vaultSecrets = await loadSecrets();
	result = scrubOutput(result, vaultSecrets);

	// auth.json + env vars — anonymous redaction
	const allValues = await loadAllScrubValues();
	// only scrub values NOT already handled by vault secrets (avoid double-processing)
	const vaultValues = new Set(vaultSecrets.map((s) => s.value));
	const extraValues = allValues.filter((v) => !vaultValues.has(v));
	result = scrubValues(result, extraValues);

	return result;
}
