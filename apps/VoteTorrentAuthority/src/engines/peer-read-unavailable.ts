/**
 * peer-read-unavailable.ts — tells "the network could not answer" apart from "the data is not
 * there" for a peered read.
 *
 * Layer decision: a peered read that cannot reach its cohort throws optimystic's
 * `BlockUnavailableError` (db-core transactor-source `answeredBlock`), which the quereus vtab and
 * vote-engine pass up unchanged, and a true local-copy read would live inside @optimystic/db-p2p's
 * coordinator repo (upstream, Optimystic#32: WS reset close(1006) leaves half-open connections), so
 * the narrowest in-repo layer is the screen read sites that used to render the failure as ABSENCE.
 * This is display honesty, not data recovery: the screens keep what this device already read in the
 * session, or show an explicit can't-reach-other-devices state, and never write anything from it.
 *
 * Matching is structural (no @optimystic/db-core import): the error name, its `reason` field, or
 * the message shape, walking `cause` at most five levels. Only the reason token is returned; the
 * message (which carries block ids) is never exposed.
 */

export interface PeerReadFailure {
	reason: string;
}

const MAX_CAUSE_DEPTH = 5;
const UNAVAILABLE_RE = /Block \S+ is unavailable \(([a-z-]+)\)/;
const POSSIBLY_STALE_RE = /Block \S+ may be stale:/;

function classifyOne(value: object): PeerReadFailure | null {
	const candidate = value as { name?: unknown; reason?: unknown; message?: unknown };
	const name = typeof candidate.name === "string" ? candidate.name : "";
	const message = typeof candidate.message === "string" ? candidate.message : "";

	if (name === "BlockPossiblyStaleError") return { reason: "possibly-stale" };

	const fromMessage = UNAVAILABLE_RE.exec(message)?.[1];
	if (name === "BlockUnavailableError") {
		if (typeof candidate.reason === "string" && /^[a-z-]+$/.test(candidate.reason)) {
			return { reason: candidate.reason };
		}
		return { reason: fromMessage ?? "unavailable" };
	}
	if (fromMessage) return { reason: fromMessage };
	if (POSSIBLY_STALE_RE.test(message)) return { reason: "possibly-stale" };
	return null;
}

/**
 * Classify a failed read. Returns `{ reason }` when the error (or one of its first five causes) is
 * optimystic's peer-unavailable / possibly-stale shape, else `null`. Never throws.
 */
export function classifyPeerReadFailure(err: unknown): PeerReadFailure | null {
	const visited = new Set<unknown>();
	let current: unknown = err;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
		if (current === null || typeof current !== "object" || visited.has(current)) return null;
		visited.add(current);
		try {
			const match = classifyOne(current);
			if (match) return match;
			current = (current as { cause?: unknown }).cause;
		} catch {
			return null;
		}
	}
	return null;
}
