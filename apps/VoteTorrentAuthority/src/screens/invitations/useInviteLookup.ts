/**
 * useInviteLookup — the network lookup an accept screen runs for a pasted invitation, with a visible
 * state for every moment of it.
 *
 * Why: the lookup goes to the network when the slot's rows are not yet on this phone, and with the
 * sender's phone offline it can hang for minutes. Accept and Decline used to stay grey with nothing
 * on screen, and after a failed accept, re-entering left them grey until the app was restarted
 * (iPhone 13 and Redmi 8, 24 Nov 2026).
 *
 * States: 'idle' (nothing to look up), 'looking', 'timed-out' (no answer after `timeoutMs`; the
 * lookup is still running and may still land), 'resolved', 'failed'.
 *
 * Every run calls `lookup()` afresh: a new `key`, `retry()` or a new mount never reuses an earlier
 * promise. A run that is superseded or unmounted is ignored when it settles, so a hung first lookup
 * cannot overwrite a later one. The lookup is a read and cannot be cancelled, so it is left to
 * settle on its own; nothing is written.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { INVITE_LOOKUP_TIMEOUT_MS } from "./invite-share";

/**
 * After this long an answer (accept or decline, a network write) is still running, the screen says
 * so. The write is never abandoned: abandoning it could let it land after the officer was told it
 * failed.
 */
export const INVITE_RESPONSE_SLOW_MS = 20_000;

export type InviteLookupState<T> =
	| { phase: "idle" }
	| { phase: "looking" }
	| { phase: "timed-out" }
	| { phase: "resolved"; value: T }
	| { phase: "failed"; error: unknown };

export function useInviteLookup<T>(opts: {
	/** What to look up; undefined means nothing (no paste, still typing, expired). A new key starts a fresh lookup. */
	key: string | undefined;
	lookup: () => Promise<T>;
	timeoutMs?: number;
}): { state: InviteLookupState<T>; retry: () => void } {
	const { key, timeoutMs = INVITE_LOOKUP_TIMEOUT_MS } = opts;
	const lookupRef = useRef(opts.lookup);
	lookupRef.current = opts.lookup;
	const [attempt, setAttempt] = useState(0);
	const [state, setState] = useState<InviteLookupState<T>>(() => (key === undefined ? { phase: "idle" } : { phase: "looking" }));

	useEffect(() => {
		if (key === undefined) {
			setState({ phase: "idle" });
			return;
		}
		let current = true;
		setState({ phase: "looking" });
		const timer = setTimeout(() => {
			if (current) setState((s) => (s.phase === "looking" ? { phase: "timed-out" } : s));
		}, timeoutMs);
		let work: Promise<T>;
		try {
			work = Promise.resolve(lookupRef.current());
		} catch (error) {
			work = Promise.reject(error);
		}
		work.then(
			(value) => {
				if (!current) return;
				clearTimeout(timer);
				setState({ phase: "resolved", value });
			},
			(error: unknown) => {
				if (!current) return;
				clearTimeout(timer);
				setState({ phase: "failed", error });
			}
		);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [key, attempt, timeoutMs]);

	const retry = useCallback(() => setAttempt((a) => a + 1), []);
	return { state, retry };
}

/** True once `active` has stayed true for `ms`; false again as soon as `active` is false. */
export function useSlowFlag(active: boolean, ms: number = INVITE_RESPONSE_SLOW_MS): boolean {
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		setSlow(false);
		if (!active) return;
		const timer = setTimeout(() => setSlow(true), ms);
		return () => clearTimeout(timer);
	}, [active, ms]);
	return slow;
}
