import * as fs from "node:fs";
import * as path from "node:path";
import type { Dependencies, RateWindow, UsageSnapshot } from "../../types.js";
import { BaseProvider } from "../../provider.js";
import { noCredentials, fetchFailed, httpError } from "../../errors.js";
import { formatReset, createTimeoutController } from "../../utils.js";
import { API_TIMEOUT_MS } from "../../config.js";

const DEFAULT_PROXY = "https://cli-chat-proxy.grok.com/v1";
const TOKEN_AUTH = "xai-grok-cli";
const REFRESH_MARGIN_MS = 60_000;
const LOCK_WAIT_MS = 3_000;
const DEFAULT_CLIENT_VERSION = "1.0.4";

type GrokAuthEntry = {
	key?: string;
	user_id?: string;
	refresh_token?: string;
	expires_at?: string;
	oidc_issuer?: string;
	oidc_client_id?: string;
	principal_type?: string;
	principal_id?: string;
	[key: string]: unknown;
};

type GrokAuthFile = Record<string, GrokAuthEntry>;

type LoadedAuth = {
	filePath: string;
	lockPath: string;
	data: GrokAuthFile;
	entryKey: string;
	entry: GrokAuthEntry;
};

type Cent = { val?: number };
type UsagePeriod = { type?: string; start?: string; end?: string };
type ProductUsage = { product?: string; usagePercent?: number };

type BillingConfig = {
	creditUsagePercent?: number;
	currentPeriod?: UsagePeriod;
	monthlyLimit?: Cent;
	used?: Cent;
	prepaidBalance?: Cent;
	billingPeriodEnd?: string;
	productUsage?: ProductUsage[];
};

type BillingResponse = {
	config?: BillingConfig | null;
};

function grokDir(deps: Dependencies): string {
	return path.join(deps.homedir(), ".grok");
}

function authPaths(deps: Dependencies): { filePath: string; lockPath: string } {
	const dir = grokDir(deps);
	return {
		filePath: path.join(dir, "auth.json"),
		lockPath: path.join(dir, "auth.json.lock"),
	};
}

function clientVersion(deps: Dependencies): string {
	const versionPath = path.join(grokDir(deps), "version.json");
	try {
		if (deps.fileExists(versionPath)) {
			const raw = JSON.parse(deps.readFile(versionPath) ?? "{}");
			const v = raw.version ?? raw.stable_version;
			if (typeof v === "string" && v.trim()) return v.trim();
		}
	} catch {
		// fall through
	}
	return DEFAULT_CLIENT_VERSION;
}

function proxyBase(deps: Dependencies): string {
	const fromEnv = deps.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim();
	return (fromEnv || DEFAULT_PROXY).replace(/\/+$/, "");
}

function parseAuthFile(raw: string | undefined): GrokAuthFile | undefined {
	if (!raw) return undefined;
	try {
		const data = JSON.parse(raw);
		if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
		return data as GrokAuthFile;
	} catch {
		return undefined;
	}
}

function pickEntry(data: GrokAuthFile): { entryKey: string; entry: GrokAuthEntry } | undefined {
	for (const [entryKey, entry] of Object.entries(data)) {
		if (entry && typeof entry === "object" && typeof entry.key === "string" && entry.key.length > 0) {
			return { entryKey, entry };
		}
	}
	return undefined;
}

function loadAuth(deps: Dependencies): LoadedAuth | undefined {
	const { filePath, lockPath } = authPaths(deps);
	if (!deps.fileExists(filePath)) return undefined;
	const data = parseAuthFile(deps.readFile(filePath));
	if (!data) return undefined;
	const picked = pickEntry(data);
	if (!picked) return undefined;
	return { filePath, lockPath, data, entryKey: picked.entryKey, entry: picked.entry };
}

function isFresh(entry: GrokAuthEntry, now = Date.now()): boolean {
	if (!entry.key) return false;
	if (!entry.expires_at) return true;
	const exp = Date.parse(entry.expires_at);
	if (Number.isNaN(exp)) return true;
	return exp - REFRESH_MARGIN_MS > now;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withAuthLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	try {
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	} catch {
		// no writable dir → no lock; still run the critical section
		return fn();
	}
	const start = Date.now();
	while (Date.now() - start < LOCK_WAIT_MS) {
		try {
			fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
			try {
				return await fn();
			} finally {
				try {
					fs.unlinkSync(lockPath);
				} catch {
					// ignore
				}
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			// EEXIST = another holder; anything else is unrecoverable for locking
			if (code !== "EEXIST") return fn();
			await sleep(50);
		}
	}
	return fn();
}

function persistAuth(filePath: string, data: GrokAuthFile): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	fs.renameSync(tmp, filePath);
}

async function discoverTokenEndpoint(
	deps: Dependencies,
	issuer: string,
): Promise<string | undefined> {
	const base = issuer.replace(/\/+$/, "");
	const url = `${base}/.well-known/openid-configuration`;
	const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
	try {
		const res = await deps.fetch(url, { signal: controller.signal });
		clear();
		if (!res.ok) return undefined;
		const doc = (await res.json()) as { token_endpoint?: string };
		return typeof doc.token_endpoint === "string" ? doc.token_endpoint : undefined;
	} catch {
		clear();
		return undefined;
	}
}

async function refreshOidc(
	deps: Dependencies,
	entry: GrokAuthEntry,
): Promise<GrokAuthEntry | undefined> {
	const refreshToken = entry.refresh_token?.trim();
	const issuer = entry.oidc_issuer?.trim();
	const clientId = entry.oidc_client_id?.trim();
	if (!refreshToken || !issuer || !clientId) return undefined;

	const tokenEndpoint = await discoverTokenEndpoint(deps, issuer);
	if (!tokenEndpoint) return undefined;

	const body = new URLSearchParams();
	body.set("grant_type", "refresh_token");
	body.set("refresh_token", refreshToken);
	body.set("client_id", clientId);
	if (entry.principal_type) body.set("principal_type", entry.principal_type);
	if (entry.principal_id) body.set("principal_id", entry.principal_id);

	const { controller, clear } = createTimeoutController(15_000);
	try {
		const res = await deps.fetch(tokenEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
			signal: controller.signal,
		});
		clear();
		if (!res.ok) return undefined;
		const tokens = (await res.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (!tokens.access_token) return undefined;
		const next: GrokAuthEntry = { ...entry, key: tokens.access_token };
		if (tokens.refresh_token) next.refresh_token = tokens.refresh_token;
		if (typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)) {
			next.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
		}
		return next;
	} catch {
		clear();
		return undefined;
	}
}

async function ensureFreshAuth(deps: Dependencies): Promise<LoadedAuth | undefined> {
	const initial = loadAuth(deps);
	if (!initial) return undefined;
	if (isFresh(initial.entry)) return initial;

	return withAuthLock(initial.lockPath, async () => {
		// re-read under lock — grok-cli or another pi may have refreshed
		const latest = loadAuth(deps);
		if (!latest) return undefined;
		if (isFresh(latest.entry)) return latest;

		const refreshed = await refreshOidc(deps, latest.entry);
		if (!refreshed?.key) return latest;

		latest.data[latest.entryKey] = refreshed;
		latest.entry = refreshed;
		try {
			persistAuth(latest.filePath, latest.data);
		} catch {
			// in-memory token still usable for this call
		}
		return latest;
	});
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

function periodLabel(periodType: string | undefined): string {
	const t = (periodType ?? "").toUpperCase();
	if (t.includes("WEEKLY")) return "Week";
	if (t.includes("MONTHLY")) return "Month";
	return "Usage";
}

function usagePercent(config: BillingConfig): number | undefined {
	if (typeof config.creditUsagePercent === "number") {
		return clampPercent(config.creditUsagePercent);
	}
	const limit = config.monthlyLimit?.val;
	const used = config.used?.val;
	if (typeof limit === "number" && limit > 0 && typeof used === "number") {
		return clampPercent((used / limit) * 100);
	}
	return undefined;
}

function resetDate(config: BillingConfig): Date | undefined {
	const end = config.currentPeriod?.end ?? config.billingPeriodEnd;
	if (!end) return undefined;
	const d = new Date(end);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

function windowsFromBilling(config: BillingConfig): RateWindow[] {
	const windows: RateWindow[] = [];
	const pct = usagePercent(config);
	if (pct !== undefined) {
		const resetAt = resetDate(config);
		windows.push({
			label: periodLabel(config.currentPeriod?.type),
			usedPercent: pct,
			resetDescription: resetAt ? formatReset(resetAt) : undefined,
			resetAt: resetAt?.toISOString(),
		});
	}

	for (const product of config.productUsage ?? []) {
		// wire has used both "GrokBuild" (live) and "PRODUCT_GROK_BUILD" (proto fixture)
		const name = (product.product ?? "").replace(/_/g, "").toLowerCase();
		if (name !== "grokbuild" && name !== "productgrokbuild") continue;
		if (typeof product.usagePercent !== "number") continue;
		windows.push({
			label: "Grok Build",
			usedPercent: clampPercent(product.usagePercent),
		});
	}

	const prepaid = config.prepaidBalance?.val;
	if (typeof prepaid === "number" && Math.abs(prepaid) > 0) {
		const dollars = (Math.abs(prepaid) / 100).toFixed(2);
		windows.push({
			label: `Extra $${dollars}`,
			usedPercent: 0,
		});
	}

	return windows;
}

async function fetchBilling(
	deps: Dependencies,
	auth: LoadedAuth,
): Promise<{ ok: true; config: BillingConfig | null } | { ok: false; status?: number }> {
	const url = `${proxyBase(deps)}/billing?format=credits`;
	const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
	try {
		const res = await deps.fetch(url, {
			headers: {
				Authorization: `Bearer ${auth.entry.key}`,
				"X-XAI-Token-Auth": TOKEN_AUTH,
				"x-userid": auth.entry.user_id ?? "",
				"x-grok-client-version": clientVersion(deps),
				"x-grok-client-mode": "headless",
			},
			signal: controller.signal,
		});
		clear();
		if (!res.ok) return { ok: false, status: res.status };
		const data = (await res.json()) as BillingResponse;
		return { ok: true, config: data.config ?? null };
	} catch {
		clear();
		return { ok: false };
	}
}

export class GrokProvider extends BaseProvider {
	readonly name = "grok" as const;
	readonly displayName = "Grok";

	hasCredentials(deps: Dependencies): boolean {
		return Boolean(loadAuth(deps));
	}

	async fetchUsage(deps: Dependencies): Promise<UsageSnapshot> {
		let auth = await ensureFreshAuth(deps);
		if (!auth?.entry.key) {
			return this.emptySnapshot(noCredentials());
		}

		let result = await fetchBilling(deps, auth);

		if (!result.ok && result.status === 401) {
			auth = await withAuthLock(auth.lockPath, async () => {
				const latest = loadAuth(deps);
				if (!latest) return undefined;
				const refreshed = await refreshOidc(deps, latest.entry);
				if (!refreshed?.key) return latest;
				latest.data[latest.entryKey] = refreshed;
				latest.entry = refreshed;
				try {
					persistAuth(latest.filePath, latest.data);
				} catch {
					// keep in-memory
				}
				return latest;
			});
			if (!auth?.entry.key) {
				return this.emptySnapshot(noCredentials());
			}
			result = await fetchBilling(deps, auth);
		}

		if (!result.ok) {
			if (result.status !== undefined) return this.emptySnapshot(httpError(result.status));
			return this.emptySnapshot(fetchFailed());
		}

		if (!result.config) {
			return this.snapshot({ windows: [] });
		}

		return this.snapshot({ windows: windowsFromBilling(result.config) });
	}
}
