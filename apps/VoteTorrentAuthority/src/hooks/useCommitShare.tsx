/**
 * useCommitShare -- which of this phone's writes no other member of the network holds yet
 * (todo 2026-09-11-optimystic-commit-success-hides-unresolvable-cohort).
 *
 * CadreNodeProvider owns one CommitDurabilityTracker (vote-engine), attached to the live node's
 * `strand:commit-durability` / `strand:commit-held` events, and publishes it through
 * CommitShareContext. The context defaults to null, so a screen rendered without the provider
 * (most screen tests) reads 'unknown' / 0 and shows nothing -- it never throws.
 *
 * In-memory only: after a restart nothing is known about earlier writes, so nothing is shown.
 */
import React, {createContext, useCallback, useContext, useSyncExternalStore} from 'react';
import type {PropsWithChildren} from 'react';
import type {ActionShareState, CommitDurabilityTracker} from '@votetorrent/vote-engine/rn';

export const CommitShareContext = createContext<CommitDurabilityTracker | null>(null);

export function CommitShareProvider({tracker, children}: PropsWithChildren<{tracker: CommitDurabilityTracker}>) {
	return <CommitShareContext.Provider value={tracker}>{children}</CommitShareContext.Provider>;
}

/** The tracker, or null outside the provider. */
export function useCommitShareTracker(): CommitDurabilityTracker | null {
	return useContext(CommitShareContext);
}

const noopSubscribe = () => () => undefined;

/** How many commits on this phone no other member holds yet. 0 without a tracker. */
export function useUnsharedCommitCount(): number {
	const tracker = useContext(CommitShareContext);
	const subscribe = useCallback((cb: () => void) => (tracker ? tracker.subscribe(cb) : noopSubscribe()), [tracker]);
	return useSyncExternalStore(subscribe, () => (tracker ? tracker.unsharedCount : 0));
}

/** One tracked action's state; 'unknown' without a tracker, without a key, or before it committed. */
export function useActionShareState(actionKey: string | null): ActionShareState {
	const tracker = useContext(CommitShareContext);
	const subscribe = useCallback((cb: () => void) => (tracker ? tracker.subscribe(cb) : noopSubscribe()), [tracker]);
	return useSyncExternalStore(subscribe, () => (tracker && actionKey ? tracker.actionState(actionKey) : 'unknown'));
}

/** Run `fn` attributed to `actionKey`, or just run it when there is no tracker. */
export function trackCommits<T>(tracker: CommitDurabilityTracker | null, actionKey: string, fn: () => Promise<T>): Promise<T> {
	return tracker ? tracker.track(actionKey, fn) : fn();
}

/** How many tracked actions under `prefix` (e.g. 'decision:') are still held only on this phone. */
export function useWaitingActionCount(prefix: string): number {
	const tracker = useContext(CommitShareContext);
	const subscribe = useCallback((cb: () => void) => (tracker ? tracker.subscribe(cb) : noopSubscribe()), [tracker]);
	return useSyncExternalStore(subscribe, () => (tracker ? tracker.waitingActionCount(prefix) : 0));
}
