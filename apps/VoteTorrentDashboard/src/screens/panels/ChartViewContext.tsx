/**
 * ChartViewContext.tsx — the React context, its provider and the
 * `usePanelView()` hook every panel body reads to choose its Chart or Grid
 * branch (D-13/D-17). The shared panel chrome owns the state and the
 * `localStorage` read/write; this module owns only the context object, the
 * provider that carries a resolved value down to `{children}`, and the hook
 * that reads it back.
 *
 * Modeled on `../GrantedScopesContext.ts`: a frozen default, a
 * `createContext(DEFAULT_VALUE)`, and a hook that returns the default rather
 * than throwing when called outside a provider. That non-throwing choice
 * matters here for the same reason it matters there — a panel body that
 * mounts before the shared chrome wraps it must degrade to the D-18 default
 * (chart-first) rather than crash.
 *
 * This file re-exports the storage helpers from `./panel-view-storage.js` so
 * the shared chrome needs one import line, not two.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_PANEL_VIEW, readStoredPanelView, writeStoredPanelView } from './panel-view-storage.js';

export { readStoredPanelView, writeStoredPanelView };

/** Declared locally rather than imported from the plain-JS storage module —
 * that module's `@typedef` is not a TS type export. */
export type PanelView = 'chart' | 'grid';

const ChartViewContext = createContext<PanelView>(DEFAULT_PANEL_VIEW);

export interface ChartViewProviderProps {
	view: PanelView;
	children: ReactNode;
}

/** Renders no element of its own — only the context provider. */
export function ChartViewProvider({ view, children }: ChartViewProviderProps) {
	return <ChartViewContext.Provider value={view}>{children}</ChartViewContext.Provider>;
}

/** Returns `DEFAULT_PANEL_VIEW` outside a provider, never throws — see file header. */
export function usePanelView(): PanelView {
	return useContext(ChartViewContext);
}
