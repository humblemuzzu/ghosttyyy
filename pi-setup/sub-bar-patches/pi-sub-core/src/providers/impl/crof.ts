/**
 * CrofAI usage provider
 *
 * Fetches remaining daily requests and credit balance from crof.ai.
 * Plans: Free (PAYG), Hobby (500/day), Pro (1000/day),
 * Intermediate (2500/day), Scale (7500/day), Max (15000/day).
 */

import type { Dependencies, RateWindow, UsageSnapshot } from "../../types.js";
import { BaseProvider } from "../../provider.js";
import { noCredentials, fetchFailed, httpError } from "../../errors.js";
import { createTimeoutController } from "../../utils.js";
import { API_TIMEOUT_MS } from "../../config.js";

function loadCrofApiKey(deps: Dependencies): string | undefined {
	const envKey = deps.env.CROF_API_KEY?.trim();
	if (envKey) return envKey;
	return undefined;
}

export class CrofProvider extends BaseProvider {
	readonly name = "crof" as const;
	readonly displayName = "CrofAI";

	hasCredentials(deps: Dependencies): boolean {
		return Boolean(loadCrofApiKey(deps));
	}

	async fetchUsage(deps: Dependencies): Promise<UsageSnapshot> {
		const apiKey = loadCrofApiKey(deps);
		if (!apiKey) {
			return this.emptySnapshot(noCredentials());
		}

		const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);

		try {
			const res = await deps.fetch("https://crof.ai/usage_api/", {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
				signal: controller.signal,
			});
			clear();

			if (!res.ok) {
				return this.emptySnapshot(httpError(res.status));
			}

			const data = (await res.json()) as {
				usable_requests?: number | null;
				credits?: number;
			};

			const windows: RateWindow[] = [];

			// Daily requests window (subscription plans only)
			if (data.usable_requests != null) {
				// Infer plan limit from remaining requests
				// Plans: 500, 1000, 2500, 7500, 15000
				const remaining = data.usable_requests;
				const planLimits = [500, 1000, 2500, 7500, 15000];
				// Find the smallest plan limit >= remaining requests
				const limit = planLimits.find((l) => l >= remaining) ?? planLimits[planLimits.length - 1];
				const used = limit - remaining;
				const usedPercent = limit > 0 ? (used / limit) * 100 : 0;

				windows.push({
					label: "Day",
					usedPercent: Math.min(100, Math.max(0, usedPercent)),
					resetDescription: `${remaining} req left`,
				});
			}

			// Credits window
			if (data.credits != null && data.credits > 0) {
				windows.push({
					label: "Credits",
					usedPercent: 0, // No max to compare against
					resetDescription: `$${data.credits.toFixed(2)}`,
				});
			}

			return this.snapshot({
				windows,
				requestsRemaining: data.usable_requests ?? undefined,
			});
		} catch {
			clear();
			return this.emptySnapshot(fetchFailed());
		}
	}
}
