/**
 * No Sleep While Working Extension
 *
 * Prevents the computer from going to sleep while pi is actively working on a
 * task. Spawns `caffeinate -i -d` when the agent starts and kills it when the
 * agent finishes (or the session shuts down).
 *
 * -i  prevents idle sleep
 * -d  prevents display sleep (keeps USB/network connections alive)
 *
 * Requires: macOS (caffeinate is a built-in macOS utility).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let caffeinateController: AbortController | null = null;

	function startCaffeinate() {
		if (caffeinateController) return;

		const { spawn } = require("node:child_process") as typeof import("node:child_process");

		let proc: import("node:child_process").ChildProcess | undefined;

		const ac = new AbortController();
		caffeinateController = ac;
		ac.signal.onabort = () => {
			caffeinateController = null;
			try {
				if (proc && proc.pid && !proc.killed) {
					proc.kill();
				}
			} catch (error) {
				console.error("[no-sleep-while-working] Failed to kill caffeinate process:", error);
			}
		};

		try {
			// -i prevents idle sleep, -d prevents display sleep
			// Without -d, USB wired network connections can drop
			proc = spawn("caffeinate", ["-i", "-d"], {
				stdio: "ignore",
				detached: false,
				signal: ac.signal,
			});

			proc.on("error", (error) => {
				if (error.name === "AbortError") return;
				console.error("[no-sleep-while-working] Caffeinate process error:", error);
				ac.abort();
			});

			proc.on("exit", (code) => {
				if (code) console.error(`[no-sleep-while-working] Caffeinate process exited with non-zero status ${code}`);
				ac.abort();
			});
		} catch (error) {
			console.error("[no-sleep-while-working] Failed to start caffeinate:", error);
			ac.abort();
		}
	}

	function stopCaffeinate() {
		caffeinateController?.abort();
	}

	pi.on("agent_start", async () => {
		startCaffeinate();
	});

	pi.on("agent_end", async () => {
		stopCaffeinate();
	});

	pi.on("session_shutdown", async () => {
		stopCaffeinate();
	});
}
