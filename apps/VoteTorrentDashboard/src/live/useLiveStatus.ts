/**
 * useLiveStatus.ts -- the React bridge from the live boot to components.
 *
 * The boot (the peer layer's runtime) keeps the header status as a cached,
 * frozen view object and the data version as a cached, frozen value; both
 * change by reference only when they actually change. These hooks read them
 * through `useSyncExternalStore`, so a component re-renders exactly when the
 * status view or the data version moves, and never tears between the two
 * reads of one render.
 *
 * Who uses it: the header status chip reads `useLiveStatus(boot)` (the chip
 * applies the 1 s render debounce itself), and the shell passes
 * `useBootDataVersion(boot)` to the panel grid's `dataVersion`.
 *
 * Why the boot is a structural type here: this file must never import the
 * peer layer, not even for a type, so the entry chunk stays free of it. Any
 * object with the four members below is accepted (the gates pass fakes).
 */
import { useCallback, useSyncExternalStore } from 'react';
import { DEFAULT_DATA_VERSION } from './DataVersionContext.js';
import type { DataVersion } from './DataVersionContext.js';

/** The status view the boot publishes (mirrors the reducer's view shape). */
export interface LiveStatusView {
	kind: 'live' | 'catching-up' | 'offline' | 'not-live' | 'unpaired';
	lastPassAt: number | null;
	reconnecting: boolean;
	reason?: 'revoked' | 'removed' | 'key-invalid';
}

/** The part of the live boot these hooks read. */
export interface LiveBootLike {
	getStatus(): LiveStatusView;
	subscribeStatus(listener: (view: LiveStatusView) => void): () => void;
	getDataVersion(): DataVersion;
	subscribeData(listener: (value: DataVersion) => void): () => void;
}

const NO_SUBSCRIPTION = (): void => undefined;

/** The boot's current status view, or null without a boot. Pure. */
export function selectLiveStatus(boot: LiveBootLike | null | undefined): LiveStatusView | null {
	return boot?.getStatus() ?? null;
}

/** The boot's status view, re-rendering when it changes; null without a boot. */
export function useLiveStatus(boot: LiveBootLike | null): LiveStatusView | null {
	const subscribe = useCallback(
		(onChange: () => void): (() => void) => (boot ? boot.subscribeStatus(() => onChange()) : NO_SUBSCRIPTION),
		[boot],
	);
	const getSnapshot = useCallback((): LiveStatusView | null => selectLiveStatus(boot), [boot]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The boot's data version for the panel grid; the default (never marks) without a boot. */
export function useBootDataVersion(boot: LiveBootLike | null): DataVersion {
	const subscribe = useCallback(
		(onChange: () => void): (() => void) => (boot ? boot.subscribeData(() => onChange()) : NO_SUBSCRIPTION),
		[boot],
	);
	const getSnapshot = useCallback((): DataVersion => (boot ? boot.getDataVersion() : DEFAULT_DATA_VERSION), [boot]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
