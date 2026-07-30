// deterministic tool-introspection probe. type-only import => no runtime resolution needed.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const dump = (label: string) => {
		try {
			const active = pi.getActiveTools();
			process.stderr.write(`[PROBE:${label}] count=${active.length} :: ${active.sort().join(",")}\n`);
		} catch (e: any) {
			process.stderr.write(`[PROBE:${label}] ERROR ${e?.message}\n`);
		}
	};
	// probe what is REGISTERED by trying to activate a known-custom name
	const probeRegistered = (names: string[]) => {
		try {
			const before = pi.getActiveTools();
			pi.setActiveTools(names);
			const after = pi.getActiveTools();
			process.stderr.write(`[PROBE:registered?] asked=${names.join(",")} => got(${after.length})=${after.sort().join(",")}\n`);
			pi.setActiveTools(before); // restore
		} catch (e: any) {
			process.stderr.write(`[PROBE:registered?] ERROR ${e?.message}\n`);
		}
	};
	pi.on("session_start", async () => dump("session_start"));
	pi.on("before_agent_start", async () => {
		dump("before_agent_start");
		const want = process.env.PI_PROBE_NAMES;
		if (want) probeRegistered(want.split(",").map((s) => s.trim()).filter(Boolean));
	});
}
