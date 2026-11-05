/**
 * KeyholdersPanel.tsx -- the `ik` panel body (an engine-checked panel with
 * zero schema enforcement sites).
 *
 * Renders its own body content only -- this panel does not wrap or import
 * the shared chrome component (contract C7). Issues its own read from an
 * effect against `props.db`, owned by this component alone (see
 * `NetworkSettingsPanel.tsx`'s header for the shared reasoning, not
 * repeated per file). It makes no visibility decision of its own.
 *
 * Live: the read effect re-runs whenever the replicated data version moves,
 * so a keyholder accepted on another device lands in place with no click and
 * no reload. A re-read keeps the roster already on screen until the new one
 * arrives (only a different database handle resets to the loading state),
 * and a failed re-read keeps the last good roster. Every roster row is keyed
 * into one live change-mark hook: in grid view the changed row carries the
 * mark and the hidden word "updated"; in chart view the meter wrapper does.
 * The panel chrome owns the header mark and the grid owns the screen-reader summary,
 * so neither is rendered here. The panel lists accepted keyholders only, so
 * it holds no item an officer must act on and shows no action note.
 *
 * THIS PANEL NAMES PEOPLE, NEVER KEY MATERIAL. A `Keyholder` row in the
 * schema carries `(ElectionId, ElectionRevision, UserId)` and nothing
 * else -- there is no key column to leak, and this component must never
 * grow a field that would create one. Displaying that someone holds a key
 * share is a governance fact about the election; it is not, and must never
 * become, exposure of the share itself. The panel's own name invites that
 * confusion, which is exactly why this comment exists.
 *
 * The empty state here is EXPECTED on every real network today, not an
 * unfinished panel: a `Keyholder` row needs an `Election`, an
 * `ElectionRevision` and an accepted keyholder invite, and no keyholder
 * invite ceremony exists yet (see `authority-admin-queries.js`'s
 * `fetchKeyholders` JSDoc for the full reasoning). Do not "fix" this by
 * inventing a way to populate it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '@votetorrent/ui-web';
import { Meter } from '@votetorrent/ui-web/components';
import { fetchKeyholders } from './authority-admin-queries.js';
import { usePanelView } from './ChartViewContext.js';
import { useDataVersion } from '../../live/DataVersionContext.js';
import { useChangeMarks, ChangeMarkWord } from '../../live/useChangeMarks.js';
import type { ChangeMarks } from '../../live/useChangeMarks.js';
import './authority-admin.css';

const EM_DASH = '—';

type KeyholderRow = Awaited<ReturnType<typeof fetchKeyholders>>[number];

interface KeyholdersState {
	status: 'loading' | 'unavailable' | 'ready' | 'error';
	rows: KeyholderRow[];
}

/**
 * Pure helper deriving the C5 meter's two numbers from the roster
 * `fetchKeyholders` already returns -- no second query, no new column, no
 * new table. A roster spanning more than one election revision has
 * no single threshold to chart, so `threshold` is `null` in that case
 * rather than picking one revision's value and misreporting.
 *
 * @param {KeyholderRow[]} rows
 * @returns {{ enrolled: number; threshold: number | null }}
 */
function deriveMeterState(rows: KeyholderRow[]): { enrolled: number; threshold: number | null } {
	const enrolled = rows.length;
	const revisions = new Set(rows.map((row) => `${row.ElectionId}:${row.ElectionRevision}`));
	if (revisions.size !== 1) return { enrolled, threshold: null };
	const raw = rows[0]?.KeyholderThreshold ?? null;
	const threshold = raw == null || raw <= 0 ? null : raw;
	return { enrolled, threshold };
}

// --- Live change marks (UI-SPEC "2. In-place change mark") -------------------

type MarkRow = { key: string; sig: string };
const markKey = (row: MarkRow) => row.key;
const markSig = (row: MarkRow) => row.sig;

/** `base` alone when there is no mark, else `base` plus the mark classes. */
function withMark(base: string, mark: string): string {
	return mark ? `${base} ${mark}` : base;
}

/** The mark class of the first marked key, or '' when none is marked. */
function sectionMarkClass(marks: ChangeMarks, keys: string[]): string {
	const marked = keys.find((key) => marks.isMarked(key));
	return marked === undefined ? '' : marks.markClass(marked);
}

const keyholderMarkKey = (row: KeyholderRow) => `keyholder:${row.ElectionId}:${row.ElectionRevision}:${row.UserId}`;

/** One mark row per roster row; its sig covers the displayed name and threshold. */
function buildKeyholderMarkRows(rows: KeyholderRow[]): MarkRow[] {
	return rows.map((row) => ({ key: keyholderMarkKey(row), sig: JSON.stringify([row.Name, row.KeyholderThreshold]) }));
}

const KeyholdersPanel: PanelComponent = ({ capability, db }) => {
	const { version } = useDataVersion();
	const readDbRef = useRef<unknown>(undefined);
	const [state, setState] = useState<KeyholdersState>({ status: 'loading', rows: [] });
	const view = usePanelView();

	useEffect(() => {
		let mounted = true;
		const dbChanged = readDbRef.current !== db;
		readDbRef.current = db;

		if (!db) {
			setState({ status: 'unavailable', rows: [] });
			return () => {
				mounted = false;
			};
		}

		// A version bump keeps the roster on screen until the new one arrives;
		// only a different database handle starts again from the loading state.
		if (dbChanged) setState({ status: 'loading', rows: [] });
		const boundDb = db;

		(async () => {
			try {
				const rows = await fetchKeyholders(boundDb);
				if (mounted) setState({ status: 'ready', rows });
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('KeyholdersPanel: read failed:', (err as { name?: string })?.name ?? 'Error');
				// A failed re-read keeps the last good roster on screen.
				if (mounted) setState((prev) => (prev.status === 'ready' && !dbChanged ? prev : { status: 'error', rows: [] }));
			}
		})();

		return () => {
			mounted = false;
		};
	}, [db, version]);

	// null until the roster is ready (never an empty list, which would read
	// as "every row was deleted").
	const markRows = useMemo(() => (state.status === 'ready' ? buildKeyholderMarkRows(state.rows) : null), [state]);
	const marks = useChangeMarks(markRows, markKey, markSig);

	if (state.status === 'unavailable') {
		return <p className="aa-empty">{t('panels.keyholders.unavailable')}</p>;
	}

	if (state.status === 'loading') {
		return <p className="aa-empty">{t('panels.keyholders.loading')}</p>;
	}

	if (state.status === 'error') {
		return <p className="aa-empty">{t('panels.keyholders.readFailed')}</p>;
	}

	if (state.rows.length === 0) {
		return <p className="aa-empty">{t(capability.emptyKey)}</p>;
	}

	if (view === 'chart') {
		const meter = deriveMeterState(state.rows);
		const valueLabel =
			meter.threshold === null
				? undefined
				: t('panels.keyholders.meter.value', { count: meter.enrolled, total: meter.threshold });
		const meterKeys = state.rows.map(keyholderMarkKey);
		const meterMarked = meterKeys.some((key) => marks.isMarked(key));
		return (
			<div className={withMark('aa-meter', sectionMarkClass(marks, meterKeys))}>
				<Meter
					value={meter.enrolled}
					total={meter.threshold}
					valueLabel={valueLabel}
					variant="panel"
					emptyCopyKey="panels.keyholders.meter.empty"
				/>
				{meterMarked ? <ChangeMarkWord /> : null}
			</div>
		);
	}

	return (
		<>
			{state.rows.map((row) => (
				<div className={withMark('aa-row', marks.markClass(keyholderMarkKey(row)))} key={`${row.ElectionId}:${row.ElectionRevision}:${row.UserId}`}>
					<dl className="aa-kv">
						<dt>Name</dt>
						<dd>{row.Name ?? EM_DASH}</dd>
						<dt>UserId</dt>
						<dd className="aa-mono">{row.UserId}</dd>
						<dt>ElectionId</dt>
						<dd className="aa-mono">{row.ElectionId}</dd>
						<dt>ElectionRevision</dt>
						<dd>{row.ElectionRevision}</dd>
						<dt>KeyholderThreshold</dt>
						<dd>{row.KeyholderThreshold ?? EM_DASH}</dd>
					</dl>
					{marks.isMarked(keyholderMarkKey(row)) ? <ChangeMarkWord /> : null}
				</div>
			))}
		</>
	);
};

export default KeyholdersPanel;
