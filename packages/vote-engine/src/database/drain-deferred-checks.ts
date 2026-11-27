import type { Database } from '@quereus/quereus';

/**
 * Evaluate every deferred row constraint queued so far in the open transaction, now, and empty
 * the queue.
 *
 * A CHECK that contains a subquery is deferred to COMMIT, so at COMMIT it sees rows the same
 * transaction inserted LATER. The engine calls this right after an insert whose CHECK must judge
 * the table as it stands at that insert (Admin before its Officer rows, each signature-task pair
 * during fan-out). The transaction stays open and atomic: a failing check throws here, and the
 * caller rolls back as for any other failed statement.
 *
 * Quereus 4.x exposed this as `Database.runDeferredRowConstraints()`. 5.0.0 removed that method
 * (ticket debt-connection-lifecycle-contract-check) and kept the queue it called,
 * `getDeferredConstraints().runDeferredRows()`, which is not in the published types. So this
 * reaches the queue directly and refuses loudly if a later Quereus removes it too, never
 * silently skipping the drain (that would move these checks back to COMMIT and change verdicts).
 */
export async function drainDeferredChecks(db: Database): Promise<void> {
	const host = db as unknown as DeferredQueueHost;
	const queue = host.getDeferredConstraints?.();
	if (!queue || typeof queue.runDeferredRows !== 'function') {
		throw new Error(
			'drainDeferredChecks: this @quereus/quereus build has no getDeferredConstraints().runDeferredRows(); '
			+ 'the engine cannot evaluate deferred CHECKs before COMMIT. Re-check the Quereus upgrade.'
		);
	}
	if (!host.transactionManager || typeof host.transactionManager.changeLogRowExists !== 'function') {
		throw new Error(
			'drainDeferredChecks: this @quereus/quereus build has no transactionManager.changeLogRowExists(); '
			+ '5.7 requires a row-existence predicate to drain deferred CHECKs. Re-check the Quereus upgrade.'
		);
	}
	await queue.runDeferredRows((identity) =>
		host.transactionManager!.changeLogRowExists!(identity.tableKey, identity.primaryKey)
	);
}

interface DeferredQueueHost {
	getDeferredConstraints?: () => {
		runDeferredRows?: (rowExists: (identity: { tableKey: string; primaryKey: string }) => boolean) => Promise<void>
	} | undefined;
	transactionManager?: { changeLogRowExists?: (baseTable: string, pkKey: string) => boolean };
}
