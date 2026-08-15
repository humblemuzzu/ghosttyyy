import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { GrokProvider } from "./grok.js";
import type { Dependencies } from "../../types.js";

type FetchResponse = {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
	text?: () => Promise<string>;
};

function jsonResponse(data: unknown, init?: { ok?: boolean; status?: number }): FetchResponse {
	return {
		ok: init?.ok ?? true,
		status: init?.status ?? 200,
		json: async () => data,
		text: async () => JSON.stringify(data),
	};
}

function createDeps(options?: {
	files?: Record<string, string>;
	fetch?: Dependencies["fetch"];
	env?: NodeJS.ProcessEnv;
	homedir?: string;
}): { deps: Dependencies; files: Map<string, string>; writes: Array<{ path: string; body: string }> } {
	const files = new Map<string, string>(Object.entries(options?.files ?? {}));
	const writes: Array<{ path: string; body: string }> = [];
	const home = options?.homedir ?? "/home/test";

	// grok.ts persists via node:fs — intercept by not using real home
	const deps: Dependencies = {
		fetch:
			options?.fetch ??
			(async () => {
				throw new Error("fetch not mocked");
			}),
		readFile: (p) => files.get(p),
		fileExists: (p) => files.has(p),
		execFileSync: () => {
			throw new Error("exec not mocked");
		},
		homedir: () => home,
		env: options?.env ?? {},
	};
	return { deps, files, writes };
}

function seedAuth(
	files: Map<string, string>,
	home: string,
	entry: Record<string, unknown>,
): void {
	const key = "https://auth.x.ai::test-client";
	files.set(
		path.join(home, ".grok", "auth.json"),
		JSON.stringify({ [key]: entry }),
	);
	files.set(path.join(home, ".grok", "version.json"), JSON.stringify({ version: "1.0.4" }));
}

test("grok hasCredentials is false without auth.json", () => {
	const provider = new GrokProvider();
	const { deps } = createDeps();
	assert.equal(provider.hasCredentials(deps), false);
});

test("grok returns noCredentials when auth missing", async () => {
	const provider = new GrokProvider();
	const { deps } = createDeps();
	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.error?.code, "NO_CREDENTIALS");
});

test("grok parses week window, build percent, and prepaid extra", async () => {
	const provider = new GrokProvider();
	const home = "/home/test";
	let seenUrl = "";
	let seenHeaders: Record<string, string> = {};

	const { deps, files } = createDeps({
		homedir: home,
		fetch: async (url, init) => {
			seenUrl = String(url);
			seenHeaders = (init as { headers?: Record<string, string> })?.headers ?? {};
			return jsonResponse({
				config: {
					creditUsagePercent: 38.4,
					currentPeriod: {
						type: "USAGE_PERIOD_TYPE_WEEKLY",
						start: "2026-08-10T07:04:00Z",
						end: "2026-08-17T07:04:00Z",
					},
					prepaidBalance: { val: 250 },
					productUsage: [{ product: "GrokBuild", usagePercent: 38 }],
				},
			});
		},
	});

	seedAuth(files, home, {
		key: "access-token",
		user_id: "user-1",
		expires_at: new Date(Date.now() + 3600_000).toISOString(),
	});

	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.error, undefined);
	assert.equal(seenUrl, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
	assert.equal(seenHeaders.Authorization, "Bearer access-token");
	assert.equal(seenHeaders["X-XAI-Token-Auth"], "xai-grok-cli");
	assert.equal(seenHeaders["x-userid"], "user-1");
	assert.equal(seenHeaders["x-grok-client-mode"], "headless");

	const week = usage.windows.find((w) => w.label === "Week");
	assert.ok(week);
	assert.equal(week?.usedPercent, 38.4);
	assert.ok(week?.resetAt?.startsWith("2026-08-17"));

	const build = usage.windows.find((w) => w.label === "Grok Build");
	assert.ok(build);
	assert.equal(build?.usedPercent, 38);

	const extra = usage.windows.find((w) => w.label.startsWith("Extra"));
	assert.ok(extra);
	assert.equal(extra?.label, "Extra $2.50");
});

test("grok falls back to legacy monthly_limit/used and billingPeriodEnd", async () => {
	const provider = new GrokProvider();
	const home = "/home/test";
	const { deps, files } = createDeps({
		homedir: home,
		fetch: async () =>
			jsonResponse({
				config: {
					monthlyLimit: { val: 1000 },
					used: { val: 250 },
					billingPeriodEnd: "2026-09-01T00:00:00Z",
				},
			}),
	});
	seedAuth(files, home, {
		key: "tok",
		user_id: "u",
		expires_at: new Date(Date.now() + 3600_000).toISOString(),
	});

	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.windows[0]?.label, "Usage");
	assert.equal(usage.windows[0]?.usedPercent, 25);
	assert.ok(usage.windows[0]?.resetAt?.startsWith("2026-09-01"));
});

test("grok reports http errors", async () => {
	const provider = new GrokProvider();
	const home = "/home/test";
	const { deps, files } = createDeps({
		homedir: home,
		fetch: async () => jsonResponse({}, { ok: false, status: 500 }),
	});
	seedAuth(files, home, {
		key: "tok",
		user_id: "u",
		expires_at: new Date(Date.now() + 3600_000).toISOString(),
	});
	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.error?.code, "HTTP_ERROR");
	assert.equal(usage.error?.httpStatus, 500);
});

test("grok refreshes expired oidc token then fetches billing", async () => {
	const provider = new GrokProvider();
	const home = "/home/test";
	const calls: string[] = [];

	const { deps, files } = createDeps({
		homedir: home,
		fetch: async (url, init) => {
			const u = String(url);
			calls.push(u);
			if (u.includes("openid-configuration")) {
				return jsonResponse({ token_endpoint: "https://auth.x.ai/oauth2/token" });
			}
			if (u.includes("/oauth2/token")) {
				const body = String((init as { body?: string })?.body ?? "");
				assert.ok(body.includes("grant_type=refresh_token"));
				assert.ok(body.includes("refresh_token=rt-old"));
				assert.ok(body.includes("client_id=client-1"));
				return jsonResponse({
					access_token: "access-new",
					refresh_token: "rt-new",
					expires_in: 3600,
				});
			}
			if (u.includes("/billing")) {
				const headers = (init as { headers?: Record<string, string> })?.headers ?? {};
				assert.equal(headers.Authorization, "Bearer access-new");
				return jsonResponse({
					config: {
						creditUsagePercent: 10,
						currentPeriod: {
							type: "USAGE_PERIOD_TYPE_WEEKLY",
							end: "2026-08-20T00:00:00Z",
						},
					},
				});
			}
			throw new Error(`unexpected url ${u}`);
		},
	});

	seedAuth(files, home, {
		key: "access-old",
		user_id: "user-1",
		refresh_token: "rt-old",
		oidc_issuer: "https://auth.x.ai",
		oidc_client_id: "client-1",
		expires_at: new Date(Date.now() - 60_000).toISOString(),
	});

	const usage = await provider.fetchUsage(deps);
	assert.equal(usage.error, undefined);
	assert.equal(usage.windows[0]?.label, "Week");
	assert.equal(usage.windows[0]?.usedPercent, 10);
	assert.ok(calls.some((c) => c.includes("openid-configuration")));
	assert.ok(calls.some((c) => c.includes("/oauth2/token")));
	assert.ok(calls.some((c) => c.includes("/billing")));
});
