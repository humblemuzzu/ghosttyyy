---
name: dataforseo
description: "DataForSEO API v3 — keyword research, competitor/domain analysis, rank tracking, backlinks, technical SEO, AI search visibility (AEO/GEO), brand monitoring, trends. Use when a task needs real SEO data: search volume, keyword difficulty, SERP positions, backlink profiles, competitor keywords, site audits, or whether a brand appears in AI answers. PAID API on a prepaid balance — ALWAYS estimate the cost and get the user's explicit confirmation before any run over ~$1, any loop/pagination, any OnPage crawl, or any llm_responses call; see section 0. Contains verified per-endpoint pricing, batch limits, the filter DSL, and the DB-vs-live cost rules. Triggers on: seo data, keyword research, search volume, keyword difficulty, serp, rank tracking, backlinks, competitor keywords, site audit, ai overview, aeo, geo, brand mentions, dataforseo."
---

# DataForSEO API v3

Verified against the docs + live pricing API on 2026-08-04. Prices are USD and real —
they are **not** in the docs (docs only say "see Pricing page"); they came from
`dataforseo.com/wp-json/wp/v2/pricing`. Re-check before quoting to a client.

---

## 0. STOP — spending rule (read before any call)

**This is a paid API billed against a prepaid balance. Never start an expensive or
open-ended run without showing the user the estimate and getting an explicit yes.**

### Always ask first

| Trigger | Why |
|---|---|
| Estimated total **> $1** | real money, and estimates are easy to get wrong by 10x |
| **Any loop or pagination** over an unknown count | `ranked_keywords` on a big domain is 50+ paid calls; `total_count` is not known until the first call returns |
| **`on_page/task_post`** | billed **per crawled page**. `max_crawl_pages: 10000` = $1.50 basic, **$51** with browser rendering |
| **`llm_responses`** (ChatGPT/Claude/Gemini/Perplexity) | cost is base + **provider token pass-through** — genuinely unpredictable, and reasoning models can exceed `max_output_tokens` |
| **SERP with `depth` > 10 or any `max_crawl_pages`** | multiplies per 10 results / per page |
| **A keyword containing a search operator** (`site:` `inurl:` `intitle:` ...) | **x5 per operator**, silently |
| **Google Ads / Bing Ads endpoints** | $0.06-$0.09 **per task** — 100x a Labs row, and capped at 12 req/min |
| More than ~20 calls in one go | the flat task fee stacks |
| Anything running unattended / on a schedule | it repeats forever |

### Run without asking (bounded and trivial)

- Any **$0** endpoint from the free list in §3.
- **One** Labs call with an explicit `limit` <= 1000 — worst case **$0.132**.
- **One** Backlinks or Content Analysis call — worst case **$0.06**.
- Anything on **`sandbox.dataforseo.com`** — always free, always fine.
- A handful of SERP Standard priority-1 fetches — $0.0006 each.

### Pre-flight procedure

1. **Estimate before calling.** State the arithmetic out loud:
   `lookup: 0.012 + 0.00012 x N_keywords` · `discovery: 0.012 + 0.00012 x limit` ·
   `backlinks: 0.024 + 0.000036 x rows` · `SERP std: 0.0006 x keywords x pages` ·
   `OnPage: 0.00015 x pages x multiplier`
2. **Check the balance first** (free):
   `curl -s -u "$DATAFORSEO_USERNAME:$DATAFORSEO_PASSWORD" https://api.dataforseo.com/v3/appendix/user_data`
3. **Present it like this, then wait:**
   > "This is ~1,400 keywords = 2 batched calls = **~$0.19**. Balance $49.96. Proceed?"
4. **Prototype in Sandbox** when the shape of the request is uncertain.
5. **Run one call first** on anything paginated, read `total_count`, re-estimate, then ask
   again before pulling the rest.
6. **Sum `cost` from every response** as you go. If actual exceeds the estimate by more
   than 2x, **stop and report** instead of continuing.

### Never

- Never loop a lookup endpoint one keyword at a time. Batch it — that alone is 92x
  (§3). If you catch yourself writing a loop over keywords, you are doing it wrong.
- Never set `limit: 1000` "to be safe" on a discovery endpoint. You pay for every row.
- Never enable `include_clickstream_data`, `enable_browser_rendering`, `enable_javascript`,
  or `priority: 2` without saying what it costs and why it is needed.
- Never leave a scheduled/unattended job running without an account cost limit set (§3a).

---

## 1. Universal mechanics

Every call in the API has the same shape. Learn once, applies to all ~600 endpoints.

```
POST https://api.dataforseo.com/v3/{cluster}/{engine}/{feature}/{method}[/{function}]
Authorization: Basic base64("login:api_password")
Content-Type: application/json

[ { task1 }, { task2 } ]      <- body is ALWAYS an array, even for one task
```

- Basic auth only. No OAuth, no token exchange, credentials **cannot** go in the URL.
- The API password is auto-generated at `app.dataforseo.com/api-access` and is **not**
  your account password.
- `GET` is used only for `task_get/$id` and free metadata endpoints.

### Credentials — this machine

They live in `~/.zshrc` and are already exported into the shell:

```bash
DATAFORSEO_USERNAME    # the API login (an email address)
DATAFORSEO_PASSWORD    # the auto-generated API password, NOT the account password
```

**Never paste the values into a file, a URL, or a commit.** Reference the variables.

```bash
# curl — -u does the base64 for you
curl -s -u "$DATAFORSEO_USERNAME:$DATAFORSEO_PASSWORD" \
  -H 'Content-Type: application/json' \
  -d '[{"keyword":"seo tools","location_code":2840,"language_code":"en"}]' \
  https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live
```

```python
import os, requests
AUTH = (os.environ["DATAFORSEO_USERNAME"], os.environ["DATAFORSEO_PASSWORD"])
r = requests.post(
    "https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live",
    auth=AUTH,                                  # requests builds the Basic header
    json=[{"keywords": ["seo tools"], "location_code": 2840, "language_code": "en"}],
)
d = r.json()
assert d["status_code"] == 20000, d["status_message"]
print("spent:", d["cost"])
```

```javascript
const auth = "Basic " + Buffer.from(
  `${process.env.DATAFORSEO_USERNAME}:${process.env.DATAFORSEO_PASSWORD}`
).toString("base64");

const res = await fetch("https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live", {
  method: "POST",
  headers: { Authorization: auth, "Content-Type": "application/json" },
  body: JSON.stringify([{ keywords: ["seo tools"], location_code: 2840, language_code: "en" }]),
});
```

### Verify auth + check balance (free, costs $0)

Run this before any batch. It is the only endpoint that reports your money.

```bash
curl -s -u "$DATAFORSEO_USERNAME:$DATAFORSEO_PASSWORD" \
  https://api.dataforseo.com/v3/appendix/user_data |
  python3 -c 'import json,sys; d=json.load(sys.stdin); r=d["tasks"][0]["result"][0]; \
print("status:", d["status_code"], "| balance: $"+str(r["money"]["balance"]))'
```

`status: 20000` means the credentials are good. `40100` means they are not.

If the variables are empty in a non-interactive context, `source ~/.zshrc` first.
Sandbox uses the **same** credentials — only the host changes.

### Response envelope (identical everywhere)

```jsonc
{
  "version": "0.1.20260101",
  "status_code": 20000,          // 20000 = ok, 20100 = task created
  "status_message": "Ok.",
  "time": "0.2341 sec.",
  "cost": 0.012,                 // <- USD actually charged. Your live spend meter.
  "tasks_count": 1,
  "tasks_error": 0,
  "tasks": [{
    "id": "08041234-...",
    "status_code": 20000,
    "cost": 0.012,
    "result_count": 1,
    "data": { /* echo of your request, includes your `tag` */ },
    "result": [ /* payload */ ]
  }]
}
```

**Always read `cost` off the response.** Never estimate spend — the API reports it per
request and per task. Sum it. Check `tasks_error` before parsing `result`.

### Status codes that matter

| Code | Meaning | What to do |
|---|---|---|
| `20000` | ok | proceed |
| `20100` | task created | Standard mode — poll or await postback |
| `40006` | >100 tasks in one POST | split; overflow tasks are rejected |
| `40100` | not authorized | bad credentials |
| `40200` / `40210` | payment required / insufficient funds | stop, alert |
| `40202` | rate limit/min exceeded | back off |
| `40203` | **cost limit exceeded** | your own guard fired — see §3 |
| `40205` / `40206` | duplicate task limit per hour / day | you are re-requesting identical tasks |
| `40207` | IP not whitelisted | check `app.dataforseo.com/api-access` |
| `40209` | too many simultaneous queries | reduce concurrency |
| `40401` | task not found | wrong id |
| `40403` | **results expired** | Standard results live 30 days only |
| `40501`-`40506` | invalid/unknown field in POST data | schema error |
| `40601` / `40602` | task handed / task in queue | **not errors** — just not ready |
| `50000`+ | internal / 3rd-party error | retry with backoff |

### Rate limits

| Scope | Limit |
|---|---|
| Global | **2000 API calls/min** (POST + GET combined) |
| Standard method | **100 tasks per POST** |
| Live method | **1 task per POST** |
| DataForSEO Labs | 2000/min, **max 30 simultaneous** |
| OnPage | **max 30 simultaneous** |
| **Google Ads endpoints** | **12 requests/min** — upstream Google cap, 166x slower than everything else |
| Google Trends Live | 250 req/min, **500K/day shared across ALL DataForSEO customers** |

### Sandbox — build against this first

Swap the host: `api.dataforseo.com` -> `sandbox.dataforseo.com`. Same paths, same payloads,
**free and unlimited**, identical response structure with dummy data. Supports
postback/pingback.

One magic UUID returns *every possible SERP item type* — how to write a parser for free:

```
https://sandbox.dataforseo.com/v3/serp/google/organic/task_get/advanced/00000000-0000-0000-0000-000000000000
```

### Free endpoints (cost = 0, call freely)

`locations`, `languages`, `locations_and_languages`, `categories`, `categories_list`,
`status`, `errors`, `id_list`, `available_filters`, `.../llm_responses/models`,
`backlinks/index`, `labs/available_history`, `serp/endpoints`, `keywords_data/endpoints`,
and everything under Sandbox.

---

## 2. The one concept that controls the bill

Two engines live under one API. Picking the wrong one costs 10-100x.

| | **LIVE (scrape now)** | **DB (their index)** |
|---|---|---|
| What happens | a bot loads the page in real time | query of a precomputed database |
| Methods | Live **and** Standard (task queue, priority 1/2) | **Live only** — no task queue exists |
| Cost | $0.0006 - $0.004 per SERP | $0.00012 per row |
| Freshness | this second | snapshot / continuous crawl |
| Filters | mostly none | **yes, and free** |
| Clusters | SERP, OnPage, llm_responses, llm_scraper | **Labs**, Backlinks, Content Analysis, llm_mentions |

**Use LIVE only when you need *this moment's* truth** — tracking a keyword today,
verifying a page shipped, screenshotting a SERP. Everything exploratory — research,
discovery, competitor analysis, bulk scoring — is a DB query.

The trap: SERP API looks like the obvious entry point, so people build keyword research
on it and pay ~100x for worse data.

| Question | Wrong (LIVE) | Right (DB) |
|---|---|---|
| every keyword a domain ranks for | ~50,000 SERP calls = **$30+** | `labs/ranked_keywords` = **$0.012 + $0.00012/row** |
| difficulty for 1,000 keywords | 1,000 SERP calls = **$0.60** | `labs/bulk_keyword_difficulty` = **$0.132**, 1 call |
| traffic for 1,000 domains | not possible | `labs/bulk_traffic_estimation` = **$0.132**, 1 call |
| the SERP on a past date | impossible | `labs/historical_serps` = **$0.00012/SERP** |
| backlinks | impossible to scrape | Backlinks API only |

---

## 3. What is actually free, and how DB billing really works

**DB endpoints are not free. They are cheap.** Do not confuse the two.

### Literally $0 (verified live — every one returned `cost: 0`)

| Endpoint | Returns |
|---|---|
| `appendix/user_data` | balance, rates, limits |
| `dataforseo_labs/status` | when the Labs DB was last updated |
| `dataforseo_labs/locations_and_languages` | 94 supported combos |
| `dataforseo_labs/categories_list` | Google category codes |
| `dataforseo_labs/available_history` | valid historical dates |
| `serp/google/locations` + `/languages` | 129 languages, all locations |
| `backlinks/index` | global index size + freshness |
| `*/available_filters` | filterable fields per endpoint |
| `*/llm_responses/models` | current model names |
| `serp/endpoints`, `keywords_data/endpoints` | machine-readable endpoint lists |
| `task_get/$id` | Standard results — **you paid at `task_post`** |
| `on_page/{pages,links,redirect_chains,...}` | crawl getters — **you paid at `task_post`** |
| **everything on `sandbox.dataforseo.com`** | dummy data, identical schema |

**Filtering and sorting are also free.** Verified: `keyword_suggestions` with `limit: 10`
costs `$0.0132` with no filters and `$0.0132` with two filters plus an `order_by`.
Identical. Filter server-side always — it is free and it *reduces* the row charge.

### The billing formula (verified to 5 decimals)

```
cost = $0.012 (task fee)  +  $0.00012 x items
```

| Call | Predicted | **Observed** |
|---|---|---|
| `keyword_overview`, 1 keyword | $0.01212 | **$0.01212** |
| `keyword_overview`, 10 keywords | $0.01320 | **$0.01320** |
| `keyword_overview`, 100 keywords | $0.02400 | **$0.02400** |
| `keyword_suggestions`, `limit: 10` | $0.01320 | **$0.01320** |
| `keyword_suggestions`, `limit: 1000` | $0.13200 | **$0.13200** |

### "item" means different things — this is the part that costs people money

| Endpoint type | `item` = | Your cost dial |
|---|---|---|
| **Lookup** — `keyword_overview`, `bulk_keyword_difficulty`, `search_intent`, `historical_keyword_data`, `bulk_traffic_estimation` | **keywords/targets you SUBMIT** | batch size — bigger is cheaper per unit |
| **Discovery** — `keyword_suggestions`, `keyword_ideas`, `related_keywords`, `keywords_for_site`, `top_searches`, `ranked_keywords` | **rows RETURNED** | **`limit`** — ask only for what you need |

On discovery endpoints `limit` is a direct spend control. `limit: 1000` when you needed 50
costs **10x** more for data you throw away. Default `limit` is 100; set it deliberately.

### Why the task fee makes batching everything

The flat $0.012 dominates small calls and vanishes on large ones:

| Keywords per call | Total | **Per keyword** |
|---|---|---|
| 1 | $0.01212 | $0.01212 |
| 10 | $0.01320 | $0.00132 (9x cheaper) |
| 100 | $0.02400 | $0.00024 (50x cheaper) |
| 700 (max) | $0.09600 | $0.00014 (**88x cheaper**) |

**1,000 keywords looked up one at a time = $12.12. The same 1,000 batched = $0.132.**
A 92x difference for identical data. Never loop a lookup endpoint — fill the batch.

---

## 3a. Spend guards — set these before running anything at scale

1. **Account cost limit** at `app.dataforseo.com/api-settings`. Exceeding it returns
   `40203` instead of a surprise invoice. Set it.
2. **Duplicate-task limits** (hour / day) in the same panel. Catches runaway loops.
   Surfaces as `40205` / `40206`.
3. **`GET /v3/appendix/user_data`** — balance, rates, limits. Poll before and after a big
   run. Authoritative, and free.
4. **Sum `cost` from every response.** If the running total diverges from your model, stop.
5. **Develop against Sandbox.** Zero cost, identical schema.

---

## 4. Which endpoint answers which question

```
KEYWORDS
  discover new keywords ........... labs/keyword_suggestions (text contains seed)
                                    labs/keyword_ideas       (same category, no text match)
                                    labs/related_keywords    ("searches related to" graph)
                                    labs/keywords_for_site   (a domain's keyword profile)
  score a known list .............. labs/keyword_overview         (SV+KD+CPC+intent, 1 call)
                                    labs/bulk_keyword_difficulty  (KD only, 1000/req)
                                    labs/search_intent            (intent only, 1000/req)
  official Google volume .......... keywords_data/google_ads/search_volume
  de-bucketed volume .............. clickstream_data/dataforseo_search_volume
  per-country volume .............. clickstream_data/global_search_volume

COMPETITORS
  what do they rank for ........... labs/ranked_keywords
  who competes with me ............ labs/competitors_domain   (start: domain)
  who ranks for these keywords .... labs/serp_competitors     (start: keywords)
  keyword gap ..................... labs/domain_intersection  (intersections:false)
  page-level gap .................. labs/page_intersection
  their best pages ................ labs/relevant_pages
  traffic for many domains ........ labs/bulk_traffic_estimation
  historic SERP ................... labs/historical_serps

RANK TRACKING
  daily positions ................. serp/google/organic/task_post (Standard, priority 1)
  need it now ..................... serp/google/organic/live/advanced
  Google AI Mode .................. serp/google/ai_mode/task_post

BACKLINKS
  profile overview ................ backlinks/summary
  the actual links ................ backlinks/backlinks
  link gap ........................ backlinks/domain_intersection
  many domains at once ............ backlinks/bulk_*  (1000 targets)

TECHNICAL
  full site audit ................. on_page/task_post -> getters
  one page, now ................... on_page/instant_pages

AI SEARCH (AEO/GEO)
  am I cited in AI answers ........ ai_optimization/llm_mentions/*
  what does ChatGPT say ........... ai_optimization/chat_gpt/llm_responses (API)
  what does a real user see ....... ai_optimization/chat_gpt/llm_scraper   (web UI)
```

---

## 5. Keyword research — 20 endpoints

All `dataforseo_labs/*` below: **$0.012 per task + $0.00012 per item**. DB, Live-only,
no task queue. Verified live to 5 decimal places — see §3 for what "item" means, because
it differs by endpoint type and it is the whole cost game.

### Discovery — four *different algorithms*, not variants

| Endpoint | Algorithm | Input | Max batch |
|---|---|---|---|
| `labs/google/keyword_suggestions/live` | full-text: keywords **containing** the seed | 1 keyword | ≤1000 rows |
| `labs/google/keyword_ideas/live` | same **product category** as seeds, no text match | **200** keywords | ≤1000 rows |
| `labs/google/related_keywords/live` | traverses Google's "searches related to" **graph** | 1 keyword | depth-bound |
| `labs/google/keywords_for_site/live` | keywords a **domain** is relevant for | 1 domain | ≤1000 rows |
| `labs/google/keywords_for_categories/live` | everything in a Google category | **20** category codes | ≤1000 rows |
| `labs/google/categories_for_keywords/live` | classify keywords -> category IDs | **1000** keywords | — |
| `labs/google/top_searches/live` | browse/dump the keyword DB for a locale | filters only | ≤1000/page |

- `keyword_suggestions` on "project management software" -> *"best project management
  software for small business"*. Text-bound.
- `keyword_ideas` on the same seed -> *"kanban board app"*, *"gantt chart maker"*.
  Category-bound. **The one people forget, and usually the best.**
- `related_keywords` `depth` is exponential and cost scales with it:
  `0`->1, `1`->≤8, `2`->≤72, `3`->≤584, `4`->≤4680. Do not default to 4.

### Scoring

| Endpoint | Max batch | Returns |
|---|---|---|
| `labs/google/keyword_overview/live` | **700** kw | SV + CPC + competition + KD + intent + SERP info + backlink data. **One call replaces four.** |
| `labs/google/bulk_keyword_difficulty/live` | **1000** kw | KD only — cheaper when that is all you need |
| `labs/google/search_intent/live` | **1000** kw | intent + probability. `language_code` only, **no location** |
| `labs/google/historical_keyword_data/live` | **700** kw | monthly SV/CPC/competition back to **2021-08** |
| `serp/google/autocomplete/live/advanced` | 1 kw | LIVE Google autocomplete — $0.002 Live / $0.0006 Standard |

### Search volume — five sources, pick deliberately

| Source | Endpoint | Real source | Price | Batch | Rate |
|---|---|---|---|---|---|
| **Google Ads** (official) | `keywords_data/google_ads/search_volume/live` | Google Ads API | **$0.09**/task Live, **$0.06** Standard (flat 1-1000 kw) | 1000 | **12/min** |
| **Labs cache** | `labs/google/keyword_overview/live` | same Google data, cached | $0.012 + $0.00012/kw | 700 | 2000/min |
| **DFS hybrid** | `clickstream_data/dataforseo_search_volume/live` | Google Ads normalised w/ Bing or clickstream | **$0.18**/task ($180/1M) | 1000 | 12/min |
| **Global clickstream** | `clickstream_data/global_search_volume/live` | pure clickstream, worldwide | **$0.18**/task ($180/1M) | 1000 | 2000/min |
| **Bulk clickstream** | `clickstream_data/bulk_search_volume/live` | pure clickstream, per location | $0.012 + $0.00012/kw (**$132/1M**) | 1000 | 2000/min |

Decision rules:

- **Client reporting / "the official number"** -> Google Ads, or Labs `keyword_overview`
  (identical underlying data, 166x faster rate limit, KD + intent thrown in free).
  There is **no accuracy gain** from hitting Google Ads directly for volume alone.
- **Need continuous, de-bucketed volume** -> `dataforseo_search_volume`. Google buckets
  volume and hands *the same number to groups of similar keywords*; clickstream separates
  them.
- **International / per-country split** -> `global_search_volume`. The only source that
  returns `country_distribution` without one request per country.
- **Keyword blocked by Google ad policy** -> any clickstream endpoint. No policy filter.
- **Cheapest at 1M scale** -> `bulk_search_volume` ($132) over `dataforseo_search_volume`
  ($180).

Clickstream = anonymised browsing-panel data (opt-in extensions, VPN apps, ISP panels)
with extrapolation multipliers. Observed behaviour modelled to population — not auction data.

### Google Ads extras

| Endpoint | Batch | Price |
|---|---|---|
| `keywords_data/google_ads/keywords_for_keywords/live` | 20 seeds -> ≤20,000 suggestions | $0.09 Live / $0.06 Standard |
| `keywords_data/google_ads/keywords_for_site/live` | 1 target -> ≤2,000 suggestions | same |
| `keywords_data/google_ads/ad_traffic_by_keywords/live` | 1000 kw, needs `bid` + `match` | same |

`ad_traffic_by_keywords` is the Keyword Planner **forecast** tool — impressions, clicks,
CPC, spend at a given bid. Budget modelling, not research.

### Field semantics

| Field | Scale | Meaning |
|---|---|---|
| `keyword_difficulty` | 0-100, **logarithmic** | difficulty of reaching top-10 organic, from link profiles of the current top-10. DataForSEO's metric, not Google's. |
| `search_intent.label` | informational / navigational / commercial / transactional | + `probability` 0-1; secondaries in `secondary_keyword_intents[]` |
| `competition` (Labs) | **0.0-1.0** float | advertiser competition |
| `competition_index` (Google Ads) | **0-100** int | filled ad slots / available * 100 |
| `cpc` | USD | historical average cost per click |
| `low_top_of_page_bid` | USD | bid above which ~20% of ads hit top of page 1 |
| `high_top_of_page_bid` | USD | bid above which ~80% do |
| `monthly_searches[]` | — | `{year, month, search_volume}`, newest first, ≤12 entries |
| `search_volume_trend` | % | `{monthly, quarterly, yearly}`, can be negative |

**Trap:** Labs `competition` (0-1) and Google Ads `competition_index` (0-100) are different
scales for the same idea. Multiply Labs by 100 to compare.

---

## 6. Competitor & domain analysis — 15 endpoints

All Labs, all DB, Live-only. **$0.012/task + $0.00012/item** unless noted.

| Endpoint | Input | Max batch | Answers |
|---|---|---|---|
| `labs/google/ranked_keywords/live` | 1 target | 1 | **every keyword a domain/subdomain/URL ranks for** — highest-value endpoint in the API |
| `labs/google/competitors_domain/live` | 1 domain | 1 | who competes with this domain overall |
| `labs/google/serp_competitors/live` | keywords | **200 kw** | who ranks for *this specific* keyword set |
| `labs/google/domain_intersection/live` | 2 domains | 2 | keywords both rank for — or the **gap** |
| `labs/google/page_intersection/live` | URLs | **20 pages** (+10 excluded) | same, page-level |
| `labs/google/relevant_pages/live` | 1 target | 1 | which pages carry the rankings |
| `labs/google/subdomains/live` | 1 target | 1 | ranking split across subdomains |
| `labs/google/domain_rank_overview/live` | 1 target | 1 | organic + paid traffic/ranking snapshot |
| `labs/google/bulk_traffic_estimation/live` | targets | **1000 domains** | ETV + count only. Cheapest triage. |
| `labs/google/historical_rank_overview/live` | 1 target | 1 | monthly rank + ETV. **$0.12/task + $0.0012/item** |
| `labs/google/historical_bulk_traffic_estimation/live` | targets | **1000** | monthly ETV. **$0.12 + $0.0012/domain** |
| `labs/google/historical_serps/live` | 1 keyword | 1 | past SERP snapshots. **$0.00012/SERP** ($0.12 per 1K) |
| `labs/google/categories_for_domain/live` | 1 target | 1 | which categories a domain ranks in |
| `labs/google/domain_metrics_by_categories/live` | categories | **5 codes** | two-date comparison. **$0.12 + $0.0012** |
| `labs/google/available_history/live` | — | — | **free** — the valid dates for the above |

### Distinctions people get wrong

**`competitors_domain` vs `serp_competitors`** — not interchangeable:

| | `competitors_domain` | `serp_competitors` |
|---|---|---|
| starts from | a **domain** | a **keyword list** (≤200) |
| logic | domains co-appearing in SERPs across *all* keywords your target ranks for | domains ranking for *the keywords you named* |
| use | "who competes with me?" | "who owns these 50 keywords?" |

`competitors_domain` extras: `max_rank_group` (default 100) controls how deep competitors
are found; `exclude_top_domains: true` strips a fixed list of 17 giants (Wikipedia,
Reddit, YouTube, Amazon, Pinterest, LinkedIn...). Anything else generic still shows.

**Keyword gap** — `domain_intersection` with `intersections: false`. Put the **competitor**
in `target1` and **yourself** in `target2`: returns keywords target1 ranks for and target2
does not. `intersections: true` (default) gives the overlap instead.

**Page-level gap** — `page_intersection`: competitor URLs in `pages{}`, yours in
`exclude_pages[]`. `pages` is an **object with numbered keys** (`{"1": "...", "2": "..."}`),
not an array. Wildcards must follow a slash: `example.com/blog/*` valid, `example.com*`
invalid. `intersection_mode`: `intersect` (all pages must rank) | `union` (any).

### Metric semantics

| Field | Meaning |
|---|---|
| `rank_group` | position among elements **of the same type** (3 = 3rd organic result) |
| `rank_absolute` | position among **all** SERP elements, ads and snippets included |
| `etv` | sum of CTR(position) x search_volume — estimated monthly organic traffic |
| `estimated_paid_traffic_cost` | sum of etv x cpc — what that traffic would cost via Ads |
| `metrics.organic.pos_1 / pos_2_3 / pos_4_10 / ...` | ranking distribution, bucketed by `rank_group` |
| `is_new / is_up / is_down / is_lost` | movement flags |
| `intersections` | count of shared keywords |
| `clickstream_etv` | ETV computed from clickstream volume; needs `include_clickstream_data` |

`bulk_traffic_estimation` returns a **reduced** metrics object — `etv` + `count` only, no
position buckets. Use `domain_rank_overview` for the full shape.

Set `load_rank_absolute: true` on `ranked_keywords` to also get `metrics_absolute`.

### History ranges

| Endpoint | Goes back to | Granularity |
|---|---|---|
| `historical_rank_overview` | **2020-10-01** | monthly |
| `historical_bulk_traffic_estimation` | **2020-10-01** | monthly |
| `historical_keyword_data` | **2021-08** | monthly |
| `historical_serps` | **12 months only** | per snapshot |
| clickstream historical fields | **2024-05** | monthly |
| `domain_metrics_by_categories` | 2020-10-01, dates **must** come from `available_history` | two-point |

`correlate` (default `true`) on the historical endpoints smooths inconsistencies across DB
updates. Leave it on.

---

## 7. Rank tracking / SERP

### Pricing — Google Organic, per SERP (10 results)

| Mode | Price | per 1K | Turnaround |
|---|---|---|---|
| **Standard, priority 1** | **$0.0006** | **$0.60** | ~5 min |
| Standard, priority 2 | $0.0012 | $1.20 | ~1 min |
| Live | $0.002 | $2.00 | ~6 sec |

The same $0.0006 / $0.0012 / $0.002 ladder applies to Maps, Local Finder, News, Events,
Jobs, Images, Autocomplete, Ads Search, Ads Advertisers, Finance, Search by Image.

**Google AI Mode is ~2x everything else:** $0.0012 / $0.0024 / **$0.004**.

### Cost multipliers — read before writing a keyword

| Parameter | Effect |
|---|---|
| search operators in `keyword` (`site:` `inurl:` `intitle:` `intext:` `inanchor:` `link:` `cache:` `define:` `filetype:` `id:` `info:` and all `allin*`) | **x5 per operator used** |
| `depth` > 10 | **x** for each 10 results (max 700 Standard / 200 Live) |
| `max_crawl_pages` | **x** for each SERP page crawled (max 100) |
| `priority: 2` | 2x base |
| Live vs Standard | ~3.3x base |
| `calculate_rectangles` | **+ one base price** (in AI Mode: **x2**) |
| `load_async_ai_overview` | + one base price; refunded if no AI overview present |
| `people_also_ask_click_depth` (1-4) | + $0.00015 **per click**; refunded if fewer performed |

The `x5` on `site:` is the nastiest — it is the most natural query a developer writes.

### Cheapest correct way to track N keywords daily

**Standard, priority 1, 100 keywords per POST, with `postback_url`.**

```jsonc
// POST /v3/serp/google/organic/task_post   — up to 100 of these per call
[{
  "keyword": "project management software",
  "location_code": 2840,
  "language_code": "en",
  "device": "desktop",
  "priority": 1,
  "tag": "client-42|kw-991",              // echoed back — use it to route results
  "postback_url": "https://you.com/hook?id=$id&tag=$tag",
  "postback_data": "advanced"             // REQUIRED when postback_url is set
}]
```

- 1,000 keywords/day = **$0.60/day**, ~$18/month. Live mode would be $2.00/day.
- `postback_url` costs nothing extra and removes all polling.
- If your server does not answer within **10 seconds** the task falls back to
  `tasks_ready` — no data lost, but you must poll.
- Standard results **expire after 30 days**.
- Without postback: poll `tasks_ready` -> `task_get/{advanced|regular|html}/$id`.
  `task_get` is **free**; you paid at `task_post`.

### `stop_crawl_on_match` — the rank-tracking cost lever

If you only need to know *where you rank*, stop the crawl once you are found. You are
billed only for pages actually crawled.

```jsonc
{
  "keyword": "project management software",
  "location_code": 2840, "language_code": "en",
  "depth": 100,
  "stop_crawl_on_match": [{ "match_value": "yourdomain.com", "match_type": "with_subdomains" }],
  "find_targets_in": ["organic", "featured_snippet"],
  "ignore_targets_in": ["paid"],
  "target_search_mode": "any"
}
```

Rank #3 -> pay for 1 page. Rank #47 -> 5 pages. Not in top 100 -> 10 pages.
`match_type`: `domain` | `with_subdomains` | `wildcard`. Up to 10 targets.
`target_search_mode`: `any` (stop on first) | `all` (stop when all found).

### `depth` vs `max_crawl_pages`

They complement each other. Effective results = `min(depth, max_crawl_pages x 10)`.
**Billing follows pages crawled, not results parsed.** For top-10 tracking leave both at
default (`depth: 10`, no `max_crawl_pages`) — one page, minimum cost.

### regular vs advanced vs html

**Same price.** Choose on content, not cost.

| Function | Returns | Use |
|---|---|---|
| `regular` | `organic`, `paid`, `featured_snippet` only | positions only; smallest payload |
| `advanced` | **all 42 item types**, fully structured | anything involving SERP features. **Default.** |
| `html` | raw SERP HTML | custom parsing, or `expand_ai_overview` |

`advanced` item types: `organic`, `paid`, `featured_snippet`, `ai_overview`,
`people_also_ask`, `local_pack`, `knowledge_graph`, `map`, `shopping`, `popular_products`,
`top_stories`, `video`, `short_videos`, `images`, `twitter`, `related_searches`,
`people_also_search`, `discussions_and_forums`, `perspectives`, `google_flights`,
`google_hotels`, `hotels_pack`, `jobs`, `events`, `recipes`, `top_sights`,
`scholarly_articles`, `questions_and_answers`, `answer_box`, `currency_box`, `stocks_box`,
`math_solver`, `commercial_units`, `local_services`, `third_party_reviews`,
`google_reviews`, `carousel`, `multi_carousel`, `refine_products`,
`product_considerations`, `compare_sites`, `find_results_on`, `app`.

### Google AI Mode

`serp/google/ai_mode/*` is a **separate endpoint**, not the `ai_overview` item inside a
normal organic SERP.

- Returns the AI Mode answer: `ai_overview_element` (text/links/images),
  `ai_overview_video_element`, `ai_overview_paid` (ads inside the AI answer),
  `ai_overview_reference` (source url/title/snippet), `refinement_chips`.
- **No `depth`**, no pagination, no `stop_crawl_on_match`.
- Its own language list at `/v3/serp/google/ai_mode/languages`. Not all locations supported.
- `calculate_rectangles` here **multiplies cost x2** instead of adding a base price.

To get the AI overview *inside* a normal SERP instead, set `load_async_ai_overview: true`
on `serp/google/organic` (+1 base price, refunded if absent). `expand_ai_overview` works
only on HTML results.

### YouTube

| Endpoint | Notes |
|---|---|
| `serp/youtube/organic/live/advanced` | billed per 20 blocks (default 20, max 200) |
| `serp/youtube/video_info/live/advanced` | metadata, stats, channel. Needs `video_id`. ~$0.006 |
| `serp/youtube/video_comments/live/advanced` | billed per 20 results. ~$0.002 |
| `serp/youtube/video_subtitles/live/advanced` | transcript with timestamps; `subtitles_translate_language` available |

### Shared SERP request params

| Param | Notes |
|---|---|
| `keyword` | ≤700 chars. **Operators trigger x5.** `%` -> `%25`, `+` -> `%2B` |
| `location_code` | int, `2840` = US. Free list at `/locations`. Prefer over `location_name` |
| `location_coordinate` | `"lat,lng,radius"`, radius in mm (199-199999), ≤7 decimals |
| `language_code` | e.g. `en`. Free list at `/languages` |
| `device` / `os` | `desktop`(`windows`\|`macos`) / `mobile`(`android`\|`ios`) |
| `se_domain` | override, e.g. `google.co.uk` |
| `tag` | ≤255 chars, echoed in `data`. **Always set it** — it is how you match results |
| `priority` | `1` normal (default), `2` high (2x cost) |
| `postback_url` + `postback_data` | push results; `postback_data` in `regular`\|`advanced`\|`html` |
| `pingback_url` | notify only, no payload |
| `group_organic_results` | default `true` — related results nested in parent |
| `remove_from_url` | strip up to 10 params, e.g. `["srsltid"]` |

---

## 8. Backlinks — 21 endpoints

DB, Live-only, off their own continuous crawl ("we crawl the web each second nonstop").

**Pricing (uniform across the cluster): `$0.024` per request + `$0.000036` per row.**
A full 1,000-row request = `0.024 + 0.000036 x 1000` = **$0.06**.

**Filtering and sorting are free** — stated explicitly in the docs. Always filter
server-side.

| Endpoint | Target form | Max | Returns |
|---|---|---|---|
| `backlinks/summary/live` | domain / subdomain / page | 1 | full profile: counts, rank, spam, broken, referrers |
| `backlinks/backlinks/live` | domain / subdomain / page | 1 | individual backlink rows |
| `backlinks/anchors/live` | domain / subdomain / page | 1 | anchor-text distribution |
| `backlinks/referring_domains/live` | domain / subdomain / page | 1 | per-domain stats |
| `backlinks/referring_networks/live` | domain / subdomain / page | 1 | IPs / subnets — detects link farms |
| `backlinks/domain_pages/live` | **domain or subdomain only** | 1 | pages of the target + their profiles |
| `backlinks/domain_pages_summary/live` | domain / subdomain / page | 1 | lighter per-page summary |
| `backlinks/competitors/live` | domain / subdomain / page | 1 | domains sharing backlink sources |
| `backlinks/domain_intersection/live` | `targets{}` numbered | **20** | who links to them but not you |
| `backlinks/page_intersection/live` | `targets{}` numbered | **20** | same, page level |
| `backlinks/history/live` | **domain only** | 1 | monthly snapshots since **2019-01** |
| `backlinks/timeseries_summary/live` | **domain only** | 1 | absolute counts, `group_range` day/week/month/year |
| `backlinks/timeseries_new_lost_summary/live` | **domain only** | 1 | new/lost per period, same granularity |
| `backlinks/bulk_ranks/live` | array | **1000** | rank per target |
| `backlinks/bulk_backlinks/live` | array | **1000** | backlink count per target |
| `backlinks/bulk_spam_score/live` | array | **1000** | spam score per target |
| `backlinks/bulk_referring_domains/live` | array | **1000** | referring-domain counts |
| `backlinks/bulk_new_lost_backlinks/live` | array | **1000** | new/lost counts, `date_from` min = today-1yr |
| `backlinks/bulk_new_lost_referring_domains/live` | array | **1000** | same for referring domains |
| `backlinks/bulk_pages_summary/live` | array | **1000** but **≤100 distinct domains** | full summary per URL |
| `backlinks/index` | — | — | **free** — global index size + 12-month history. Freshness check. |

### The `target` parameter — #1 source of wrong results

- `example.com` -> root domain, **includes subdomains by default**
- `blog.example.com` -> that subdomain only
- `https://example.com/page/` -> that exact page only
- **No `https://`, no `www.`** for domain/subdomain queries

Passing `https://example.com` when you meant the domain silently returns backlinks to that
one URL. No error, just a much smaller result set.

`domain_pages`, `history`, `timeseries_summary`, `timeseries_new_lost_summary` accept
**domains only** — no URLs.

### Bulk vs non-bulk

Use bulk when you need **one number per target**, not the underlying rows.
`bulk_backlinks` returns a count; `backlinks` returns up to 1,000 link rows. 1,000 targets
in one $0.06 request instead of 1,000 requests at $0.024 each (= $24). **400x cheaper.**

### New vs lost — five overlapping endpoints

| Endpoint | Scope | Granularity | Range |
|---|---|---|---|
| `history` | 1 domain | monthly snapshot + delta | since 2019-01 |
| `timeseries_summary` | 1 domain | **absolute** counts, day/week/month/year | since 2019-01-30 |
| `timeseries_new_lost_summary` | 1 domain | **churn** (new vs lost), day/week/month/year | since 2019-01-30 |
| `bulk_new_lost_backlinks` | **1000 targets** | one aggregate number | `date_from` min today-1yr |
| `bulk_new_lost_referring_domains` | **1000 targets** | one aggregate number | same |

For individual new/lost **rows** (not counts), use `backlinks/live` with
`filters: ["is_new","=",true]` and `backlinks_status_type: "all"`.

### `mode` on `backlinks/live`

| Value | Effect |
|---|---|
| `as_is` (default) | one row per referring page (deduped; `links_count` shows how many were on it) |
| `one_per_domain` | one row per referring domain; `group_count` = total from that domain |
| `one_per_anchor` | one row per anchor text |
| `custom_mode` | `{"field":"domain","value":100}` — N rows per field |

### Metric semantics

| Field | Scale | Meaning |
|---|---|---|
| `rank` | **0-1000** default, 0-100 with `rank_scale: "one_hundred"` | PageRank-style score from referring-domain quantity + quality |
| `spam_score` / `backlinks_spam_score` | 0-100 | proprietary; for a domain target it is the **average** across pages |
| `dofollow` | bool | `false` = has nofollow/ugc/sponsored |
| `referring_domains` | int | distinct domains — `blog.x.com` and `x.com` count as **two** |
| `referring_main_domains` | int | distinct **root** domains — those two count as **one** |
| `referring_ips` / `referring_subnets` | int | distinct IPs / /24 subnets |
| `broken_backlinks` / `broken_pages` | int | links to 4xx/5xx targets / target pages returning 4xx/5xx |
| `first_seen` / `last_seen` / `prev_seen` | timestamp | crawler visit history |
| `lost_date` | timestamp | when the link disappeared; `null` if live |
| `page_from_rank` / `domain_from_rank` | int | rank of the referring page / domain |
| `links_count` | int | identical links from the same referring page |
| `item_type` | str | `anchor`, `image`, `meta`, `canonical`, `alternate`, `redirect` |

### Backlinks-specific defaults that bite

- `backlinks_status_type` defaults to **`live`** — lost links are silently excluded.
  Set `"all"` or `"lost"` to see them.
- `include_subdomains` defaults to **`true`** — inflates counts vs tools that don't.
- `exclude_internal_backlinks` defaults to **`true`**.
- `rank_scale` defaults to **0-1000**, not 0-100. Forgetting makes ranks look inflated.
- `history` new/lost fields return **`0` (not null)** for dates before **May 2021**.
- Two filter layers exist: `backlinks_filters` (pre-filters the underlying links) vs
  `filters` (filters the returned rows). Confusing them gives wrong aggregates.

---

## 9. Technical SEO (OnPage)

LIVE — it actually crawls your site. Standard method (task queue).

### Pricing — per crawled page

| Config | Price/page | per 1K pages |
|---|---|---|
| **Basic** (60+ checks, internal links, HTML, duplicates, speed) | **$0.00015** | **$0.15** |
| `+ calculate_keyword_density` | $0.0003 | $0.30 |
| `+ load_resources` | $0.00045 | $0.45 |
| `+ enable_javascript` | $0.0015 | $1.50 |
| `+ enable_browser_rendering` (needs JS **and** resources) | **$0.0051** | $5.10 |
| `instant_pages` (single page, Live) | $0.00015 | — |
| `page_screenshot` | $0.0048 | — |
| `lighthouse` | $0.005/page | $5,000 per 1M |

**Browser rendering is 34x basic.** Only enable it when you genuinely need Core Web Vitals
(FID/CLS/LCP). A 10,000-page crawl: $1.50 basic vs **$51** rendered.

### Crawl lifecycle

```
1. POST /v3/on_page/task_post  { target, max_crawl_pages, ... }   -> task id, crawl starts
2. POST /v3/on_page/summary    { id }    -> poll crawl_progress
   (or set pingback_url / postback_url)
3. POST the getter endpoints with { id } — all FREE, you paid at task_post
```

| Getter | Needs | Returns |
|---|---|---|
| `on_page/pages` | `id` | per-page checks, meta, timing, word count, Core Web Vitals |
| `on_page/links` | `id` | every link: `direction`, `link_from/to`, `type`, `is_broken` |
| `on_page/redirect_chains` | `id` | multi-hop chains with status per hop |
| `on_page/duplicate_content` | `id` + `url` | similar pages + `similarity_index` (0-1) |
| `on_page/keyword_density` | `id` + `keyword_length` (1-5) | term frequency + density |

All support `filters` (8 max), `order_by` (3 max), `limit` (max 1000), `offset` (max 2M).

### Key `task_post` params

| Param | Default | Notes |
|---|---|---|
| `target` | required | domain, no protocol |
| `max_crawl_pages` | required | **billed per page actually crawled**; unused budget refunded |
| `start_url` | homepage | if not the homepage, **all sitewide checks are disabled** |
| `max_crawl_depth` | none | link depth from start |
| `crawl_delay` | **2000 ms** | 100 pages ≈ 200s minimum |
| `enable_javascript` | false | **10x cost** |
| `load_resources` | false | **3x cost** — images/CSS/JS/broken resources |
| `enable_browser_rendering` | false | **34x cost**, requires the two above |
| `calculate_keyword_density` | false | **2x cost**; required for the `keyword_density` getter |
| `store_raw_html` | false | required for the `raw_html` getter |
| `enable_content_parsing` | false | required for `content_parsing` |
| `custom_js` | — | ≤2000 chars, 700 ms timeout, needs JS enabled |
| `respect_sitemap` / `custom_robots_txt` | — | crawl control |
| `priority_urls` | — | up to 20 crawled first |

**`keyword_density` requires `calculate_keyword_density: true` at `task_post`.** Forget it
and you must re-crawl — and re-pay.

### `instant_pages` — no crawl, one page, Live

20 tasks per POST, **max 5 from the same domain** (else `40501`). Same field set as
`pages`, but no sitewide checks. Use for spot checks and pre-publish validation.

---

## 10. AI search optimization (AEO / GEO)

Four *different products* that get confused constantly.

| Product | What it physically does | Cost |
|---|---|---|
| **`llm_mentions`** | queries a **precomputed DB** of AI answers already collected from Google AI Overview + ChatGPT. No LLM is called. | per request |
| **`llm_responses`** | **calls the provider API live** (OpenAI / Anthropic / Google / Perplexity) and proxies the answer | **base + `money_spent`** token pass-through |
| **`llm_scraper`** | **scrapes the consumer web UI** of ChatGPT / Gemini in a real browser at a given location | $0.0012 Standard / $0.0024 Priority / **$0.004** Live |
| **`ai_keyword_data`** | AI search volume for keywords, derived from PAA statistics | **$0.01/task + $0.0001/item** ($110 per 1M) |

### llm_mentions — 16 endpoints, the AEO core

**Coverage:** platforms are `google` (AI Overview) and `chat_gpt` only.
**ChatGPT data is United States + English only** (`location_code: 2840`, `language_code: en`).
Data starts **2025-08-01**. Batch is **1 task per call** — 100 keywords = 100 calls.

| Endpoint | Returns |
|---|---|
| `llm_mentions/target_metrics/live` | aggregated mentions + `ai_search_volume`, nested by location/language/platform/source |
| `llm_mentions/target_metrics_lite/live` | same, **flat rows**, paginated, cheaper |
| `llm_mentions/multi_target_metrics/live` | compare **2-10** brands side by side |
| `llm_mentions/search_mentions/live` | raw mention records: question, answer markdown, sources, brand entities |
| `llm_mentions/historical/live` | absolute mentions per month |
| `llm_mentions/timeseries_delta/live` | change per bucket. Needs `date_from`,`date_to`,`group_range` |
| `llm_mentions/timeseries_new_lost/live` | new vs lost mentions per bucket |
| `llm_mentions/top_mentioned_brands/live` (+`_lite`) | which brands dominate answers |
| `llm_mentions/top_mentioned_domains/live` (+`_lite`) | which domains get cited |
| `llm_mentions/top_mentioned_pages/live` (+`_lite`) | which exact URLs get cited |
| `llm_mentions/top_mentioned_brand_categories/live` (+`_lite`) | category-level view |
| `llm_mentions/locations_and_languages` | **free** — supported combos + `responses_count` |
| `llm_mentions/filters` / `available_filters` | **free** |

**`_lite` variants** drop all nested breakdowns (sources_domain, search_results_domain,
brand_entities) and return flat paginated rows. Use lite unless you specifically need
"which domains cite my brand".

**`search_scope`** decides where a mention counts:

| Target type | Values |
|---|---|
| keyword | `any` (default) / `question` / `answer` / `brand_entities` / `fan_out_queries` |
| domain | `any` (default) / `sources` (cited in the answer) / `search_results` (retrieved but maybe unused) |

`match_type`: `word_match` (default, whole word) vs `partial_match` (substring).

**`links_scope`** on the domain/page endpoints defaults to `sources`. Set
`"search_results"` to see what the model *retrieved* rather than what it *cited*.

### llm_responses vs llm_scraper

| | `llm_responses` | `llm_scraper` |
|---|---|---|
| mechanism | provider API call | real browser on the consumer UI |
| model control | full: `model_name`, `temperature`, `top_p`, `max_output_tokens`, `system_message`, `message_chain` | none |
| prompt limit | **500 chars** (`user_prompt`) | **2000 chars** (`keyword`) |
| geo targeting | only via `web_search_country_iso_code` / `web_search_city` | full `location_code` / `location_name` |
| multi-turn | yes, ≤10 messages | no |
| web search | opt-in `web_search: true` | always on |
| providers | ChatGPT, Claude, Gemini, Perplexity | ChatGPT, Gemini |
| cost | **base + token pass-through — unpredictable** | flat per request |
| output | `message.sections[].text` (+`reasoning`) | structured SERP-like elements |

`llm_scraper` returns typed items: `chat_gpt_text`, `chat_gpt_table`,
`chat_gpt_navigation_list`, `chat_gpt_images`, `chat_gpt_local_businesses`,
`chat_gpt_products` (and `gemini_text`, `gemini_table`, `gemini_images`), plus `markdown`,
`sources[]`, `search_results[]`, `fan_out_queries[]`, `brand_entities[]`.

**Use the scraper for AEO auditing** ("what does a real user in France see?") and
`llm_responses` only when you need deterministic model control.

Provider quirks: `temperature` and `top_p` are **mutually exclusive** on ChatGPT and
Claude (Gemini allows both). Reasoning models reject `temperature`. Perplexity sonar has
web search always on and requires strictly alternating `user`/`ai` roles. Query the free
`.../llm_responses/models` endpoint for current model names rather than hardcoding.

### Time-series choice

| Question | Endpoint |
|---|---|
| plot total mentions per month | `historical` |
| alert on a weekly drop | `timeseries_delta` (`group_range: week`) |
| are we gaining new mentions or just retaining? | `timeseries_new_lost` |

---

## 11. Content & brand monitoring

DB, Live-only. **`$0.024` per request + `$0.000036` per row** — same as Backlinks, so a
1,000-row pull is **$0.06**. Filtering and sorting are **free**.

A "citation" is a mention of your keyword found in DataForSEO's own crawled web corpus.
You do not supply URLs — you query by keyword and get back everything they know about.

| Endpoint | Needs | Returns |
|---|---|---|
| `content_analysis/search/live` | `keyword` | individual citations: URL, snippet, `domain_rank`, author, date, sentiment |
| `content_analysis/summary/live` | `keyword` | totals: citation count, top domains, sentiment split, categories, countries |
| `content_analysis/sentiment_analysis/live` | `keyword` | citations grouped by polarity **and** connotation |
| `content_analysis/rating_distribution/live` | `keyword` | citations grouped by rating value |
| `content_analysis/phrase_trends/live` | `keyword`, `date_from` | citation volume over time |
| `content_analysis/category_trends/live` | `category_code`, `date_from` | category trend, no keyword needed |

**Sentiment model output:** polarity `{positive, negative, neutral}` (floats) plus
connotations `{anger, happiness, love, sadness, share, fun}` — all floats, **not mutually
exclusive**.

Useful params: `keyword_fields` (`title`/`main_title`/`snippet`), `page_type`
(`ecommerce`/`news`/`blogs`/`message-boards`/`organization`), `search_mode`
(`as_is` | `one_per_domain`), `initial_dataset_filters` (pre-aggregation).

Exact phrases need **escaped quotes**: `"keyword": "\"tesla palo alto\""`. Without them
the words match independently.

---

## 12. Trends & seasonality

Two products with confusingly similar names.

| | Google Trends | DataForSEO Trends |
|---|---|---|
| endpoint | `keywords_data/google_trends/explore` | `keywords_data/dataforseo_trends/*` |
| source | scraped Google Trends | DFS clickstream + content associations |
| `type` values | `web`, `news`, `youtube`, `images`, `froogle` | `web`, `news`, `ecommerce` |
| max keywords | **5** | **5** |
| rate limit | **250/min, 500K/day shared across all customers** | normal 2000/min |
| demographics | **no** | **yes** |
| related topics/queries | **yes** (requires exactly **1** keyword) | no |
| price | $0.0027 Standard / **$0.011** Live | **$0.0012** explore |

| DFS Trends endpoint | Price/task | Gives |
|---|---|---|
| `dataforseo_trends/explore/live` | **$0.0012** | popularity graph |
| `dataforseo_trends/subregion_interests/live` | $0.0024 | per-region + cross-keyword comparison |
| `dataforseo_trends/demography/live` | $0.0024 | **age + gender** — Google Trends cannot do this |
| `dataforseo_trends/merged_data/live` | $0.006 | all three in one call (saves 2 requests) |
| `keywords_data/google_trends/categories` | **free** | category codes |

**Decision:** DataForSEO Trends is ~9x cheaper than Google Trends Live, has no shared
daily quota, and is the only source of demographics. Use Google Trends only when you need
related topics/queries, YouTube/Images/Shopping trend types, or numbers that match the
Google Trends UI exactly.

Both cover `web` from **2004-01-01**, other types from **2008-01-01**. Time buckets
auto-select: hourly (<7d), daily (<90d), weekly (<5y), monthly (≥5y).

---

## 13. Raw databases — how bulk actually works

**These are not API endpoints. They are downloadable file dumps.** You buy a database for
a location/language, receive `.json.gz` / `.csv.gz`, and load it into your own
infrastructure. There is no query parameter, no filter, no `limit`.

| Database | Contains | Formats | Update |
|---|---|---|---|
| `databases/google/keywords` | billions of keywords + SV, CPC, competition, KD, intent, 4y monthly history | JSON, CSV | monthly, 2nd half |
| `databases/google/serp_regular` | SERPs with `organic`/`paid`/`featured_snippet` only, 67 regions | JSON, CSV | 60-90 day cycle |
| `databases/google/serp_advanced` | SERPs with **all** item types + `page_rank`/`domain_rank` per result | JSON | 60-90 day cycle |
| `databases/google/full` | keywords DB + SERP advanced DB unified | JSON | combined |
| `databases/google/history/keywords` | monthly keyword metrics, since **2021-08** | JSON | monthly |
| `databases/google/history/serp_advanced` | monthly SERP snapshots, **past 365 days only** | JSON | monthly |
| `databases/bing/keywords` | Bing keywords; **CPC/competition only for DE, FR, AU, CA, UK, US** | JSON | monthly |
| `databases/domains` | millions of domains + WHOIS + ranking metrics + backlinks_info | JSON, CSV | monthly |
| `databases/backlink_summary` | millions of domains + full backlink profile | JSON, CSV | not documented |

**Pricing is per database per location**, not per row. Size-dependent. The Domains DB is
quote-only. **Recurring delivery to your own S3 / SFTP / GCS costs 50% of standard price.**

### When a dump beats the API

| Need | Use |
|---|---|
| ALL keywords for a locale, not a specific list | **database** — the API charges per keyword |
| enrich your own list of <1M keywords | **API** (Labs `keyword_overview`) |
| domain metrics for millions of domains | **database** |
| fresh positions for specific keywords | **API** — dumps are 60-90 days stale |
| historical SERPs across many keywords | **database** (History SERP) |

**The staleness rule: never use a SERP database for rank tracking.** 60-90 days old.

---

## 14. The filter DSL

Nearly identical across Labs, Backlinks, Content Analysis and llm_mentions. **Filtering
and sorting cost nothing** — always filter server-side.

### Syntax

```jsonc
"filters": ["field.path", "operator", value]

"filters": [
  ["field.path", "op", value],
  "and",
  ["field.path", "op", value]
]

// nested
"filters": [
  ["a", ">", 1],
  "and",
  [ ["b", "=", true], "or", ["c", "<", 5] ]
]
```

### Limits

| Constraint | Value |
|---|---|
| Max filter conditions | **8** |
| Max `order_by` rules | **3** |
| `limit` | default 100, **max 1000** |
| `offset` | Labs/Content: use `offset_token` past **10,000**. Backlinks `backlinks/live`: `search_after_token` past **20,000**. OnPage: max 2M |
| `regex` length | **1000 chars** (RE2 syntax) |
| Sorting `array.*` fields | **not allowed** |

### Operators by type

| Type | Operators |
|---|---|
| `bool` | `=`, `<>` |
| `num` | `<`, `<=`, `>`, `>=`, `=`, `<>`, `in`, `not_in` |
| `str` | `=`, `<>`, `like`, `not_like`, `ilike`, `not_ilike`, `match`, `not_match`, `in`, `not_in`, `regex`, `not_regex` |
| `array.str` / `array.num` | `has`, `has_not` |
| `time` | `<`, `>` — format `"yyyy-mm-dd hh-mm-ss +00:00"` |

`like`/`not_like` need `%` wildcards and are case-sensitive; `ilike` is not.
`in`/`not_in` take an array value. `match` is full-text word matching.

### `order_by`

```jsonc
"order_by": ["keyword_info.search_volume,desc", "keyword_info.cpc,asc"]
```

### Discover valid fields

Every cluster has a **free** `available_filters` endpoint returning the exact filterable
field names per endpoint. Call it instead of guessing — field prefixes differ
(`related_keywords` nests under `keyword_data.`, most others do not).

### Worked examples

```jsonc
// low-hanging content opportunities
"filters": [["keyword_info.search_volume", ">", 1000], "and",
            ["keyword_properties.keyword_difficulty", "<", 30]],
"order_by": ["keyword_info.search_volume,desc"]

// commercial intent only
"filters": [["keyword_info.search_volume", ">=", 100], "and",
            [["search_intent_info.main_intent", "=", "commercial"], "or",
             ["search_intent_info.main_intent", "=", "transactional"]]]

// keywords whose SERP has a featured snippet
"filters": [["serp_info.serp_item_types", "has", "featured_snippet"]]

// competitor's top-10 keywords worth real traffic  (ranked_keywords)
"filters": [["ranked_serp_element.serp_item.rank_group", "<=", 10], "and",
            ["keyword_data.keyword_info.search_volume", ">", 500]]

// clean dofollow .edu links  (backlinks)
"filters": [["dofollow", "=", true], "and",
            [["tld_from", "=", ".edu"], "and", ["is_broken", "=", false]]]

// links gained in the last 30 days  (backlinks)
"filters": ["first_seen", ">", "2026-07-05 00:00:00 +00:00"]
```

Labs also supports **cross-field comparison** on Ranked Keywords, Page/Domain
Intersection, Subdomains, Relevant Pages, Competitors Domain, Categories For Domain —
prefix the right side with `$item->`:

```jsonc
["metrics.organic.pos_1", ">", "$item->metrics.organic.pos_2_3"]
```

---

## 15. Cost traps

Ranked by how much money they quietly cost.

1. **`include_clickstream_data: true` doubles the price of the whole Labs request.**
   Available on most Labs endpoints, defaults `false`. Enabling it "just in case" doubles
   your entire Labs bill. Only turn it on when you need clickstream volume or
   gender/age distribution.

2. **Search operators cost 5x, per operator.** `site:`, `inurl:`, `intitle:` etc. in a
   SERP `keyword`. A `site:` audit over 1,000 keywords is $3.00, not $0.60.

3. **Google Ads batch poisoning.** If **one** keyword in a batch of 100 is restricted by
   Google ad policy (adult, pharma, gambling, trademark), **the entire batch returns null
   search volume — and you are still charged.** Isolate risky keywords, or use clickstream
   endpoints which have no policy filter.

4. **Google Ads rate limit is 12 req/min**, not 2000. If you designed against Labs speed
   and switched endpoints for "official" data, you are now 166x slower. For bulk, use Labs
   `keyword_overview` — same numbers.

5. **`enable_browser_rendering` is 34x basic OnPage cost.** $0.15 -> $5.10 per 1K pages.

6. **Live instead of Standard is ~3.3x** for identical SERP data. Only pay it when a human
   is waiting.

7. **`limit` maxes at 1000 and you pay per request.** A domain with 50K ranked keywords is
   50 paid calls. Check `total_count` first and decide whether you need them all.

8. **`bulk_pages_summary` silently caps at 100 distinct domains** even though it accepts
   1000 URLs.

9. **`domain_intersection` returns empty (not an error)** when intersecting keywords
   exceed 10 million.

10. **Keywords missing from the Labs DB are silently omitted** — no item, no error, no
    charge. Compare `items_count` against your input length. A missing keyword means "not
    in the 4.8B DB", **not** "zero search volume".

11. **`related_keywords` cost scales with `depth`.** `depth: 4` can return 4,680 rows.
    At $0.00012/row that is $0.57 for one seed keyword.

12. **`offset` beyond its cap silently misbehaves** (duplicates, gaps, timeouts). Use
    `offset_token` / `search_after_token`.

13. **Standard results expire after 30 days** (`40403`).

14. **`postback_url` has a 10-second timeout.** Slow endpoint -> falls back to
    `tasks_ready`, and you must poll or the results expire.

15. **llm_mentions `platform` defaults are inconsistent.** Most endpoints return both
    platforms if unset; `multi_target_metrics`, both `timeseries_*`, and every `_lite`
    variant default to `google` only.

16. **`llm_responses` cost is unpredictable** — base + provider token pass-through
    (`money_spent`). With reasoning models or `web_search: true`, output can exceed
    `max_output_tokens`. Use `llm_scraper` (flat rate) when you don't need model control.

17. **`keyword_density` needs `calculate_keyword_density: true` at `task_post`.** Forgot?
    Re-crawl and re-pay.

---

## 16. Recipes

### Rank tracking, 500 keywords daily — $0.30/day

```
POST /v3/serp/google/organic/task_post   x5 calls (100 tasks each)
  priority 1, depth 10, postback_url set, postback_data "advanced", tag per keyword
-> results arrive at your webhook; task_get is free if you need to re-pull within 30 days
```

### Full keyword research on a seed — about $0.20

```
1. labs/google/keyword_ideas        seed -> category-adjacent terms   ($0.012 + rows)
2. labs/google/keyword_suggestions  seed -> long-tail variants        ($0.012 + rows)
3. labs/google/related_keywords     seed, depth 2 -> topic graph      ($0.012 + <=72 rows)
4. dedupe locally
5. labs/google/keyword_overview     700 at a time, filtered server-side:
     filters: [["keyword_info.search_volume", ">", 100], "and",
               ["keyword_properties.keyword_difficulty", "<", 40]]
```

### Competitor teardown — about $0.10

```
1. labs/google/competitors_domain      exclude_top_domains: true   -> real rivals
2. labs/google/domain_rank_overview    each rival                  -> size them
3. labs/google/domain_intersection     intersections: false        -> the keyword gap
     target1 = rival, target2 = you
4. labs/google/relevant_pages          rival                       -> what to model
5. backlinks/domain_intersection       who links to them, not you  ($0.024 + rows)
```

### Backlink audit — $0.06 per 1,000 links

```
backlinks/summary        overall shape
backlinks/backlinks      mode "one_per_domain", filters:
                           [["dofollow","=",true],"and",["backlink_spam_score","<",30]]
backlinks/anchors        over-optimisation check
backlinks/referring_networks   link-farm detection (IP/subnet clustering)
backlinks/bulk_spam_score      1000 competitor domains in one $0.06 call
```

### AEO / AI visibility baseline

```
1. llm_mentions/target_metrics_lite   your brand, platform google + chat_gpt
2. llm_mentions/top_mentioned_brands  same query -> who beats you in AI answers
3. llm_mentions/top_mentioned_domains links_scope "sources" -> who gets cited
4. llm_mentions/timeseries_new_lost   group_range week -> are you gaining or losing
5. chat_gpt/llm_scraper/live/advanced spot-check the actual answer a user sees
```

### Site audit — $0.15 per 1,000 pages

```
on_page/task_post   max_crawl_pages 1000, basic (no JS/rendering)
  -> on_page/summary          poll crawl_progress
  -> on_page/pages            filters: ["checks.is_broken","=",true]
  -> on_page/links            filters: ["is_broken","=",true]
  -> on_page/redirect_chains
  -> on_page/duplicate_content
Enable enable_javascript ONLY for SPA sites (10x). browser_rendering only for CWV (34x).
```

---

## 17. Defaults to assume

- **Estimate and confirm before spending.** §0 is not optional. When in doubt, say the
  number and wait.
- **Location `2840`** = United States. **Language `en`**. Always send both explicitly —
  omitting them changes results silently.
- **Prefer `location_code` over `location_name`** (ints don't have spelling bugs).
- **Always set `tag`** — it is the only reliable way to match async results to inputs.
- **Always send `filters` + `limit`** on DB endpoints. Free, and it cuts the per-row charge.
- **Default to Standard priority 1** unless a human is waiting.
- **Default to `advanced`** over `regular` — same price, far more data.
- **Check `labs/status`** (free) for DB freshness and `backlinks/index` (free) for index
  size before trusting DB numbers for anything time-sensitive.
- **Start in Sandbox.** Every schema is identical and it costs nothing.
