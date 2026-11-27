/**
 * hermes-abort-reason.js — AbortController `reason` + `AbortSignal.any` for bare RN 0.78 / Hermes.
 *
 * ADOPTED VERBATIM from `@serfab/cadre-rn@1.7.0` `polyfills/hermes.js` (the "AbortController
 * abort reasons" and "AbortSignal.any" arms, plus the `abortReason` helper they share). The
 * same code is what sereus-chat runs, adopted verbatim there too. Fix bugs UPSTREAM and
 * re-copy; do not patch this file locally. The only local change is dropping upstream's
 * `markPolyfilled(...)` registry calls, because this app has no boot-audit registry.
 * BYTE-IDENTICAL in both apps; `polyfill-drift.test.js` guards that.
 *
 * WHY (spike 092): React Native installs `abort-controller` 3.0.0 as AbortController /
 * AbortSignal (`Libraries/Core/setUpXHR.js`, via polyfillGlobal). That release predates the
 * DOM's `reason`, so every `controller.abort(err)` in the bundle drops `err`, and
 * `signal.reason` is `undefined`. libp2p's `race-signal` rejects with `signal.reason`, so an
 * aborted dial or upgrade rejects with `undefined`. The first `err.message` downstream then
 * throws `TypeError: Cannot read property 'message' of undefined`. That is the exact
 * connection-upgrade failure spike 069 recorded, which hid the real abort cause.
 */

function abortReason(message, name) {
	try {
		return new globalThis.DOMException(message, name);
	} catch {
		const err = new Error(message);
		err.name = name;
		return err;
	}
}

// ── AbortController abort reasons ──────────────────────────────────────────
// React Native installs `abort-controller` 3.0.0 as AbortController/AbortSignal
// (Libraries/Core/setUpXHR.js, via polyfillGlobal — it replaces whatever the engine
// had). That release predates the DOM's `reason`: its `abort()` takes no argument and
// nothing ever defines `signal.reason`, so every `controller.abort(err)` anywhere in
// the bundle silently drops its error and `throwIfAborted` falls back to a
// generic AbortError. That is why a failed dial on the phone reported only
// "AbortError: The operation was aborted" with no cause, and it would equally hide the
// TimeoutError that `AbortSignal.timeout` aborts with.
//
// Record the reason on the signal, then delegate. `AbortSignal.prototype` defines only
// `aborted`, and signals are ordinary extensible objects, so a plain own property is
// all this needs.

if (typeof AbortController === 'function'
	&& typeof AbortSignal !== 'undefined'
	&& !('reason' in AbortSignal.prototype)) {
	const _origAbort = AbortController.prototype.abort;
	AbortController.prototype.abort = function abort(reason) {
		const signal = this.signal;
		if (!signal.aborted) {
			signal.reason = reason ?? abortReason('The operation was aborted.', 'AbortError');
		}
		return _origAbort.call(this);
	};
}

// The listeners this attaches come back off the inputs when the combined signal aborts.
// `{ once: true }` only removes the listener that actually fired, and callers combine a
// long-lived signal with a short-lived one — `p-wait-for` (shipped code reaches it only
// through @libp2p/webrtc's private-to-public listener; libp2p, @libp2p/websockets,
// @libp2p/circuit-relay-v2 and @libp2p/tcp list it as a devDependency, so it is absent from
// their dist) pairs the caller's signal with an `AbortSignal.timeout`, which always fires.
//
// NOTE: a combination whose inputs ALL fail to abort keeps its listeners for as long as
// the inputs live: the DOM holds dependent signals weakly, and Hermes gives this no hook
// to do the same. No caller does that today — `p-wait-for` is the only dependency that
// calls `AbortSignal.any`, and it always pairs with an `AbortSignal.timeout`. If one ever
// does, fix it at that call site — an explicit combination it can release, as optimystic's
// repo client and quereus's `combineAbortSignals` do — not here: this has no way to learn
// a combination is finished.

if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
	AbortSignal.any = function any(signals) {
		const controller = new AbortController();
		const list = Array.from(signals);
		const reasonOf = (signal) => signal.reason ?? abortReason('The operation was aborted.', 'AbortError');
		// An input that has already aborted settles the result before anything is
		// registered, so there is nothing to detach.
		for (const signal of list) {
			if (signal.aborted) {
				controller.abort(reasonOf(signal));
				return controller.signal;
			}
		}
		// Pairs, not a Map keyed by signal: the same signal may legitimately appear
		// twice in `signals`, and a Map would collapse the two registrations and leave
		// one attached.
		const attached = [];
		for (const signal of list) {
			const listener = () => {
				if (controller.signal.aborted) return;
				controller.abort(reasonOf(signal));
			};
			attached.push([signal, listener]);
			signal.addEventListener('abort', listener, { once: true });
		}
		controller.signal.addEventListener('abort', () => {
			for (const [signal, listener] of attached) {
				signal.removeEventListener('abort', listener);
			}
			attached.length = 0;
		}, { once: true });
		return controller.signal;
	};
}
