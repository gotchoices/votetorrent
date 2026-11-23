import { multiaddr } from "@multiformats/multiaddr";

/**
 * relayAddressValidation.ts — R4 (D-11): extends the `T-22-09 / Security V5` mitigation already
 * applied to the JOIN path (`NetworksScreen.tsx:36` — "the multiaddr is parsed/validated BEFORE
 * any use so a malformed paste produces an inline error instead of crashing the node") to the
 * network CREATE path. `AddNetworkScreen.tsx`'s `handleCreate` used to do only
 * `relayAddresses.filter(Boolean)`, so a malformed paste was carried straight into `NetworkInit`
 * and only discovered far deeper in the create path.
 *
 * Where the validated addresses go (decided 2026-11-23: the relay field feeds strand bootstrap).
 * They are stored in `Network.Relays` and in the network's reference, and every later re-attach of
 * the network merges them into its strand's bootstrap seed before `addStrand()` — see
 * `engines/strand-relay-seed.ts`. The founding create itself still launches unseeded: a founder
 * given a seed it cannot reach never becomes writable (measured there), which is the create hang
 * the old boundary here guarded against.
 *
 * Whitespace-only entries are normalized away (treated as ABSENT, not INVALID) specifically so
 * the engine's own `networkInit.relays` validation error — and therefore `errRelayRequired` —
 * keeps ownership of the "no relay supplied" case. `errRelayInvalid` is a distinct key for a
 * distinct condition: a non-empty entry that fails to parse.
 *
 * This module is deliberately free of React, i18n and navigation imports so it stays
 * unit-testable in isolation and so the Node gate (`scripts/assert-relay-multiaddr-fixtures.mjs`)
 * can make a source assertion about it without ever loading it.
 */

/**
 * Trims every entry and drops entries that are empty after trimming. Returns a new array; the
 * input is never mutated. `["  "]` -> `[]` — whitespace-only is ABSENT, not INVALID (see header).
 */
export function normalizeRelayAddresses(addresses: readonly string[]): string[] {
	const normalized: string[] = [];
	for (const address of addresses) {
		const trimmed = address.trim();
		if (trimmed.length > 0) {
			normalized.push(trimmed);
		}
	}
	return normalized;
}

/**
 * Returns the FIRST address in `addresses` for which `parse` throws, or `undefined` if `parse`
 * throws for none of them. `addresses` is assumed already normalized by
 * `normalizeRelayAddresses` — this function does not re-normalize. `parse` defaults to
 * `multiaddr` from `@multiformats/multiaddr` (the real parser); tests inject their own throwing
 * function so the contract can be asserted with no multiaddr module involved at all. A `parse`
 * that returns any value, including `undefined`, means VALID — only a throw means invalid,
 * identical to the `NetworksScreen.tsx:40-45` try/`multiaddr()`/catch precedent.
 */
export function findInvalidRelayAddress(
	addresses: readonly string[],
	parse: (value: string) => unknown = multiaddr,
): string | undefined {
	for (const address of addresses) {
		try {
			parse(address);
		} catch {
			return address;
		}
	}
	return undefined;
}
