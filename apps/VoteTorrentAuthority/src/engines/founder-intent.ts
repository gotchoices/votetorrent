/**
 * D-30: the additive founder-intent override for the Authority's strand factory.
 *
 * `createStrandDbFactory` decides `founder` from "no control connections". With the rig relay
 * connected, that would open a brand-new network as a JOINER and hang on a first sync nobody can
 * supply. This module holds the transient intent the factory reads, one-shot and synchronously, as
 * its first statement:
 *
 *   - a founding window (set around `NetworksEngine.create`) is consumed by exactly one open;
 *   - a joining window (set by the join flow) is scoped to one network hash.
 *
 * Module state is one slot: null, a founding window, or a joining window for one hash. This module
 * imports nothing and never logs.
 */

export type FounderIntent = 'founding' | 'joining';

type Slot = { kind: 'founding' } | { kind: 'joining'; networkHash: string };

let active: Slot | null = null;

export class FounderIntentBusyError extends Error {
	readonly founderIntentBusy = true as const;

	constructor() {
		super('Another network is being created or joined; try again when it finishes.');
		this.name = 'FounderIntentBusyError';
	}
}

/** Structural check (not `instanceof`), matching `isNoNetworkEstablishedError`. */
export function isFounderIntentBusyError(e: unknown): boolean {
	return (
		typeof e === 'object' &&
		e !== null &&
		(e as { name?: unknown }).name === 'FounderIntentBusyError' &&
		(e as { founderIntentBusy?: unknown }).founderIntentBusy === true
	);
}

export class JoinedNetworksUnreadableError extends Error {
	readonly joinedNetworksUnreadable = true as const;

	constructor() {
		super('The list of joined networks could not be read, so the network was not opened.');
		this.name = 'JoinedNetworksUnreadableError';
	}
}

export function isJoinedNetworksUnreadableError(e: unknown): boolean {
	return (
		typeof e === 'object' &&
		e !== null &&
		(e as { name?: unknown }).name === 'JoinedNetworksUnreadableError' &&
		(e as { joinedNetworksUnreadable?: unknown }).joinedNetworksUnreadable === true
	);
}

/**
 * Runs `fn` inside a founding window. The slot is checked and set synchronously (nothing is
 * awaited before `fn`). The first `takeFounderIntent` frees the slot at once (consumption); an
 * unconsumed window holds it until `fn` settles.
 */
export async function withFounding<T>(fn: () => Promise<T>): Promise<T> {
	if (active !== null) throw new FounderIntentBusyError();
	const token: Slot = { kind: 'founding' };
	active = token;
	try {
		return await fn();
	} finally {
		if (active === token) active = null;
	}
}

/** Runs `fn` inside a joining window for `networkHash`. Held until `fn` settles. */
export async function withJoining<T>(networkHash: string, fn: () => Promise<T>): Promise<T> {
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new TypeError('withJoining needs a network hash');
	}
	if (active !== null) throw new FounderIntentBusyError();
	const token: Slot = { kind: 'joining', networkHash };
	active = token;
	try {
		return await fn();
	} finally {
		if (active === token) active = null;
	}
}

/** The factory's one-shot read. A founding intent is consumed here. */
export function takeFounderIntent(networkHash: string): FounderIntent | null {
	const slot = active;
	if (slot === null) return null;
	if (slot.kind === 'founding') {
		active = null;
		return 'founding';
	}
	return slot.networkHash === networkHash ? 'joining' : null;
}

/** `joined` always wins; then joining; then founding; otherwise the unchanged default. */
export function resolveFounderFlag(a: {
	intent: FounderIntent | null;
	joined: boolean;
	controlConnections: number;
}): boolean {
	if (a.joined) return false;
	if (a.intent === 'joining') return false;
	if (a.intent === 'founding') return true;
	return a.controlConnections === 0;
}

const FOUNDING_CREATE_MARK = Symbol('votetorrent.foundingCreate');

/**
 * Installs an own, idempotent `create` on `engine` that runs the original inside a founding
 * window. `original` is read at install time and may be undefined under test stubs.
 */
export function wrapCreateWithFounding<E extends object>(engine: E): E {
	const current = (engine as { create?: unknown }).create;
	if (typeof current === 'function' && (current as unknown as Record<symbol, unknown>)[FOUNDING_CREATE_MARK] === true) {
		return engine;
	}
	const original = current as ((...args: unknown[]) => Promise<unknown>) | undefined;
	const wrapped = function (this: unknown, ...args: unknown[]): Promise<unknown> {
		return withFounding(async () => {
			if (typeof original !== 'function') {
				throw new TypeError('create is not available on this engine');
			}
			return original.apply(engine, args);
		});
	};
	(wrapped as unknown as Record<symbol, unknown>)[FOUNDING_CREATE_MARK] = true;
	Object.defineProperty(engine, 'create', {
		value: wrapped,
		writable: true,
		configurable: true,
		enumerable: false,
	});
	return engine;
}
