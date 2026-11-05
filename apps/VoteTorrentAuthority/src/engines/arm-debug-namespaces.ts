/**
 * arm-debug-namespaces.ts — dev-only arming of the `debug` namespace filter on device.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every Optimystic diagnostic marker this repo has ever needed to read from a device
 * (`cluster-tx:read-repair-triggered`, `cluster-fetch:solo-self-skip`, `commit:solo-cohort`,
 * `cluster-fetch:local-current`) is emitted through `@optimystic/db-p2p`'s `createLogger`,
 * which is the `debug` package. On React Native NOTHING enables it:
 *
 *   - `debug`'s browser build reads `localStorage.debug`; RN has no `localStorage`, so the
 *     read throws inside debug's own try/catch and is swallowed.
 *   - Its only fallback is `process.env.DEBUG`; Metro inlines `process.env.NODE_ENV` and
 *     nothing else, so that is `undefined` at runtime.
 *
 * The consequence is a trap that has already cost this project real time: a device capture
 * greps clean for `read-repair-triggered` and reads as "that code path never ran", when in
 * fact the logger was never armed. `58-07-t1-landed-logcat.txt` and `58-08-redmi-logcat.txt`
 * both contain ZERO lines from any `optimystic:db-p2p:*` namespace for exactly this reason.
 *
 * WHY IT OVERRIDES `formatArgs` AND `log` RATHER THAN JUST CALLING `enable()`
 * --------------------------------------------------------------------------
 * Two problems with debug's stock browser output on RN:
 *
 *   1. Its inter-line timing is `+Nms` humanised text ("+2s"), which cannot resolve the
 *      sub-second repeat gaps this instrument exists to measure (upstream reports a
 *      MINIMUM gap of 8ms between repeats of the same block). Worse, logcat's own
 *      per-line timestamp is applied when the RN console bridge DELIVERS the line, not
 *      when JS emitted it, so bridge batching can reorder or smear millisecond gaps.
 *      Emitting `Date.now()` inside the line makes the gap measurement independent of
 *      both.
 *   2. The payload arrives as a live object (`{ blockId }`) that RN's console formats
 *      however it pleases, including across multiple lines. A host-side analyzer cannot
 *      parse that reliably. Serialising it here yields one line per event, always.
 *
 * `debug` supports both overrides as first-class extension points: `createDebug.formatArgs`
 * is called as `formatArgs.call(instance, args)` and `createDebug.log` as
 * `log.apply(instance, args)`, so `this.namespace` is available to the sink. Neutering
 * `formatArgs` leaves `args[0]` as the raw marker string.
 *
 * Import order is NOT load-bearing: debug 4.x exposes `enabled` as a getter that
 * re-evaluates whenever `createDebug.namespaces` changes, so instances constructed before
 * this runs are still switched on by a later `enable()`.
 */

import debug from 'debug';
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
import { DEBUG_NAMESPACES } from './debug-namespaces.generated';

/** Prefix every armed line carries. The host-side analyzer keys off exactly this. */
export const CAPTURE_PREFIX = '[optidbg]';

/**
 * JSON for a `debug` payload argument, never throwing and never spanning lines.
 *
 * Cycles are possible in principle (a payload could carry a live node handle), and a throw
 * here would take out the log call inside library code that is merely trying to log — so
 * failure degrades to a marker string rather than propagating.
 */
function serializePayload(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	try {
		const seen = new WeakSet<object>();
		const json = JSON.stringify(value, (_key, v) => {
			if (typeof v === 'bigint') {
				return `${v}n`;
			}
			if (typeof v === 'object' && v !== null) {
				if (seen.has(v as object)) {
					return '[Circular]';
				}
				seen.add(v as object);
			}
			return v;
		});
		// `undefined` and functions stringify to undefined rather than a string.
		return json === undefined ? String(value) : json;
	} catch {
		return '[unserializable]';
	}
}

let armed = false;

/**
 * Arm the `debug` namespace filter. No-op in release, no-op when the generated constant is
 * empty (its committed default), and idempotent.
 *
 * @returns the namespace string actually armed, or null when this was a no-op.
 */
export function armDebugNamespaces(): string | null {
	if (!__DEV__) {
		return null;
	}
	const namespaces = DEBUG_NAMESPACES.trim();
	if (namespaces.length === 0) {
		return null;
	}
	if (armed) {
		return namespaces;
	}
	armed = true;

	// Leave args[0] as the raw marker string — see the header note on why the stock
	// "namespace msg +Nms" header is not usable for this measurement.
	debug.formatArgs = function formatArgs() {
		/* intentionally empty */
	};

	debug.log = function log(this: { namespace?: string }, ...args: unknown[]) {
		const namespace = this?.namespace ?? '?';
		const parts = args.map(serializePayload);
		const marker = parts.length > 0 ? parts[0] : '';
		const payload = parts.slice(1).join(' ');
		// One line, fixed field order, ' | ' separated: prefix, emit time, namespace,
		// marker, payload. `Date.now()` is the JS-side emit time (see header).
		console.log(
			`${CAPTURE_PREFIX} ${Date.now()} | ${namespace} | ${marker}${payload ? ` | ${payload}` : ''}`,
		);
	};

	debug.enable(namespaces);

	console.log(`${CAPTURE_PREFIX} armed namespaces=${namespaces}`);
	return namespaces;
}
