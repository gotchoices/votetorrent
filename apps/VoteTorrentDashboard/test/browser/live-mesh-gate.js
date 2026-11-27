// live-mesh-gate.js — the page-side recorder of `gate:live-mesh` (phase 66 plan 26).
//
// Injected at runtime by run-live-mesh-gate.mjs with `context.addInitScript({ path })`. It is never
// imported by `src/`, never built into `dist`, and has no imports or exports (a plain browser script).
// Running it twice in one document is a no-op.
//
// It records, under `window.__LIVE_MESH__` (contract token `live-mesh-gate/1`):
//   chip  - every change of the single status element (the header chip, the page's only status role):
//           its trimmed text, its title, its data-kind attribute, and the wall time (epoch ms);
//   marks - every change in the number of change-mark elements, with their clipped text;
//   csp   - every securitypolicyviolation event (directive, scheme of the blocked URI, time).
// It reads ONLY the status element and the change-mark elements. It never reads a form field, a
// field's contents, browser storage or any cookie (R-9: the pairing code must never be observable here).
(function liveMeshRecorder() {
	'use strict';
	if (typeof window === 'undefined') return;
	var existing = /** @type {any} */ (window).__LIVE_MESH__;
	if (existing && existing.contract === 'live-mesh-gate/1') return;

	var CLIP = 120;
	/** @type {{ contract: string, timeOrigin: number, chip: Array<{ text: string|null, title: string|null, kind: string|null, at: number }>, marks: { maxCount: number, events: Array<{ count: number, at: number, texts: string[] }> }, csp: Array<{ directive: string, scheme: string, at: number }> }} */
	var state = {
		contract: 'live-mesh-gate/1',
		timeOrigin: performance.timeOrigin,
		chip: [],
		marks: { maxCount: 0, events: [] },
		csp: [],
	};
	Object.defineProperty(window, '__LIVE_MESH__', { value: state, writable: false, configurable: false, enumerable: false });

	// The blocked URI's scheme (`wss`, `https`, ...) or its keyword (`inline`, `eval`, `wasm-eval`).
	function schemeOf(/** @type {any} */ blocked) {
		if (typeof blocked !== 'string' || blocked.length === 0) return 'none';
		var m = /^([a-z][a-z0-9+.-]*):/i.exec(blocked);
		return m ? m[1].toLowerCase() : blocked.slice(0, 24);
	}
	document.addEventListener(
		'securitypolicyviolation',
		function onViolation(e) {
			state.csp.push({ directive: String(e.effectiveDirective || e.violatedDirective || ''), scheme: schemeOf(e.blockedURI), at: Date.now() });
		},
		true,
	);

	/** @type {string|null} */
	var lastText = null;
	/** @type {string|null} */
	var lastTitle = null;
	/** @type {string|null} */
	var lastKind = null;
	var lastCount = 0;
	var pending = false;

	function sample() {
		pending = false;
		var chip = document.querySelector('[role="status"]');
		var text = chip ? (chip.textContent || '').trim() : null;
		var title = chip ? chip.getAttribute('title') : null;
		var kind = chip ? chip.getAttribute('data-kind') : null;
		if (text !== lastText || title !== lastTitle || kind !== lastKind) {
			lastText = text;
			lastTitle = title;
			lastKind = kind;
			state.chip.push({ text: text, title: title, kind: kind, at: Date.now() });
		}
		var marked = document.querySelectorAll('.change-mark');
		var count = marked.length;
		if (count !== lastCount) {
			lastCount = count;
			var texts = [];
			for (var i = 0; i < marked.length; i++) texts.push((marked[i].textContent || '').trim().slice(0, CLIP));
			state.marks.events.push({ count: count, at: Date.now(), texts: texts });
			if (count > state.marks.maxCount) state.marks.maxCount = count;
		}
	}
	function schedule() {
		if (pending) return;
		pending = true;
		queueMicrotask(sample);
	}

	var installed = false;
	function install() {
		if (installed || !document.documentElement) return;
		installed = true;
		new MutationObserver(schedule).observe(document.documentElement, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ['class', 'title', 'data-kind'],
		});
		schedule();
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
	else install();
})();
