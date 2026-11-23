import type { NetworkReference } from "@votetorrent/vote-core";

/**
 * D-01/D-02/D-03 support module for AddNetworkScreen's `handleCreate`.
 *
 * Why the recents diff and nothing else (hard constraint): `NetworksEngine.create()` mints its
 * hash internally (`crypto.randomUUID()` -> `H16()`) and never exposes it until `commit()`
 * resolves, so there is no hash to probe with. Worse, `NetworksEngine.open()` is NOT
 * side-effect-free on a cache miss — it calls `dbFactory(ref.hash)`, which can run `initDB`, and
 * `rnDbFactory` opens with `createIfMissing: true`, so probing an unknown hash would mint an
 * empty on-disk store under it. `getRecentNetworks()` is a bare
 * `localStorage.getItem('recentNetworks')` — no `Database`, no `dbFactory`, no DDL. Never use
 * `open()` as an existence probe anywhere in this reconciliation path.
 */

/** The reconciliation's own deadline (D-01) — deliberately shorter than CREATE_TIMEOUT_MS
 * (45000): by the time this runs the officer has already waited one full commit budget, and the
 * read it bounds is a single AsyncStorage fetch. Assumption (unmeasured): no measured figure
 * exists for an AsyncStorage read on a saturated JS thread; 10s is a generous multiple of a
 * normal (<50ms) read. */
export const RECONCILE_TIMEOUT_MS = 10_000;

/** Own-property key marking a deadline rejection produced by `createStepTimeoutError`. */
export const NETWORK_CREATE_STEP_TIMEOUT = "networkCreateStepTimeout";

/**
 * Builds an Error carrying `message` verbatim plus an own property keyed
 * `NETWORK_CREATE_STEP_TIMEOUT` whose value is `step`. `Object.assign(new Error(...), {...})`,
 * not an Error subclass — `instanceof` across a subclassed built-in is not reliable under
 * Babel/Hermes, and the existing suite's own idiom for a coded error is
 * `Object.assign(new Error(...), { code: ... })`.
 */
export function createStepTimeoutError(step: string, message: string): Error {
	return Object.assign(new Error(message), { [NETWORK_CREATE_STEP_TIMEOUT]: step });
}

/**
 * Returns the marked step when `err` is a non-null object whose `NETWORK_CREATE_STEP_TIMEOUT`
 * property is a non-empty string; `undefined` for everything else (plain Error, null, a string,
 * a wrong-typed marker).
 */
export function timedOutStep(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const value = (err as Record<string, unknown>)[NETWORK_CREATE_STEP_TIMEOUT];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Returns the last element of `after` whose `hash` is absent from `before` AND whose `name` and
 * `primaryAuthorityDomainName` both equal `expected`'s. Returns `undefined` when nothing matches
 * or when either input is not an array.
 *
 * The name/domain match is what stops an unrelated concurrent recents append from being claimed
 * as ours; `hash` is the only field `create()` mints, so it is the identity key.
 */
export function findLandedNetwork(
	before: NetworkReference[],
	after: NetworkReference[],
	expected: { name: string; primaryAuthorityDomainName: string },
): NetworkReference | undefined {
	if (!Array.isArray(before) || !Array.isArray(after)) return undefined;
	const beforeHashes = new Set(before.map((ref) => ref.hash));
	let match: NetworkReference | undefined;
	for (const ref of after) {
		if (
			!beforeHashes.has(ref.hash) &&
			ref.name === expected.name &&
			ref.primaryAuthorityDomainName === expected.primaryAuthorityDomainName
		) {
			match = ref;
		}
	}
	return match;
}

/**
 * How long the create screen keeps waiting on the ORIGINAL commit promise after its 45 s
 * deadline was missed and a recents reconcile could not confirm the network.
 *
 * Assumption: the Redmi 8 round-3 block was ~2.5 min (62-HUMAN-UAT.md test 9) and 58-08 measured
 * whole-create wall clocks of 350-410 s on the same phone, so 10 min covers both with headroom
 * while still ending.
 */
export const LATE_COMMIT_BUDGET_MS = 10 * 60_000;

export type LateCommitOutcome<T> =
	| { status: "landed"; value: T }
	| { status: "failed"; error: unknown }
	| { status: "budget-exhausted" };

/**
 * Bounded wait on a commit that outlived its UI deadline. Total: never throws.
 *
 * It must be given the ORIGINAL `builder.commit()` promise (the one that keeps running after
 * `withTimeout`'s deadline), never a re-raced copy and never `NetworksEngine.open()` (see this
 * file's header: `open()` is never an existence probe).
 */
export async function awaitLateCommit<T>(
	commit: Promise<T>,
	budgetMs: number,
): Promise<LateCommitOutcome<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race<LateCommitOutcome<T>>([
			commit.then(
				(value): LateCommitOutcome<T> => ({ status: "landed", value }),
				(error): LateCommitOutcome<T> => ({ status: "failed", error }),
			),
			new Promise<LateCommitOutcome<T>>((resolve) => {
				timer = setTimeout(() => resolve({ status: "budget-exhausted" }), budgetMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Duplicate-create gate (2026-09-09 todo): a retried CREATE after a "could not confirm" outcome, or
 * a new create started after leaving this screen while the first commit still runs, could mint a
 * second network with the same name and primary authority domain. The identity key is that pair:
 * the name as typed (trimmed) and the domain case-insensitively.
 */
export function networkCreateKey(name: string, primaryAuthorityDomainName: string): string {
	return `${name.trim()}\u0000${primaryAuthorityDomainName.trim().toLowerCase()}`;
}

/** The first recents entry with the same name and primary authority domain, or `undefined`. */
export function findDuplicateNetwork(
	recents: NetworkReference[] | undefined,
	expected: { name: string; primaryAuthorityDomainName: string },
): NetworkReference | undefined {
	if (!Array.isArray(recents)) return undefined;
	const key = networkCreateKey(expected.name, expected.primaryAuthorityDomainName);
	return recents.find(
		(ref) =>
			typeof ref?.name === "string" &&
			networkCreateKey(ref.name, typeof ref.primaryAuthorityDomainName === "string" ? ref.primaryAuthorityDomainName : "") ===
				key,
	);
}

/**
 * Creates whose `commit()` has not settled, by `networkCreateKey`. Module-scoped on purpose: it must
 * outlive the screen, because the officer can leave Add Network while a slow commit keeps running
 * and start the same create again from a fresh screen, before the first one reaches recents.
 */
const createsInFlight = new Map<string, number>();

/** Marks a create in flight; the returned function releases it (idempotent). */
export function markNetworkCreateInFlight(key: string): () => void {
	createsInFlight.set(key, (createsInFlight.get(key) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const left = (createsInFlight.get(key) ?? 1) - 1;
		if (left <= 0) createsInFlight.delete(key);
		else createsInFlight.set(key, left);
	};
}

export function isNetworkCreateInFlight(key: string): boolean {
	return (createsInFlight.get(key) ?? 0) > 0;
}

/** Test-only: forget every in-flight create (module state outlives one test). */
export function resetNetworkCreatesInFlightForTests(): void {
	createsInFlight.clear();
}

