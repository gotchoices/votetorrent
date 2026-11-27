/**
 * hermes-structured-clone.js — `structuredClone` for Hermes, which has none.
 *
 * ADOPTED VERBATIM from `@serfab/cadre-rn@1.19.0` `polyfills/hermes.js` (the "structuredClone"
 * arm, gotchoices/sereus#51). Fix bugs UPSTREAM and re-copy; do not patch this file locally. The
 * only local change is dropping upstream's `markPolyfilled(...)` registry call, because this app
 * has no boot-audit registry. BYTE-IDENTICAL in both apps; the Authority's
 * polyfills/__tests__/hermes-structured-clone.test.js guards that, and also that this body still
 * matches the installed kit's arm, so a kit bump that changes it fails until this file is
 * re-copied.
 *
 * WHY: until 2026-10-29 both apps installed @ungap/structured-clone directly, whose
 * serialize-then-deserialize is several times slower than copying. @optimystic/db-core clones
 * every block it reads or updates, and sereus#51 (this arm plus a chunked TextDecoder) took a
 * Galaxy S7 write from about 7 s to about 1.5 s. Plain data (objects, arrays, typed arrays,
 * Map, Set, Date, RegExp) is copied directly, as the HTML structured-clone algorithm copies it;
 * any other value sends the whole graph to ungap, as before.
 *
 * The kit's TextDecoder arm is NOT adopted: it ignores `{ fatal: true }` and `ignoreBOM`, which
 * Optimystic's wire codecs and the Voter's vote-record vault rely on. polyfills/hermes-text-decoder.js
 * stays.
 */

// ── structuredClone ─────────────────────────────────────────────────────────
// Not yet supported by Hermes.
// Required by: @optimystic/db-core (transform tracker, cache-source, coordinator), which
// clones each block it reads or updates.
//
// The JSON-shaped values db-core clones are copied directly, following the HTML
// structured-clone algorithm for the types `cloneValue` lists: shared references and
// cycles are kept, and objects come back as plain objects carrying their own enumerable
// string keys. A graph holding any other value goes, whole, to @ungap/structured-clone,
// whose serialize-then-deserialize covers more types but is several times slower
// (gotchoices/sereus#51).

if (typeof globalThis.structuredClone !== 'function') {
	// Loaded before globalThis.structuredClone is assigned: ungap's default export calls
	// the global structuredClone when one exists at load time, which would be this one.
	const ungapClone = require('@ungap/structured-clone').default;
	const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
	/** What the copiers return when the graph holds a value they do not copy. */
	const UNSUPPORTED = Symbol('structuredClone: unsupported');

	/**
	 * A copy of `value`, or UNSUPPORTED. `memo` maps each source object already met to its
	 * copy, which keeps shared references shared and closes cycles.
	 */
	function cloneValue(value, memo) {
		if (typeof value !== 'object' || value === null) {
			return typeof value === 'function' || typeof value === 'symbol' ? UNSUPPORTED : value;
		}
		const prior = memo.get(value);
		if (prior !== undefined) return prior;
		// Exact prototypes only, so a subclass instance (a class, a Node Buffer) is not copied here.
		const proto = Object.getPrototypeOf(value);
		if (proto === Object.prototype || proto === null) return clonePlainObject(value, memo);
		if (proto === Array.prototype) return cloneArray(value, memo);
		if (Object.getPrototypeOf(proto) === TypedArrayPrototype) {
			return cloneView(value, proto.constructor, value.length, memo);
		}
		if (proto === ArrayBuffer.prototype) return remember(memo, value, value.slice(0));
		if (proto === DataView.prototype) return cloneView(value, DataView, value.byteLength, memo);
		if (proto === Date.prototype) return remember(memo, value, new Date(value.getTime()));
		if (proto === RegExp.prototype) return remember(memo, value, new RegExp(value.source, value.flags));
		if (proto === Map.prototype) return cloneMap(value, memo);
		if (proto === Set.prototype) return cloneSet(value, memo);
		return UNSUPPORTED;
	}

	function remember(memo, source, copy) {
		memo.set(source, copy);
		return copy;
	}

	function clonePlainObject(source, memo) {
		const copy = remember(memo, source, {});
		const keys = Object.keys(source);
		for (let k = 0; k < keys.length; k++) {
			const key = keys[k];
			const value = cloneValue(source[key], memo);
			if (value === UNSUPPORTED) return UNSUPPORTED;
			if (key === '__proto__') {
				// Assigning would set the copy's prototype; the algorithm makes an own property,
				// which is also what JSON.parse makes of this key.
				Object.defineProperty(copy, key, { value, writable: true, enumerable: true, configurable: true });
			} else {
				copy[key] = value;
			}
		}
		return copy;
	}

	// NOTE: copies indices only. The algorithm also copies an array's other own enumerable
	// properties (`arr.label = …`); no caller sets any, and ungap dropped them too. If one
	// ever does, iterate Object.keys here instead.
	function cloneArray(source, memo) {
		const length = source.length;
		const copy = remember(memo, source, new Array(length));
		for (let k = 0; k < length; k++) {
			if (!(k in source)) continue; // a hole stays a hole
			const value = cloneValue(source[k], memo);
			if (value === UNSUPPORTED) return UNSUPPORTED;
			copy[k] = value;
		}
		return copy;
	}

	/** A typed array or DataView, over a copy of its buffer made once however many views share it. */
	function cloneView(source, View, size, memo) {
		const buffer = cloneValue(source.buffer, memo);
		if (buffer === UNSUPPORTED) return UNSUPPORTED;
		return remember(memo, source, new View(buffer, source.byteOffset, size));
	}

	function cloneMap(source, memo) {
		const copy = remember(memo, source, new Map());
		for (const [key, value] of source) {
			const keyCopy = cloneValue(key, memo);
			if (keyCopy === UNSUPPORTED) return UNSUPPORTED;
			const valueCopy = cloneValue(value, memo);
			if (valueCopy === UNSUPPORTED) return UNSUPPORTED;
			copy.set(keyCopy, valueCopy);
		}
		return copy;
	}

	function cloneSet(source, memo) {
		const copy = remember(memo, source, new Set());
		for (const value of source) {
			const valueCopy = cloneValue(value, memo);
			if (valueCopy === UNSUPPORTED) return UNSUPPORTED;
			copy.add(valueCopy);
		}
		return copy;
	}

	// NOTE: a graph that gives up pays for the partial walk and then for ungap. db-core's
	// blocks are plain data, so nothing hot gives up today; if a profile shows a caller that
	// does, give that type a copier rather than detecting it up front.
	globalThis.structuredClone = function structuredClone(value, options) {
		// A call with options (a transfer list, which neither path honours) is left exactly
		// as it was: ungap, with the options dropped.
		if (options === undefined) {
			const copy = cloneValue(value, new Map());
			if (copy !== UNSUPPORTED) return copy;
		}
		return ungapClone(value);
	};
}
