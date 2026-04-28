/**
 * Kimi For Coding usage provider
 *
 * Fetches weekly quota and 5-hour rate limit from kimi.com billing API.
 * Auth: KIMI_AUTH_TOKEN env var (JWT from kimi-auth browser cookie).
 *
 * API: POST https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages
 * Body: {"scope": ["FEATURE_CODING"]}
 * Requires browser-like headers (Cookie, Origin, Referer, User-Agent).
 */

import type { Dependencies, RateWindow, UsageSnapshot } from "../../types.js";
import { BaseProvider } from "../../provider.js";
import { noCredentials, fetchFailed, httpError } from "../../errors.js";
import { formatReset, createTimeoutController } from "../../utils.js";
import { API_TIMEOUT_MS } from "../../config.js";

function loadKimiToken(deps: Dependencies): string | undefined {
	const envToken = deps.env.KIMI_AUTH_TOKEN?.trim();
	if (envToken) return envToken;
	return undefined;
}

export class KimiProvider extends BaseProvider {
	readonly name = "kimi" as const;
	readonly displayName = "Kimi For Coding";

	hasCredentials(deps: Dependencies): boolean {
		return Boolean(loadKimiToken(deps));
	}

	async fetchUsage(deps: Dependencies): Promise<UsageSnapshot> {
		const token = loadKimiToken(deps);
		if (!token) {
			return this.emptySnapshot(noCredentials());
		}

		const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);

		try {
			const res = await deps.fetch(
				"https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
						Cookie: `kimi-auth=${token}`,
						Origin: "https://www.kimi.com",
						Referer: "https://www.kimi.com/code/console",
						"User-Agent":
							"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
						"connect-protocol-version": "1",
						"x-msh-platform": "web",
						Accept: "*/*",
					},
					body: JSON.stringify({ scope: ["FEATURE_CODING"] }),
					signal: controller.signal,
				}
			);
			clear();

			if (!res.ok) {
				return this.emptySnapshot(httpError(res.status));
			}

			const data = (await res.json()) as {
				usages?: Array<{
					scope?: string;
					detail?: {
						limit?: string;
						used?: string;
						remaining?: string;
						resetTime?: string;
					};
					limits?: Array<{
						window?: { duration?: number; timeUnit?: string };
						detail?: {
							limit?: string;
							used?: string;
							remaining?: string;
							resetTime?: string;
						};
					}>;
				}>;
			};

			const windows: RateWindow[] = [];
			const coding = data.usages?.find((u) => u.scope === "FEATURE_CODING");

			if (coding) {
				// Weekly quota
				if (coding.detail) {
					const limit = parseInt(coding.detail.limit ?? "0", 10);
					const used = parseInt(coding.detail.used ?? "0", 10);
					const usedPercent = limit > 0 ? (used / limit) * 100 : 0;
					const resetAt = coding.detail.resetTime ? new Date(coding.detail.resetTime) : undefined;

					windows.push({
						label: "Week",
						usedPercent: Math.min(100, Math.max(0, usedPercent)),
						resetDescription: resetAt ? formatReset(resetAt) : undefined,
						resetAt: resetAt?.toISOString(),
					});
				}

				// 5-hour rate limit (first limit entry)
				const rateLimit = coding.limits?.[0];
				if (rateLimit?.detail) {
					const limit = parseInt(rateLimit.detail.limit ?? "0", 10);
					const remaining = parseInt(rateLimit.detail.remaining ?? "0", 10);
					const used = limit - remaining;
					const usedPercent = limit > 0 ? (used / limit) * 100 : 0;
					const resetAt = rateLimit.detail.resetTime ? new Date(rateLimit.detail.resetTime) : undefined;

					windows.push({
						label: "5h",
						usedPercent: Math.min(100, Math.max(0, usedPercent)),
						resetDescription: resetAt ? formatReset(resetAt) : undefined,
						resetAt: resetAt?.toISOString(),
					});
				}
			}

			return this.snapshot({ windows });
		} catch {
			clear();
			return this.emptySnapshot(fetchFailed());
		}
	}
}
