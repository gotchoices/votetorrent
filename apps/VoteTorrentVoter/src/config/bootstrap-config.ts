/**
 * bootstrap-config.ts — the RN half of D-14's ONE bootstrap-configuration mechanism (56-10).
 *
 * Five things a later reader cannot infer from the code alone:
 *
 * 1. THIS IS THE RN HALF OF D-14's ONE MECHANISM. The browser half is
 *    `apps/VoteTorrentPublic/src/peer/config.js` (56-06) — same document shape
 *    (a `bootstrapNodes` array of multiaddr strings) and the same two named
 *    fault kinds (`missing` / `malformed`). Where the two deliberately diverge
 *    is explained in point 3 below; everywhere else, 56-06's shipped names win.
 *
 * 2. A BOOTSTRAP ADDRESS LIST IS DNS-EQUIVALENT, NOT ELECTION DATA. It names
 *    WHERE to look for peers and carries no claim about any election — the
 *    same relationship a hostname has to the page it resolves to (D-13's
 *    distinction, restated here for the RN reader). Shipping one with the app
 *    is therefore not the ruled-out read-only-endpoint architecture.
 *
 * 3. WHY THE RN *TRANSPORT* DIFFERS FROM THE BROWSER'S SAME-ORIGIN `fetch` —
 *    AND WHY THE EMPTY-LIST CASE STILL DIFFERS TOO. A phone has no origin to
 *    fetch a config document from before it has a network, so making boot
 *    depend on an HTTP round-trip would make an offline-capable app fail to
 *    start. This file is bundled with the app instead and read as a plain
 *    JSON import. What D-14 unifies is the document SHAPE, the VALIDATION
 *    RULES and the FAULT TAXONOMY — not the byte transport. One consequence
 *    of that transport difference: `resolveBootstrapNodes(addr: string):
 *    string[]` (in `providers/CadreNodeProvider.tsx`) is preserved UNCHANGED
 *    — an empty/blank address still resolves to `[]`, a legitimate solo-boot
 *    input for a single already-validated address. That is a narrower
 *    contract than this module's own `readBootstrapConfig`, which reports
 *    fault `missing`/`empty-address-list` for a whole document with zero
 *    addresses. The two are not the same guard: this module validates the
 *    DOCUMENT once at boot; `resolveBootstrapNodes` validates ONE address at
 *    the point it is turned into a dial target, and keeps its own
 *    pure-and-exported-for-unit-testing rationale.
 *
 * 4. THE COMMITTED DOCUMENT SHIPS WITH AN EMPTY ADDRESS LIST, WHICH IS A
 *    REPORTED FAULT BY DESIGN. This replaces a hard-coded emulator loopback
 *    address that carried a placeholder sentinel (see the closed
 *    `2026-06-25-control-addr-placeholder-p2p-bootstrap.md` todo for the
 *    retired shape) and made every production release build run permanently
 *    solo — silently, because a solo boot does not crash. An app with no
 *    bootstrap peers genuinely cannot join anything, and it must say so
 *    rather than boot silently solo; there is no sentinel value of any kind
 *    in the committed document.
 *
 * 5. THIS FILE IS BYTE-IDENTICAL TO ITS SIBLING IN THE OTHER RN APP
 *    (`apps/VoteTorrentVoter/src/config/bootstrap-config.ts`), and a parity
 *    test in this app's own test suite enforces that byte-for-byte. Edit
 *    both, or edit neither — a fix applied to one copy and missed in the
 *    other is exactly the regression class the parity gate exists to catch.
 */

/** Bound on how many bootstrap addresses one config document may name (T-56-10-04, DoS on the app's own dial fan-out). */
export const BOOTSTRAP_CONFIG_MAX_ADDRS = 16;

/** The per-entry character cap (T-56-10-04). */
export const BOOTSTRAP_ADDR_MAX_LENGTH = 256;

/**
 * A closed token set, never a bare, freely-typed textual field. This is what
 * structurally prevents interpolating document content into a fault
 * (T-56-10-03) — an unbounded textual field could carry anything a caller
 * handed it; a string-literal union can only ever be one of these six named
 * tokens.
 */
export type BootstrapConfigFaultReason =
  | 'no-config-document'
  | 'no-address-list'
  | 'empty-address-list'
  | 'address-list-not-an-array'
  | 'invalid-address'
  | 'too-many-addresses';

export type BootstrapConfigFault = {
  readonly kind: 'missing' | 'malformed';
  readonly reason: BootstrapConfigFaultReason;
};

export type BootstrapConfigResult = {
  readonly addrs: readonly string[];
  readonly fault: BootstrapConfigFault | null;
};

function fault(kind: BootstrapConfigFault['kind'], reason: BootstrapConfigFaultReason): BootstrapConfigFault {
  return { kind, reason };
}

/**
 * Is `value` an acceptable bootstrap multiaddr string?
 *
 * True iff `value` is a string, length in `[1, BOOTSTRAP_ADDR_MAX_LENGTH]`,
 * starts with `/`, and contains a `/p2p/` segment followed by at least one
 * character that is not `/`.
 *
 * The `/p2p/` requirement is what makes the dial peer-id-pinned (T-56-10-01):
 * libp2p's noise handshake authenticates the remote peer against that id, so
 * a tampered host/port in the document cannot silently redirect the app to a
 * different listener — the handshake fails instead.
 *
 * Deliberately does NOT import `@multiformats/multiaddr` to do a real parse.
 * Both RN apps mock that package under jest (`__mocks__/@multiformats/multiaddr.js`),
 * so a real parse here would be untestable in the only harness this plan has.
 * A syntactic bound is what this function actually checks, and says so.
 */
export function isBootstrapAddr(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length < 1 || value.length > BOOTSTRAP_ADDR_MAX_LENGTH) return false;
  if (!value.startsWith('/')) return false;

  const marker = '/p2p/';
  const idx = value.indexOf(marker);
  if (idx === -1) return false;

  const afterMarker = value.slice(idx + marker.length);
  return afterMarker.length > 0 && afterMarker[0] !== '/';
}

/**
 * Parse and validate an already-loaded (JSON-imported) bootstrap-config
 * document. Pure, total, and NEVER throws, logs, or echoes any byte of `doc`
 * back in its result — the fault taxonomy is a closed token set precisely so
 * this guarantee is structural, not a matter of care at each call site.
 */
export function readBootstrapConfig(doc: unknown): BootstrapConfigResult {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { addrs: [], fault: fault('missing', 'no-config-document') };
  }

  const list = (doc as Record<string, unknown>).bootstrapNodes;

  if (list === undefined) {
    return { addrs: [], fault: fault('missing', 'no-address-list') };
  }

  if (!Array.isArray(list)) {
    return { addrs: [], fault: fault('malformed', 'address-list-not-an-array') };
  }

  if (list.length === 0) {
    // The committed default. An app with no bootstrap peers cannot join
    // anything and must say so — this is a fault on purpose, not a bug.
    return { addrs: [], fault: fault('missing', 'empty-address-list') };
  }

  if (list.length > BOOTSTRAP_CONFIG_MAX_ADDRS) {
    return { addrs: [], fault: fault('malformed', 'too-many-addresses') };
  }

  for (const entry of list) {
    if (!isBootstrapAddr(entry)) {
      return { addrs: [], fault: fault('malformed', 'invalid-address') };
    }
  }

  return { addrs: list as string[], fault: null };
}
