/**
 * AdministrationOfficersPanel.tsx -- the `rad` panel body.
 *
 * Renders its own body content only -- this panel does not wrap or import
 * the shared chrome component (contract C7). It re-reads when a completed
 * sync pass changed one of its tables, keeps showing the last data
 * meanwhile, and marks changed values briefly; the read is owned by this
 * component alone, so it still makes no visibility decision of its own
 * (D-12) and offers nothing to act on (D-10) (see `NetworkSettingsPanel.tsx`'s
 * header for the shared reasoning, not repeated per file).
 *
 * It ALSO re-reads on the coarse clock tick (once a minute). `CurrentAdmin`
 * compares `EffectiveAt` with the wall clock inside the query, so an
 * administration scheduled for later takes effect without any replicated
 * change at all; the tick is what lets it show without a reload. That costs
 * one small read per minute while the panel is mounted.
 *
 * THERE ARE NO ROLES AND NO GROUPS IN THIS SYSTEM. `Officer.Title` is free
 * text enforced by nothing -- it is rendered as one data field among the
 * others below, never grouped, sorted or badged by. The `Scopes` chips are
 * what carry authority: a later reader looking at "County Clerk" will
 * assume otherwise, which is exactly why this comment exists.
 *
 * When `admin` is null (the `CurrentAdmin` wall-clock fail-closed branch a
 * future-dated `AdminEffectiveAt` produces -- already pinned in
 * `authority-admin-queries.js`'s JSDoc), the empty sentence covers the
 * whole panel.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '@votetorrent/ui-web';
import { fetchAdministrationOfficers, ADMINISTRATION_OFFICERS_TABLES, administrationOfficersMarkRows, officerMarkKey, PANEL_READ_LOADING, settlePanelRead, markRowsOrNull, markRowKey, markRowSig } from './authority-admin-queries.js';
import { useDataVersion, touchesTables } from '../../live/DataVersionContext.js';
import { useChangeMarks, ChangeMarkWord } from '../../live/useChangeMarks.js';
import { useNow } from '../../live/useNow.js';
import './authority-admin.css';

const EM_DASH = '—';

type AdministrationOfficersData = Awaited<ReturnType<typeof fetchAdministrationOfficers>>;

interface AdministrationOfficersState {
	status: 'loading' | 'ready' | 'error';
	data: AdministrationOfficersData | null;
}

function formatThresholdPolicy(entry: unknown): string {
	if (entry && typeof entry === 'object' && 'policy' in entry && 'threshold' in entry) {
		const policy = (entry as { policy: unknown }).policy;
		const threshold = (entry as { threshold: unknown }).threshold;
		return `${String(policy)} → ${String(threshold)}`;
	}
	return EM_DASH;
}

const AdministrationOfficersPanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<AdministrationOfficersState>(PANEL_READ_LOADING);
	const now = useNow();

	const { version, changedTables } = useDataVersion();
	const [readKey, setReadKey] = useState(0);
	const seenVersionRef = useRef(version);
	useEffect(() => {
		if (version === seenVersionRef.current) return;
		seenVersionRef.current = version;
		if (touchesTables(changedTables, ADMINISTRATION_OFFICERS_TABLES)) setReadKey((k) => k + 1);
	}, [version]);

	const loadedDbRef = useRef<typeof db | undefined>(undefined);

	useEffect(() => {
		let mounted = true;

		if (!db) {
			loadedDbRef.current = db;
			setState({ status: 'ready', data: null });
			return () => {
				mounted = false;
			};
		}

		if (loadedDbRef.current !== db) {
			loadedDbRef.current = db;
			setState(PANEL_READ_LOADING);
		}
		const boundDb = db;

		(async () => {
			try {
				const data = await fetchAdministrationOfficers(boundDb);
				if (mounted) setState((prev) => settlePanelRead(prev, { ok: true, data }));
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('AdministrationOfficersPanel: read failed:', (err as { name?: string })?.name ?? 'Error');
				if (mounted) setState((prev) => settlePanelRead(prev, { ok: false }));
			}
		})();

		return () => {
			mounted = false;
		};
	}, [db, readKey, now]);

	const markRows = useMemo(() => markRowsOrNull(state, administrationOfficersMarkRows), [state]);
	const { markClass, isMarked } = useChangeMarks(markRows, markRowKey, markRowSig);

	/** Field class: the base class, the constant mark padding and the mark itself. */
	function markable(key: string, base: string): string {
		return [base, 'aa-markable', markClass(key)].filter((part) => part.length > 0).join(' ');
	}

	if (!db || state.status === 'loading') return null;

	if (state.status === 'error') {
		return <p className="aa-empty">{t(capability.emptyKey)}</p>;
	}

	if (!state.data || !state.data.admin) {
		return <p className="aa-empty">{t(capability.emptyKey)}</p>;
	}

	const { admin, officers } = state.data;
	const policiesDisplay = admin.ThresholdPolicies.length > 0 ? admin.ThresholdPolicies.map(formatThresholdPolicy).join(', ') : EM_DASH;

	return (
		<>
			<section className="aa-section">
				<dl className="aa-kv">
					<dt>EffectiveAt</dt>
					<dd className={markable('admin:EffectiveAt', '')}>
						{admin.EffectiveAt}
						{isMarked('admin:EffectiveAt') ? <ChangeMarkWord /> : null}
					</dd>
					<dt>ThresholdPolicies</dt>
					<dd className={markable('admin:ThresholdPolicies', '')}>
						{policiesDisplay}
						{isMarked('admin:ThresholdPolicies') ? <ChangeMarkWord /> : null}
					</dd>
				</dl>
			</section>

			<section className="aa-section">
				{officers.map((officer) => (
					<div className={markable(officerMarkKey(officer.UserId), 'aa-row')} key={officer.UserId}>
						<dl className="aa-kv">
							<dt>Name</dt>
							<dd>
								{officer.Name ?? EM_DASH}
								{isMarked(officerMarkKey(officer.UserId)) ? <ChangeMarkWord /> : null}
							</dd>
							<dt>Title</dt>
							<dd>{officer.Title}</dd>
							<dt>UserId</dt>
							<dd className="aa-mono">{officer.UserId}</dd>
							<dt>Scopes</dt>
							<dd>
								{officer.Scopes.length === 0 ? (
									EM_DASH
								) : (
									<span className="aa-scope-list">
										{officer.Scopes.map((scope) => (
											<span className="aa-scope" key={String(scope)}>
												{String(scope)}
											</span>
										))}
									</span>
								)}
							</dd>
						</dl>
					</div>
				))}
			</section>
		</>
	);
};

export default AdministrationOfficersPanel;
