/**
 * panel-view-storage.js — the D-18/D-19 view-flag storage contract, as plain
 * JS a node test can import with no bundler (the reason this is split out of
 * `ChartViewContext.tsx`: `node --test` cannot resolve `.tsx`).
 *
 * `DEFAULT_PANEL_VIEW` is `'chart'` — that literal IS D-18: every panel a
 * PanelFrame has never persisted a choice for opens chart-first.
 *
 * The storage key prefix is `vt-dashboard-panel-view:`, deliberately NOT the
 * dashboard's other namespace `votetorrent.dashboard.*`: a distinct prefix
 * keeps this flag outside the exact key sets the refresh/swap and
 * forget/delete lifecycle tests assert on, so a view preference can never
 * perturb a snapshot-lifecycle assertion.
 *
 * Both `readStoredPanelView` and `writeStoredPanelView` are SILENT on every
 * failure — no logging call of any kind. Two reasons, both binding:
 * `shell-wiring.test.mjs` pins this app's class-logging call sites at exactly
 * nine, and a tenth would fail it; and a view flag is non-essential state, so
 * a private-browsing or storage-quota refusal must degrade to the D-18
 * default rather than announce itself.
 */

/** The complete value set. Nothing else may ever be stored. @type {ReadonlyArray<'chart' | 'grid'>} */
export const PANEL_VIEWS = Object.freeze(/** @type {const} */ (['chart', 'grid']));

/** @typedef {'chart' | 'grid'} PanelView */

/** D-18: every panel a PanelFrame has never persisted a choice for opens chart-first. */
export const DEFAULT_PANEL_VIEW = /** @type {PanelView} */ ('chart');

/** D-19: the storage key prefix, distinct from `votetorrent.dashboard.*`. */
export const PANEL_VIEW_STORAGE_PREFIX = 'vt-dashboard-panel-view:';

/**
 * @param {string} capabilityId
 * @returns {string}
 */
export function panelViewStorageKey(capabilityId) {
	return `${PANEL_VIEW_STORAGE_PREFIX}${capabilityId}`;
}

/**
 * Returns `DEFAULT_PANEL_VIEW` when `storage` is nullish, when `getItem`
 * throws, when the stored value is null, or when it is not a member of
 * `PANEL_VIEWS` — the stored string is validated, never trusted.
 *
 * @param {string} capabilityId
 * @param {Pick<Storage, 'getItem'> | null | undefined} [storage]
 * @returns {PanelView}
 */
export function readStoredPanelView(capabilityId, storage = globalThis.localStorage) {
	if (storage == null) return DEFAULT_PANEL_VIEW;
	let raw;
	try {
		raw = storage.getItem(panelViewStorageKey(capabilityId));
	} catch {
		// Swallowed on purpose — see file header. A read failure degrades to
		// the D-18 default rather than announcing itself.
		return DEFAULT_PANEL_VIEW;
	}
	if (raw === null) return DEFAULT_PANEL_VIEW;
	return /** @type {ReadonlyArray<string>} */ (PANEL_VIEWS).includes(raw) ? /** @type {PanelView} */ (raw) : DEFAULT_PANEL_VIEW;
}

/**
 * A no-op unless `view` is a member of `PANEL_VIEWS`. Wraps `setItem` in a
 * try/catch that swallows every storage failure.
 *
 * @param {string} capabilityId
 * @param {string} view
 * @param {Pick<Storage, 'setItem'> | null | undefined} [storage]
 * @returns {void}
 */
export function writeStoredPanelView(capabilityId, view, storage = globalThis.localStorage) {
	if (storage == null) return;
	if (!/** @type {ReadonlyArray<string>} */ (PANEL_VIEWS).includes(view)) return;
	try {
		storage.setItem(panelViewStorageKey(capabilityId), view);
	} catch {
		// Swallowed on purpose — see file header.
	}
}
