/**
 * sub-agent inspector — step inside a running or finished sub-agent.
 *
 * ctrl+shift+a (or /subagents) opens an overlay listing every sub-agent run
 * in this session. enter opens one: its thinking, its tool calls, its tool
 * results, scrollable. ←/→ switch between runs, esc backs out.
 *
 * READ-ONLY. it observes the transcripts the sub-agent tools already attach
 * to their results — no session files are written, no child is resumed, and
 * nothing is sent to a running process.
 *
 * NO CORE PATCHES. everything here is public extension API: `pi.on`,
 * `pi.registerShortcut`, `pi.registerCommand`, `ctx.ui.custom`.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SubAgentInspector } from "./inspector";
import { AgentRegistry } from "./registry";

const SHORTCUT = "ctrl+shift+a";

export default function subAgentInspectorExtension(pi: ExtensionAPI): void {
	const registry = new AgentRegistry();

	pi.on("tool_execution_start", (event) => {
		registry.handleStart(event);
	});
	pi.on("tool_execution_update", (event) => {
		registry.handleUpdate(event);
	});
	pi.on("tool_execution_end", (event) => {
		registry.handleEnd(event);
	});

	async function open(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;

		await ctx.ui.custom<null>(
			(tui, theme, _keybindings, done) => {
				const inspector = new SubAgentInspector(() => registry.list(), theme, done);

				// a sub-agent that is still running keeps pushing updates while the
				// overlay is open; repaint on each one so the view is live.
				registry.onChange = () => {
					inspector.invalidate();
					tui.requestRender();
				};

				return {
					render: (width: number) => inspector.render(width),
					handleInput: (data: string) => {
						inspector.handleInput(data);
						tui.requestRender();
					},
					invalidate: () => inspector.invalidate(),
					dispose: () => {
						registry.onChange = undefined;
					},
					get focused() {
						return inspector.focused;
					},
					set focused(value: boolean) {
						inspector.focused = value;
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					// full-bleed: the inspector should read like the agent view it
					// is showing, not like a dialog floating over it.
					anchor: "top-left",
					row: 0,
					col: 0,
					width: "100%",
					maxHeight: "100%",
				},
			},
		);
	}

	pi.registerShortcut(SHORTCUT, {
		description: "Inspect sub-agents",
		handler: open,
	});

	pi.registerCommand("subagents", {
		description: "Inspect sub-agent transcripts (thinking, tool calls, results)",
		handler: (_args, ctx) => open(ctx),
	});
}
