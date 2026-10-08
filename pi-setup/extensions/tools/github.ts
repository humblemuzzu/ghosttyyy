/**
 * github tools — 7 tools for reading, searching, and exploring github repos.
 *
 * designed for the librarian sub-agent but registered as top-level extension
 * tools. the librarian spawns a pi process with `--tools <these names>` (see
 * lib/pi-spawn.ts), which gates built-in, extension and custom tools alike.
 *
 * all tools use `gh api` CLI under the hood. requires authenticated gh CLI.
 *
 * tool schemas:
 *   read_github, search_github, list_directory_github,
 *   list_repositories, glob_github, commit_search, diff
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	parseRepoUrl,
	repoSlug,
	canonicalRepoSlug,
	renameNote,
	ghApi,
	decodeBase64Content,
	addLineNumbers,
	truncate,
} from "./lib/github";
import { boxRendererWindowed, osc8Link, COLLAPSED_EXCERPTS, renderBoxedText, type BoxSection, type BoxLine } from "./lib/box-format";
import { getText, getContainer } from "./lib/tui";
import { resolveParam } from "./lib/params";

/*
 * SHARED `repository` PARAMETER.
 *
 * every tool in this file targets a REMOTE repository over the GitHub API, and
 * every one of them needs the repo. two failure modes were observed in real
 * sessions:
 *
 *   1. the model reaches for a github tool when it meant to search the local
 *      checkout, and sends no repository at all (`{"pattern": ""}`)
 *   2. the model calls the parameter `repo`, which is the more natural name
 *
 * declaring it Optional lets both reach execute(), where requireRepository()
 * can say what is actually wrong and which tool to use instead — rather than
 * pi's generic "must have required properties repository".
 */
const REPOSITORY_PARAM = Type.Optional(
	Type.String({
		description:
			"REQUIRED. URL of the REMOTE repository to query, e.g. https://github.com/owner/repo. " +
			"This tool never reads the local working copy.",
	}),
);

/** parameter names models actually use for the repository, canonical first. */
const REPO_PARAMS = ["repository", "repo", "repo_url", "url"] as const;

const API_PAGE_SIZE = 100;

/**
 * items [offset, offset + limit) from a page-numbered API: a true skip, fetching
 * only the pages that cover the window.
 */
export function fetchWindow<T>(offset: number, limit: number, fetchPage: (page: number, perPage: number) => T[]): T[] {
	const out: T[] = [];
	let page = Math.floor(offset / API_PAGE_SIZE) + 1;
	let skip = offset % API_PAGE_SIZE;
	while (out.length < limit) {
		const items = fetchPage(page, API_PAGE_SIZE);
		out.push(...items.slice(skip, skip + (limit - out.length)));
		if (items.length < API_PAGE_SIZE) break;
		skip = 0;
		page++;
	}
	return out;
}

/**
 * resolve the repository, or return a result that tells the model precisely
 * what to do instead of guessing again.
 */
function requireRepository(
	params: Record<string, unknown>,
	toolName: string,
	localAlternative: string,
): { value: string } | { error: any } {
	const value = resolveParam(params, REPO_PARAMS);
	if (value) return { value };
	return {
		error: {
			content: [
				{
					type: "text" as const,
					text:
						`${toolName}: missing required parameter "repository" (aliases: repo, repo_url, url).\n\n` +
						`${toolName} queries a REMOTE repository through the GitHub API and cannot run without one, ` +
						`e.g. repository: "https://github.com/owner/repo".\n\n` +
						`If you meant to search the local working copy in this session, use \`${localAlternative}\` instead.`,
				},
			],
			isError: true as const,
		},
	};
}

// --- read_github ---

export function createReadGithubTool(): ToolDefinition {
	return {
		name: "read_github",
		label: "Read GitHub",
		description:
			"Read the contents of a file from a GitHub repository.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to examine the contents of a specific file in a remote repo\n" +
			"- When you want to understand implementation details across repositories\n\n" +
			"PARAMETERS:\n" +
			"- path: The file path to read\n" +
			"- repository: Repository URL (e.g., https://github.com/owner/repo)\n" +
			"- read_range: Optional [start_line, end_line] to read only specific lines",

		parameters: Type.Object({
			path: Type.String({ description: "The path to the file to read" }),
			repository: REPOSITORY_PARAM,
			read_range: Type.Optional(
				Type.Array(Type.Number(), {
					minItems: 2,
					maxItems: 2,
					description: "Optional [start_line, end_line] to read only specific lines",
				}),
			),
		}),

		async execute(_id, params) {
			try {
				const repo = requireRepository(params as any, "read_github", "read");
				if ("error" in repo) return repo.error;
				const ref = parseRepoUrl(repo.value);
				const data = ghApi<any>(`repos/${repoSlug(ref)}/contents/${params.path}`);

				if (Array.isArray(data)) {
					return { content: [{ type: "text" as const, text: "Path is a directory, not a file. Use list_directory_github instead." }], isError: true };
				}

				if (data.type !== "file" || !data.content) {
					return { content: [{ type: "text" as const, text: `Not a file: ${data.type}` }], isError: true };
				}

				let content = decodeBase64Content(data.content);

				if (params.read_range) {
					const [start, end] = params.read_range;
					const lines = content.split("\n");
					const startIdx = Math.max(0, start - 1);
					const endIdx = Math.min(lines.length, end);
					content = lines.slice(startIdx, endIdx).join("\n");
					return { content: [{ type: "text" as const, text: addLineNumbers(content, start) }], details: { header: `${repoSlug(ref)}/${params.path}` } };
				}

				return { content: [{ type: "text" as const, text: truncate(addLineNumbers(content), 64_000) }], details: { header: `${repoSlug(ref)}/${params.path}` } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const path = args.path || "...";
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "";
			const display = `${repo}/${path}`;
			const url = args.repository ? `${args.repository.replace(/\/$/, "")}/blob/HEAD/${path}` : "";
			const linked = url ? osc8Link(url, display) : display;
			text.setText(theme.fg("toolTitle", theme.bold("read_github ")) + theme.fg("dim", linked));
			return text;
		},

		renderResult(result: any, _opts: { expanded: boolean }, _theme: any, context: any) {
			const Container = getContainer();
			const container = context?.lastComponent ?? new Container();
			container.clear();
			const content = result.content?.[0];
			if (!content || content.type !== "text") {
				container.addChild(new Text("(no output)", 0, 0));
				return container;
			}

			// parse numbered lines into BoxLine[] with gutters
			const parsed: BoxLine[] = content.text.split("\n").map((line: string) => {
				const m = line.match(/^(\s*\d+): (.*)$/);
				if (m) return { gutter: m[1].trim(), text: m[2], highlight: true };
				return { text: line, highlight: true };
			});

			const section: BoxSection = { blocks: [{ lines: parsed }] };
			const renderer = boxRendererWindowed(
				() => [section],
				{ collapsed: { excerpts: COLLAPSED_EXCERPTS }, expanded: {} },
			);
			container.addChild(renderer);
			return container;
		},
	};
}

// --- search_github ---

/**
 * GitHub code search's `path:` is a directory prefix: `path:dir/file.sh`
 * matches nothing, while `path:dir filename:file.sh` finds the file. A last
 * segment with an extension (a dot not in first position) is taken as a file
 * name, so `.github` stays a directory.
 */
export function searchPathQualifier(p: string): string {
	const trimmed = p.replace(/^\/+|\/+$/g, "");
	if (!trimmed) return "";
	const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
	const slash = trimmed.lastIndexOf("/");
	const base = trimmed.slice(slash + 1);
	if (!/^[^.].*\.[^.]+$/.test(base)) return `path:${quote(trimmed)}`;
	return slash === -1 ? `filename:${quote(base)}` : `path:${quote(trimmed.slice(0, slash))} filename:${quote(base)}`;
}

export function createSearchGithubTool(): ToolDefinition {
	return {
		name: "search_github",
		label: "Search GitHub",
		description:
			"Search code in a REMOTE GitHub repository over the API. Requires `repository`. " +
			"This never looks at the local working copy — to search the code in this session use `grep`.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- Finding code patterns in a repository you have NOT cloned locally\n" +
			"- Understanding how some other project implements something\n\n" +
			"Supports GitHub search qualifiers (language:, path:, extension:, etc.).",

		parameters: Type.Object({
			pattern: Type.String({
				description: "The search pattern. Supports GitHub search operators (AND, OR, NOT) and qualifiers.",
			}),
			repository: REPOSITORY_PARAM,
			path: Type.Optional(Type.String({ description: "Optional directory or file path to limit the search to" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 30, max: 100)", minimum: 1, maximum: 100 })),
			offset: Type.Optional(Type.Number({ description: "Results to skip for pagination (default: 0)", minimum: 0 })),
		}),

		async execute(_id, params) {
			try {
				const repo = requireRepository(params as any, "search_github", "grep");
				if ("error" in repo) return repo.error;
				const ref = parseRepoUrl(repo.value);
				const slug = canonicalRepoSlug(ref);
				const note = renameNote(ref, slug);
				const limit = params.limit ?? 30;
				let query = `${params.pattern} repo:${slug}`;
				const pathQualifier = params.path ? searchPathQualifier(params.path) : "";
				if (pathQualifier) query += ` ${pathQualifier}`;

				let total = 0;
				const items = fetchWindow(params.offset ?? 0, limit, (page, perPage) => {
					const data = ghApi<any>("search/code", {
						params: { q: query, per_page: perPage, page },
						accept: "application/vnd.github.text-match+json",
					});
					total = data.total_count ?? 0;
					return data.items ?? [];
				});

				if (items.length === 0) {
					return {
						content: [{
							type: "text" as const,
							text:
								note +
								`No results for "${params.pattern}" in ${slug} (query: ${query}). ` +
								"GitHub code search covers only the default branch and skips large files, so a miss " +
								"is not proof of absence — read_github the file to confirm.",
						}],
					};
				}

				const results: string[] = [`${note}Found ${total} results (showing ${items.length}):\n`];

				for (const item of items) {
					results.push(`## ${item.path}`);
					if (item.text_matches) {
						for (const match of item.text_matches) {
							if (match.fragment) {
								results.push("```");
								results.push(match.fragment);
								results.push("```");
							}
						}
					}
					results.push("");
				}

				return { content: [{ type: "text" as const, text: truncate(results.join("\n"), 64_000) }], details: { header: `/${params.pattern}/ in ${slug}` } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const pattern = args.pattern || "...";
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "";
			const linkedRepo = args.repository ? osc8Link(args.repository, repo) : repo;
			text.setText(theme.fg("toolTitle", theme.bold("search_github ")) + theme.fg("dim", `/${pattern}/ in ${linkedRepo}`));
			return text;
		},

		renderResult: renderBoxedText,
	};
}

// --- list_directory_github ---

export function createListDirectoryGithubTool(): ToolDefinition {
	return {
		name: "list_directory_github",
		label: "List Directory GitHub",
		description:
			"List the contents of a directory in a GitHub repository.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to understand the structure of a directory\n" +
			"- When exploring a codebase to find relevant files\n\n" +
			"Returns files and directories with trailing / for directories.",

		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "The directory path to list (default: the repository root)" })),
			repository: REPOSITORY_PARAM,
			limit: Type.Optional(Type.Number({ description: "Max entries (default: 100, max: 1000)", minimum: 1, maximum: 1000 })),
		}),

		async execute(_id, params) {
			try {
				const repo = requireRepository(params as any, "list_directory_github", "ls");
				if ("error" in repo) return repo.error;
				const ref = parseRepoUrl(repo.value);
				const limit = params.limit ?? 100;
				const apiPath = !params.path || params.path === "." || params.path === "/" ? "" : params.path;

				const data = ghApi<any[]>(`repos/${repoSlug(ref)}/contents/${apiPath}`);

				if (!Array.isArray(data)) {
					return { content: [{ type: "text" as const, text: "Path is a file, not a directory. Use read_github instead." }], isError: true };
				}

				const entries = data.slice(0, limit).map((item: any) => {
					const suffix = item.type === "dir" ? "/" : "";
					const size = item.type === "file" && item.size ? ` (${item.size} bytes)` : "";
					return `${item.name}${suffix}${size}`;
				});

				return { content: [{ type: "text" as const, text: entries.join("\n") }], details: { header: `${repoSlug(ref)}/${apiPath}` } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const path = args.path || "/";
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "";
			const display = `${repo}/${path}`;
			const url = args.repository ? `${args.repository.replace(/\/$/, "")}/tree/HEAD/${path}` : "";
			const linked = url ? osc8Link(url, display) : display;
			text.setText(theme.fg("toolTitle", theme.bold("list_directory_github ")) + theme.fg("dim", linked));
			return text;
		},

		renderResult: renderBoxedText,
	};
}

// --- list_repositories ---

export function createListRepositoriesTool(): ToolDefinition {
	return {
		name: "list_repositories",
		label: "List Repositories",
		description:
			"List and search for repositories on GitHub.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to find repositories by name\n" +
			"- When exploring repositories in an organization\n" +
			"- When you need repository metadata (stars, forks, descriptions)\n\n" +
			"Results come from GitHub repository search sorted by stars, and include private repositories " +
			"your gh login can see. Pass `pattern` and/or `organization`; with neither it lists GitHub's most-starred repositories.",

		parameters: Type.Object({
			pattern: Type.Optional(Type.String({ description: "Pattern to match in repository names" })),
			organization: Type.Optional(Type.String({ description: "Organization name to filter" })),
			language: Type.Optional(Type.String({ description: "Programming language to filter" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 30, max: 100)", minimum: 1, maximum: 100 })),
			offset: Type.Optional(Type.Number({ description: "Results to skip (default: 0)", minimum: 0 })),
		}),

		async execute(_id, params) {
			try {
				const limit = params.limit ?? 30;
				const queryParts: string[] = [];
				if (params.pattern) queryParts.push(params.pattern);
				if (params.organization) queryParts.push(`org:${params.organization}`);
				if (params.language) queryParts.push(`language:${params.language}`);
				if (queryParts.length === 0) queryParts.push("stars:>0");

				let total = 0;
				const items = fetchWindow(params.offset ?? 0, limit, (page, perPage) => {
					const data = ghApi<any>("search/repositories", {
						params: { q: queryParts.join(" "), sort: "stars", per_page: perPage, page },
					});
					total = data.total_count ?? 0;
					return data.items ?? [];
				});

				if (items.length === 0) {
					return { content: [{ type: "text" as const, text: "No repositories found." }] };
				}

				const lines: string[] = [`Found ${total} repositories (showing ${items.length}):\n`];
				for (const repo of items) {
					lines.push(`## ${repo.full_name}`);
					if (repo.description) lines.push(repo.description);
					const meta = [
						repo.language,
						`★ ${repo.stargazers_count}`,
						`forks: ${repo.forks_count}`,
					].filter(Boolean).join(" · ");
					lines.push(meta);
					lines.push(`${repo.html_url}\n`);
				}

				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { header: queryParts.join(" ") } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const query = args.pattern || args.organization || "...";
			text.setText(theme.fg("toolTitle", theme.bold("list_repositories ")) + theme.fg("dim", query));
			return text;
		},

		renderResult: renderBoxedText,
	};
}

// --- glob_github ---

export function createGlobGithubTool(): ToolDefinition {
	return {
		name: "glob_github",
		label: "Glob GitHub",
		description:
			"Find files matching a glob pattern in a GitHub repository.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to find specific file types (e.g., all TypeScript files)\n" +
			"- When exploring codebase structure quickly\n\n" +
			"Uses the git tree API to list all files, then filters by pattern.\n\n" +
			"Pass the glob pattern as `filePattern` (or its alias `pattern`) — one of the two is required.",

		// `filePattern` is the canonical name, but models overwhelmingly guess
		// `pattern` (matching grep/glob conventions) and then fail schema validation.
		// both are accepted; at least one is required, enforced in execute().
		parameters: Type.Object({
			filePattern: Type.Optional(
				Type.String({ description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.test.js")' }),
			),
			pattern: Type.Optional(
				Type.String({ description: "Alias for filePattern." }),
			),
			repository: REPOSITORY_PARAM,
			limit: Type.Optional(Type.Number({ description: "Max results (default: 100)" })),
			offset: Type.Optional(Type.Number({ description: "Results to skip (default: 0)" })),
		}),

		async execute(_id, params) {
			try {
				const filePattern = params.filePattern ?? params.pattern;
				if (!filePattern) {
					return {
						content: [{ type: "text" as const, text: 'Missing glob pattern: pass "filePattern" (or "pattern").' }],
						isError: true,
					};
				}
				const repo = requireRepository(params as any, "glob_github", "find");
				if ("error" in repo) return repo.error;
				const ref = parseRepoUrl(repo.value);
				const limit = params.limit ?? 100;
				const offset = params.offset ?? 0;

				// get default branch
				const repoData = ghApi<any>(`repos/${repoSlug(ref)}`);
				const branch = repoData.default_branch || "main";

				// get full tree
				const tree = ghApi<any>(`repos/${repoSlug(ref)}/git/trees/${branch}?recursive=1`);

				if (!tree.tree) {
					return { content: [{ type: "text" as const, text: "Could not read repository tree." }], isError: true };
				}

				// filter by glob pattern using simple matching
				const pattern = filePattern;
				const files = tree.tree
					.filter((item: any) => item.type === "blob")
					.map((item: any) => item.path as string)
					.filter((path: string) => matchGlob(path, pattern));

				const total = files.length;
				const sliced = files.slice(offset, offset + limit);

				const output = [
					`Found ${total} files matching "${pattern}" (showing ${sliced.length}):`,
					"",
					...sliced,
				];

				return { content: [{ type: "text" as const, text: output.join("\n") }], details: { header: `${pattern} in ${repoSlug(ref)}` } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const pattern = args.filePattern || args.pattern || "...";
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "";
			const linkedRepo = args.repository ? osc8Link(args.repository, repo) : repo;
			text.setText(theme.fg("toolTitle", theme.bold("glob_github ")) + theme.fg("dim", `${pattern} in ${linkedRepo}`));
			return text;
		},

		renderResult: renderBoxedText,
	};
}

// --- commit_search ---

// commit search returns local offsets with milliseconds, the commits list returns UTC: show one format.
function utcDate(raw: unknown): string {
	if (typeof raw !== "string" || !raw) return "";
	const d = new Date(raw);
	return Number.isNaN(d.getTime()) ? raw : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function createCommitSearchTool(): ToolDefinition {
	return {
		name: "commit_search",
		label: "Commit Search",
		description:
			"Search commit history in a GitHub repository.\n\n" +
			"With `query`, searches commit messages across the full history of the default branch " +
			"(GitHub commit search); `path` cannot be combined with `query`. Without `query`, lists " +
			"commits newest first, filtered by author, dates and path.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to understand how code evolved over time\n" +
			"- When looking for commits by a specific author or date range\n" +
			"- When finding commits that changed specific files",

		parameters: Type.Object({
			repository: REPOSITORY_PARAM,
			query: Type.Optional(Type.String({ description: "Text to search for in commit messages (full history)" })),
			author: Type.Optional(Type.String({ description: "Filter by author username (or email when listing without query)" })),
			since: Type.Optional(Type.String({ description: 'ISO 8601 date for earliest commit (e.g., "2024-01-01T00:00:00Z")' })),
			until: Type.Optional(Type.String({ description: 'ISO 8601 date for latest commit (e.g., "2024-02-01T00:00:00Z")' })),
			path: Type.Optional(Type.String({ description: "Filter commits that changed specific files/directories" })),
			limit: Type.Optional(Type.Number({ description: "Max commits (default: 50, max: 100)", minimum: 1, maximum: 100 })),
			offset: Type.Optional(Type.Number({ description: "Commits to skip (default: 0)", minimum: 0 })),
		}),

		async execute(_id, params) {
			try {
				const repo = requireRepository(params as any, "commit_search", "bash (git log)");
				if ("error" in repo) return repo.error;
				const ref = parseRepoUrl(repo.value);
				const limit = params.limit ?? 50;
				const offset = params.offset ?? 0;
				if (params.query && params.path) {
					return {
						content: [{
							type: "text" as const,
							text: "commit_search: `query` searches the whole history but GitHub commit search cannot filter by path. " +
								"Drop `path` to search messages, or drop `query` to list the commits that touched the path.",
						}],
						isError: true,
					};
				}

				let commits: any[];
				let note = "";
				if (params.query) {
					const slug = canonicalRepoSlug(ref);
					note = renameNote(ref, slug);
					const q = [params.query, `repo:${slug}`];
					if (params.author) q.push(`author:${params.author}`);
					if (params.since) q.push(`committer-date:>=${params.since}`);
					if (params.until) q.push(`committer-date:<=${params.until}`);
					commits = fetchWindow(offset, limit, (page, perPage) =>
						ghApi<any>("search/commits", {
							params: { q: q.join(" "), sort: "committer-date", order: "desc", per_page: perPage, page },
						}).items ?? [],
					);
				} else {
					const filters: Record<string, string> = {};
					if (params.author) filters.author = params.author;
					if (params.since) filters.since = params.since;
					if (params.until) filters.until = params.until;
					if (params.path) filters.path = params.path;
					commits = fetchWindow(offset, limit, (page, perPage) => {
						const data = ghApi<any[]>(`repos/${repoSlug(ref)}/commits`, { params: { ...filters, per_page: perPage, page } });
						return Array.isArray(data) ? data : [];
					});
				}

				if (commits.length === 0) {
					return { content: [{ type: "text" as const, text: `${note}No commits found.` }] };
				}

				const lines: string[] = [`${note}Found ${commits.length} commits:\n`];
				for (const c of commits) {
					const sha = c.sha?.slice(0, 7) ?? "???????";
					const author = c.commit?.author?.name ?? c.author?.login ?? "unknown";
					const date = utcDate(c.commit?.author?.date);
					const msg = c.commit?.message?.split("\n")[0] ?? "";
					lines.push(`${sha} ${date} (${author}) ${msg}`);
				}

				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { header: repoSlug(ref) } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "...";
			const linkedRepo = args.repository ? osc8Link(args.repository, repo) : repo;
			const query = args.query || args.author || "";
			text.setText(theme.fg("toolTitle", theme.bold("commit_search ")) + theme.fg("dim", `${linkedRepo} ${query}`.trim()));
			return text;
		},

		renderResult: renderBoxedText,
	};
}

// --- diff ---

export function createDiffTool(): ToolDefinition {
	return {
		name: "diff",
		label: "Diff",
		description:
			"Get a diff between two commits, branches, or tags in a GitHub repository.\n\n" +
			"WHEN TO USE THIS TOOL:\n" +
			"- When you need to see what changed between two points in history\n" +
			"- When reviewing changes across branches\n" +
			"- When understanding the scope of a release",

		parameters: Type.Object({
			base: Type.String({ description: 'The base ref to compare from (e.g., "main", "v1.0.0", or commit SHA)' }),
			head: Type.String({ description: 'The head ref to compare to (e.g., "feature-branch", "v2.0.0", or commit SHA)' }),
			repository: REPOSITORY_PARAM,
			includePatches: Type.Optional(Type.Boolean({
				description: "Include unified diff patches per file (token heavy). Default false.",
			})),
		}),

		async execute(_id, params) {
			try {
				const repo = requireRepository(params as any, "diff", "bash (git diff)");
				if ("error" in repo) return repo.error;
				const ref = parseRepoUrl(repo.value);
				const data = ghApi<any>(
					`repos/${repoSlug(ref)}/compare/${encodeURIComponent(params.base)}...${encodeURIComponent(params.head)}`,
				);

				const lines: string[] = [
					`Comparing ${params.base}...${params.head}`,
					`Status: ${data.status}`,
					`Ahead by: ${data.ahead_by} commits`,
					`Behind by: ${data.behind_by} commits`,
					`Changed files: ${data.files?.length ?? 0}`,
					"",
				];

				if (data.files) {
					for (const file of data.files) {
						const stat = `+${file.additions} -${file.deletions}`;
						lines.push(`${file.status} ${file.filename} (${stat})`);

						if (params.includePatches && file.patch) {
							lines.push("```diff");
							lines.push(truncate(file.patch, 4000));
							lines.push("```");
							lines.push("");
						}
					}
				}

				return { content: [{ type: "text" as const, text: truncate(lines.join("\n"), 64_000) }], details: { header: `${params.base}...${params.head}` } };
			} catch (e: any) {
				return { content: [{ type: "text" as const, text: e.message }], isError: true };
			}
		},

		renderCall(args: any, theme: any, context: any) {
			const Text = getText();
			const text = context?.lastComponent ?? new Text("", 0, 0);
			const repo = args.repository ? args.repository.replace(/^https?:\/\/github\.com\//, "") : "...";
			const linkedRepo = args.repository ? osc8Link(args.repository, repo) : repo;
			const range = `${args.base || "?"}...${args.head || "?"}`;
			text.setText(theme.fg("toolTitle", theme.bold("diff ")) + theme.fg("dim", `${linkedRepo} ${range}`));
			return text;
		},

		renderResult: renderBoxedText,
	};
}

// --- glob matching (simple, no external deps) ---

/** must stay one-pass: chained replace() rewrites globstar to a `?` quantifier that the later `?` rule then mangles. */
export function matchGlob(path: string, pattern: string): boolean {
	let regexStr = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					// "**/" matches zero or more directories
					regexStr += "(?:[^/]*/)*";
					i += 2;
				} else {
					regexStr += ".*";
					i += 1;
				}
			} else {
				regexStr += "[^/]*";
			}
		} else if (char === "?") {
			regexStr += "[^/]";
		} else {
			// escape every regex metacharacter literally
			regexStr += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	try {
		return new RegExp(`^${regexStr}$`).test(path);
	} catch {
		return path.includes(pattern.replace(/[*?]/g, ""));
	}
}
