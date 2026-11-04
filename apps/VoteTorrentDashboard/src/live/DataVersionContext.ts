/**
 * DataVersionContext.ts -- the signal a live panel's read effect depends on.
 *
 * A panel re-reads its rows when `version` changes, so replicated data that
 * lands in the local copy shows up in place, without a reload. The value has
 * three parts:
 *   - `version`: increments once per completed replication pass that changed
 *     rows. Panels list it in their read effect's dependencies.
 *   - `changedTables`: the table names that pass changed. An EMPTY set means
 *     "unknown, treat as everything" (see `touchesTables`).
 *   - `markEligible`: whether a difference a panel sees may be marked as
 *     "updated". True only after the network's first full pass has completed
 *     while connected; false for the initial catch-up and for any load from
 *     the local copy. A dashboard that has just opened must never show a
 *     wall of marks.
 *
 * Who provides it: `PanelGrid` passes its optional `dataVersion` prop
 * straight into the provider. The live shell feeds that prop from the boot;
 * it must pass a memoized object and key `PanelGrid` by network hash so the
 * per-panel mark memory resets on a network switch.
 *
 * Why the default never marks: the shell that ships today provides nothing,
 * so every consumer reads `DEFAULT_DATA_VERSION`, whose `markEligible` is
 * false. With no provider the screen is exactly what it was before this
 * module existed.
 *
 * This file owns only the context object, its default and two small helpers.
 */
import { createContext, useContext } from 'react';

export interface DataVersion {
	/** Increments once per completed pass that changed rows. */
	version: number;
	/** Tables the last pass changed; empty means unknown (treat as everything). */
	changedTables: ReadonlySet<string>;
	/** True only once a difference may be marked as "updated". */
	markEligible: boolean;
}

const EMPTY_TABLES: ReadonlySet<string> = new Set<string>();

export const DEFAULT_DATA_VERSION: DataVersion = Object.freeze({
	version: 0,
	changedTables: EMPTY_TABLES,
	markEligible: false,
});

export const DataVersionContext = createContext<DataVersion>(DEFAULT_DATA_VERSION);
DataVersionContext.displayName = 'DataVersionContext';

/** The current data version; the default when no provider is mounted. */
export function useDataVersion(): DataVersion {
	return useContext(DataVersionContext);
}

/**
 * Whether a pass that changed `changedTables` touches any of `tables`.
 * An empty `changedTables` is "unknown", so it touches everything; an empty
 * `tables` list reads nothing, so nothing touches it.
 */
export function touchesTables(changedTables: ReadonlySet<string>, tables: ReadonlyArray<string>): boolean {
	if (tables.length === 0) return false;
	if (changedTables.size === 0) return true;
	for (const name of tables) {
		if (changedTables.has(name)) return true;
	}
	return false;
}
