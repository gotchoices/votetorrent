import type { CadreNode } from "@serfab/cadre-core";

/**
 * Post-Connect strand re-probe.
 *
 * Why: cadre-core 1.13.0 throttles the strand-address RPC per (sibling, strand) and stamps it from
 * each sibling's OUTCOME, so a sibling that answered before it held the strand's addresses (even
 * with an empty answer) blinds this phone for the full refresh window (10 min by default). The
 * round-3 UAT (test 15) saw a Connect on an already-open network leave no strand socket for more
 * than 60 s. The root fix (re-ask when a sibling's answer could have changed) stays upstream; see
 * `.planning/todos/pending/2026-09-21-strand-addr-refresh-throttle-blinds-late-joining-siblings.md`.
 *
 * What: after a SUCCESSFUL dial, ask cadre-core for a control-cohort pass via the public
 * `reconcileControlCohort()`, which ends in a strand-peer-address refresh for every running
 * strand. A newly connected sibling has no due time, so it is asked at once.
 *
 * What it does NOT do: it never opens, founds or wakes a strand (D-39: Connect only dials), and it
 * never patches cadre-core. It only refreshes strands that are already running.
 */

export type ReprobeOutcome = {
	status: "reconciled" | "failed" | "timed-out" | "no-strand";
	strands: number;
	connectedStrands: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;

function countStrands(node: Pick<CadreNode, "getStrands">): { strands: number; connectedStrands: number } {
	let strands = 0;
	let connectedStrands = 0;
	try {
		for (const strand of node.getStrands().values()) {
			if (!strand?.libp2pNode) continue;
			strands += 1;
			try {
				if (strand.libp2pNode.getConnections().length > 0) connectedStrands += 1;
			} catch {
				// A strand torn down mid-count is simply not connected.
			}
		}
	} catch {
		// Node stopped between dial and count: report zero.
	}
	return { strands, connectedStrands };
}

export async function reprobeAfterConnect(
	node: Pick<CadreNode, "reconcileControlCohort" | "getStrands">,
	opts?: { timeoutMs?: number },
): Promise<ReprobeOutcome> {
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let settled: "reconciled" | "failed" | "timed-out";
	try {
		const timeout = new Promise<"timed-out">((resolve) => {
			timer = setTimeout(() => resolve("timed-out"), timeoutMs);
		});
		const pass = node.reconcileControlCohort().then(() => "reconciled" as const);
		settled = await Promise.race([pass, timeout]);
		// A late rejection after the timeout must not become an unhandled rejection.
		pass.catch(() => undefined);
	} catch {
		settled = "failed";
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
	const counts = countStrands(node);
	const status: ReprobeOutcome["status"] =
		settled === "reconciled" && counts.strands === 0 ? "no-strand" : settled;
	console.info(
		`[connect] strand re-probe: ${status} strands=${counts.strands} connected=${counts.connectedStrands}`,
	);
	return { status, ...counts };
}
