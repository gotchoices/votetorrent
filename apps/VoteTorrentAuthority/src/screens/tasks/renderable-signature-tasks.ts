import type { ISignatureTasksEngine, SignatureTask, SigningStatus } from "@votetorrent/vote-core";

/**
 * renderable-signature-tasks.ts — the ONE shared inbox filter used by both `TasksScreen` and
 * `useTaskCount` (62-12). Moved here, verbatim in rationale, from the 48-11/48-18 comment block
 * that used to live inline in both consumers:
 *
 * 'registrant' signature tasks are filtered out of BOTH the inbox list and the badge count, for
 * three reasons —
 *   1. `SignatureTaskScreen` enumerates six signature types in its `titleKey` record and its
 *      `signatureType` switch, and deliberately does not add a seventh: the registration-approval
 *      ceremony is a standalone screen with a screen-local gate (the D-07 checklist)
 *      `SignatureTaskScreen` has no equivalent of. A 'registrant' `TaskCard` here would navigate
 *      to a screen with no title and no details branch — a dead end presenting as a defect.
 *   2. Registration review needs the request payload, the bridge provenance callout, and the
 *      prior-rejection history. A generic task card carries none of it, so even a "working" row
 *      would be the wrong surface.
 *   3. The Registration Requests inbox (48-18) is the single canonical surface for this decision.
 *      Two entry points to one decision, one of which shows strictly less, is exactly how an
 *      officer approves without seeing a prior rejection.
 *
 * D-11 extends the rule by one paragraph: a session the engine reports `unreachable` ALSO takes
 * the existing closed-task path — it leaves the inbox list AND the badge count together, exactly
 * like a 'registrant' task, because `getRequestedSignatures(true)` never closes an unreachable
 * session's remaining Task itself; the UI filter does the hiding. The badge and the list are
 * counting (and rendering) the SAME population deliberately: a badge reading 3 over a list
 * rendering 2 is a legibility defect, and TasksScreen's and useTaskCount's filters must be
 * changed together or not at all — now enforced structurally, since both call this ONE module.
 */
export interface RenderableSignatureTask {
	task: SignatureTask;
	status: SigningStatus | null;
}

/**
 * Never-throw status loader. `null` means "render the task with no progress note" — a read
 * failure, a missing method (an older/mock engine), or a thrown/rejected read must NEVER hide a
 * task: fail-open is deliberate here, the opposite of 'unreachable' (which is an explicit,
 * engine-derived signal, not a read failure).
 */
export async function loadTaskSigningStatus(
	engine: ISignatureTasksEngine | undefined,
	task: SignatureTask
): Promise<SigningStatus | null> {
	try {
		if (!engine || typeof engine.getTaskSigningStatus !== "function") {
			return null;
		}
		return (await engine.getTaskSigningStatus(task)) ?? null;
	} catch {
		// Fail-open: an unreadable status must never hide a task. Deliberately logs nothing about
		// the task (62-12 T-62-12-06 — no task payload in logs).
		return null;
	}
}

/**
 * Pure selection: drops 'registrant' tasks and tasks whose status is explicitly `unreachable`.
 * A `null` status is KEPT (fail-open — see `loadTaskSigningStatus`). Preserves input order
 * (D-04 of phase 7: no sort).
 */
export function selectRenderableSignatureTasks(
	tasks: SignatureTask[],
	statuses: Array<SigningStatus | null>
): RenderableSignatureTask[] {
	const result: RenderableSignatureTask[] = [];
	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i]!;
		const status = statuses[i] ?? null;
		if (task.signatureType === "registrant") continue;
		if (status?.unreachable === true) continue;
		result.push({ task, status });
	}
	return result;
}

/**
 * Loads statuses for every non-registrant task (registrant tasks get `null` without a status
 * call, since they are dropped by `selectRenderableSignatureTasks` regardless), then returns the
 * renderable list.
 */
export async function loadRenderableSignatureTasks(
	engine: ISignatureTasksEngine,
	tasks: SignatureTask[]
): Promise<RenderableSignatureTask[]> {
	const statuses = await Promise.all(
		tasks.map((task) => (task.signatureType === "registrant" ? Promise.resolve(null) : loadTaskSigningStatus(engine, task)))
	);
	return selectRenderableSignatureTasks(tasks, statuses);
}
