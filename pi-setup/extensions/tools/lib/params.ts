/**
 * tolerant parameter resolution for sub-agent tools.
 *
 * WHY THIS EXISTS
 * our sub-agent tools historically used a different name for the same concept:
 *
 *   finder       -> query
 *   librarian    -> query
 *   oracle       -> task
 *   code_review  -> diff_description
 *   Task         -> prompt
 *
 * a model that just called oracle({ task }) then calls code_review({ task }) and
 * gets "must have required properties diff_description". it retries and usually
 * self-corrects, but that wastes a whole turn and, for tools whose failure is
 * silent rather than loud, produces subtly wrong behaviour.
 *
 * rather than renaming the params (each is semantically meaningful in its own
 * tool), each tool declares its canonical name plus the aliases models actually
 * guess. the canonical name stays first in the schema and is documented as
 * required; `resolveParam` picks the first non-empty value.
 *
 * NOTE: the canonical field must be declared Optional in the TypeBox schema,
 * otherwise pi rejects an aliased call during validation, before execute() runs
 * and has any chance to recover.
 */

/** pick the first non-empty string among `names`, in priority order. */
export function resolveParam(
	params: Record<string, unknown>,
	names: readonly string[],
): string | undefined {
	for (const name of names) {
		const value = params[name];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

/**
 * resolve a required parameter, or return a ready-to-return error result naming
 * the canonical parameter (names[0]) so the model can correct itself in one step.
 */
export function requireParam(
	params: Record<string, unknown>,
	names: readonly string[],
	toolName: string,
): { value: string } | { error: { content: { type: "text"; text: string }[]; isError: true } } {
	const value = resolveParam(params, names);
	if (value !== undefined) return { value };
	const [canonical, ...aliases] = names;
	const aliasHint = aliases.length > 0 ? ` (aliases accepted: ${aliases.join(", ")})` : "";
	return {
		error: {
			content: [
				{
					type: "text" as const,
					text: `${toolName}: missing required parameter "${canonical}"${aliasHint}.`,
				},
			],
			isError: true as const,
		},
	};
}
