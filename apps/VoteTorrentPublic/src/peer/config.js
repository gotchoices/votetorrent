/**
 * config.js — the D-13 same-origin bootstrap-config loader (56-06).
 *
 * Six things a later reader cannot infer from the code alone:
 *
 * 1. A BOOTSTRAP ADDRESS LIST IS DNS-EQUIVALENT, NOT ELECTION DATA. It names
 *    WHERE to look and carries no claim about any election — the same
 *    relationship a hostname has to the page it resolves to. Every election
 *    fact this app ever shows still arrives over the strand mesh, read
 *    through `public-election-source.js`, never through this file. This
 *    module resolves zero election facts and asserts zero of them.
 *
 * 2. THIS IS NOT THE RULED-OUT READ-ONLY-ENDPOINT ARCHITECTURE. This phase's
 *    scope note rules out a published snapshot or a read-only JSON endpoint
 *    serving election content, because that would have the page read
 *    election facts from an origin server instead of the peer mesh. This
 *    fetch is different in kind, not merely in size: it returns an address
 *    list an operator publishes once at deploy time, the same role a DNS
 *    record or a hard-coded bootstrap list would play in a native app. If a
 *    future change ever makes this endpoint answer with anything that reads
 *    as an election fact (a title, a count, a status), that change has
 *    silently become the rejected architecture and must be treated as an
 *    architectural regression, not an extension of this module.
 *
 * 3. NO FALLBACK, ANYWHERE — BY CONSTRUCTION, NOT BY CONVENTION. No default
 *    address, no "empty list means boot solo", no sentinel constant, no
 *    build-time environment variable. An absent or empty `bootstrapNodes`
 *    is `malformed`, never `ok: true`. This is a DELIBERATE DIVERGENCE from
 *    `CadreNodeProvider.tsx`'s `resolveBootstrapNodes(addr: string): string[]`,
 *    which `56-10` preserves unchanged for React Native: there, an
 *    empty/placeholder address degrades to a solo node with its own
 *    `syncState` surface, a legitimate offline mode. In this browser there
 *    is no equivalent legitimate empty case — a page an anonymous reader
 *    landed on with no bootstrap addresses at all can only mean the
 *    deployment is broken, never that it was deliberately configured to
 *    boot alone. A fallback here would render misconfiguration as an empty
 *    election, which is the exact failure D-13 exists to end.
 *
 * 4. EXACTLY TWO NAMED FAULTS, NEVER A THIRD. `missing` = the fetch did not
 *    deliver a config (a rejection, or `response.ok === false`). `malformed`
 *    = a config arrived and cannot be used (unparseable JSON, wrong shape,
 *    or any entry failing validation). Telling a reader "this browser
 *    doesn't hold that election" when the real fact is "this deployment
 *    cannot reach any network at all" is the same false-specificity defect
 *    `public-election-source.js`'s own header names and fixes one layer
 *    down ("A FAULT IS NOT A FACT"); this is that same defect class, one
 *    layer up the stack. `56-12` renders `fault` verbatim and must never
 *    re-derive a third category from `reason`.
 *
 * 5. WHAT PEERID PINNING DOES AND DOES NOT PREVENT (threat T-56-06-01).
 *    Every entry must carry a `/p2p/<peerId>` component so libp2p's noise
 *    handshake authenticates the remote peer — an off-path attacker who
 *    controls DNS, BGP, or the serving host cannot impersonate the pinned
 *    peer merely by redirecting traffic. What this does NOT prevent,
 *    accepted here rather than hidden: an attacker who can overwrite
 *    `config.json` on the origin can equally overwrite the JS bundle itself
 *    — same origin, same trust boundary, and no client-side validation
 *    recovers from that. Nor does a correctly-pinned peerId say anything
 *    about whether the gateway behind it is honest; a hostile-but-correctly
 *    -pinned gateway can still serve wrong election data, which is the
 *    strand mesh's trust problem, not this loader's.
 *
 * 6. `reason` ON A FAILURE RESULT IS A DEVELOPER-FACING DIAGNOSTIC STRING
 *    ONLY. It names internals a reader has no use for and MUST NEVER reach
 *    the DOM. `56-12` keys its rendering on `fault` alone.
 *
 * Zero imports, deliberately. `56-12` must be able to render the config-
 * fault box BEFORE any address-branch logic runs, on a page where the
 * libp2p closure failed to load entirely — a module that pulls a dependency
 * into the boot path cannot make that guarantee. Validation here is plain
 * string/array work on values already parsed as JSON; it needs nothing
 * from `@multiformats/multiaddr` or any other package.
 */

/**
 * The single, module-constant, same-origin path this loader ever fetches.
 * A JS string primitive is already immutable; no `Object.freeze` call is
 * needed to make it a frozen constant. Never derived from `location.search`,
 * a route param, or any other input.
 * @type {string}
 */
export const BOOTSTRAP_CONFIG_URL = '/config.json';

/** The bound on how many bootstrap addresses one config may name (T-56-06-04, DoS on the reader's own fan-out). @type {number} */
export const MAX_BOOTSTRAP_NODES = 8;

/** The per-entry character cap (T-56-06-04). @type {number} */
const MAX_ENTRY_LENGTH = 256;

/** The floor a `/p2p/<peerId>` component must clear to be treated as a real peerId rather than a truncated or placeholder value. @type {number} */
const MIN_PEER_ID_LENGTH = 40;

/**
 * The entire rendering contract `56-12` consumes. Exactly two members —
 * never a third generic/'unknown' category.
 * @type {Readonly<{ MISSING: 'missing', MALFORMED: 'malformed' }>}
 */
export const CONFIG_FAULT = Object.freeze({
	MISSING: 'missing',
	MALFORMED: 'malformed',
});

/**
 * @typedef {{ ok: true, bootstrapNodes: string[] }} ConfigOk
 * @typedef {{ ok: false, fault: 'malformed', reason: string }} ConfigMalformed
 * @typedef {{ ok: false, fault: 'missing', reason: string }} ConfigMissing
 */

/**
 * @param {string} reason developer-facing diagnostic only — never rendered
 * @returns {ConfigMalformed}
 */
function malformed(reason) {
	return { ok: false, fault: CONFIG_FAULT.MALFORMED, reason };
}

/**
 * @param {string} reason developer-facing diagnostic only — never rendered
 * @returns {ConfigMissing}
 */
function missing(reason) {
	return { ok: false, fault: CONFIG_FAULT.MISSING, reason };
}

/**
 * Does `entry` name a plaintext websocket segment (`/ws`) that is not
 * immediately preceded by `/tls` (i.e. not the `/tls/ws` combination, and
 * not the distinct `/wss` component, which is its own single segment and
 * never matches a bare `ws` segment). Split on `/` rather than a single
 * regex, because a substring match cannot distinguish a bare `ws` segment
 * from the tail of `wss` or the second half of `tls/ws` reliably across
 * every multiaddr shape.
 * @param {string} entry
 * @returns {boolean}
 */
function hasPlaintextWebsocketSegment(entry) {
	const segments = entry.split('/');
	for (let i = 0; i < segments.length; i += 1) {
		if (segments[i] !== 'ws') continue;
		const previous = segments[i - 1];
		if (previous !== 'tls') return true;
	}
	return false;
}

/**
 * Validate one bootstrap-node entry. Returns a developer-facing problem
 * string, or `null` if the entry is acceptable.
 * @param {unknown} entry
 * @param {{ pageProtocol?: string }} opts
 * @returns {string | null}
 */
function validateEntry(entry, { pageProtocol }) {
	if (typeof entry !== 'string') return 'a bootstrapNodes entry is not a string';
	if (entry.length === 0) return 'a bootstrapNodes entry is empty';
	if (entry.length > MAX_ENTRY_LENGTH) return `a bootstrapNodes entry exceeds the ${MAX_ENTRY_LENGTH}-character cap`;
	if (!entry.startsWith('/')) return 'a bootstrapNodes entry does not start with "/"';

	const peerIdMatch = entry.match(/\/p2p\/([^/]+)/);
	if (!peerIdMatch) return 'a bootstrapNodes entry has no /p2p/<peerId> component';
	const peerId = peerIdMatch[1];
	if (peerId.length < MIN_PEER_ID_LENGTH) {
		return `a bootstrapNodes entry's peerId component is shorter than ${MIN_PEER_ID_LENGTH} characters`;
	}
	if (!/^[A-Za-z0-9]+$/.test(peerId)) {
		return "a bootstrapNodes entry's peerId component is not alphanumeric";
	}

	if (pageProtocol === 'https:' && hasPlaintextWebsocketSegment(entry)) {
		return 'a bootstrapNodes entry downgrades transport to a plaintext websocket on an https: page';
	}

	return null;
}

/**
 * Pure, synchronous validation of an already-parsed config body. No `fetch`,
 * no globals — the same value this file's own `loadBootstrapConfig` would
 * hand it after parsing a response body as JSON.
 *
 * @param {unknown} value
 * @param {{ pageProtocol?: string }} [opts]
 * @returns {ConfigOk | ConfigMalformed}
 */
export function validateBootstrapConfig(value, opts = {}) {
	const { pageProtocol } = opts;

	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return malformed('config body is not a plain object');
	}

	const bootstrapNodes = /** @type {{ bootstrapNodes?: unknown }} */ (value).bootstrapNodes;
	if (!Array.isArray(bootstrapNodes)) {
		return malformed('bootstrapNodes is missing or is not an array');
	}
	if (bootstrapNodes.length === 0) {
		// The no-fallback property: an empty list is refused rather than
		// treated as a valid "boot solo" instruction. See header point 3.
		return malformed('bootstrapNodes is empty — an empty list is refused, never treated as a valid solo-boot instruction');
	}
	if (bootstrapNodes.length > MAX_BOOTSTRAP_NODES) {
		return malformed(`bootstrapNodes has ${bootstrapNodes.length} entries, exceeding the ${MAX_BOOTSTRAP_NODES}-entry cap`);
	}

	for (const entry of bootstrapNodes) {
		const problem = validateEntry(entry, { pageProtocol });
		if (problem) return malformed(problem);
	}

	return { ok: true, bootstrapNodes: /** @type {string[]} */ (bootstrapNodes) };
}

/**
 * The minimal shape this module needs from a `fetch`-like function — never
 * the global `typeof fetch` signature, deliberately. Typing against the DOM
 * `Response` type would force every test's fake response to construct a
 * real `Response` object just to satisfy the type checker; this module only
 * ever reads `.ok`, `.status` and calls `.text()`, so that is the entire
 * injected surface.
 * @typedef {(url: string, init: { credentials: string, cache: string, redirect: string }) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} FetchLike
 */

/**
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Fetch and validate the same-origin bootstrap config. Never throws and
 * never rejects — every failure path, including one this function did not
 * anticipate, resolves to a discriminated result instead. A thrown boot
 * step would force `56-12`'s render path to wrap itself in a `try/catch`;
 * a discriminated result is the seam this module exists to provide.
 *
 * @param {{ fetchImpl: FetchLike, pageProtocol?: string, url?: string }} deps
 * @returns {Promise<ConfigOk | ConfigMalformed | ConfigMissing>}
 */
export async function loadBootstrapConfig({ fetchImpl, pageProtocol, url = BOOTSTRAP_CONFIG_URL }) {
	try {
		/** @type {{ ok: boolean, status: number, text: () => Promise<string> }} */
		let response;
		try {
			response = await fetchImpl(url, { credentials: 'omit', cache: 'no-store', redirect: 'error' });
		} catch (err) {
			return missing(`fetch failed: ${describeError(err)}`);
		}

		if (!response.ok) {
			return missing(`response.ok was false (status ${response.status})`);
		}

		/** @type {string} */
		let body;
		try {
			body = await response.text();
		} catch (err) {
			return malformed(`response body could not be read: ${describeError(err)}`);
		}

		/** @type {unknown} */
		let parsed;
		try {
			parsed = JSON.parse(body);
		} catch {
			return malformed('response body is not valid JSON (this is also the SPA-fallback case: a static host answering an unknown path with index.html and a 200)');
		}

		return validateBootstrapConfig(parsed, { pageProtocol });
	} catch (err) {
		// Structural guarantee: no code path in this module may throw or
		// reject a caller, even one this function did not anticipate.
		return malformed(`unexpected error while loading the bootstrap config: ${describeError(err)}`);
	}
}
