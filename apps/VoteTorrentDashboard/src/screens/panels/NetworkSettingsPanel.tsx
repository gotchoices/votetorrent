/**
 * NetworkSettingsPanel.tsx -- the `rn` panel body.
 *
 * Renders its own body content only -- this panel does not wrap or import
 * the shared chrome component (contract C7: that frame is composed around
 * this panel by 50-09's `PanelGrid`). It re-reads when a completed sync
 * pass changed one of its tables, keeps showing the last data meanwhile, and
 * marks changed values briefly. The fetch lives HERE, never in a parent or a
 * shared prefetch, so a capability the officer cannot see is never mounted
 * and its query never runs: the panel still makes no visibility decision of
 * its own (D-12) and offers nothing to act on (D-10).
 *
 * Every rendered `<dt>` label is the schema column identifier the value came
 * from (binding decision A) -- `Name`, `Hash`, `PrimaryAuthorityId`,
 * `Relays`, `TimestampAuthorities`, `NumberRequiredTSAs`, `ElectionType`.
 * These are data read out of `votetorrent.qsql`, not invented copy; the
 * `ElectionType` row's rendered VALUE is the friendly name
 * (`ElectionTypeName`), with the raw code carried in the `title` attribute,
 * while the label itself stays the column identifier.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '@votetorrent/ui-web';
import { fetchNetworkSettings, NETWORK_SETTINGS_TABLES, networkSettingsMarkRows, PANEL_READ_LOADING, settlePanelRead, markRowsOrNull, markRowKey, markRowSig } from './authority-admin-queries.js';
import { useDataVersion, touchesTables } from '../../live/DataVersionContext.js';
import { useChangeMarks, ChangeMarkWord } from '../../live/useChangeMarks.js';
import './authority-admin.css';

const EM_DASH = '—';

type NetworkSettingsData = NonNullable<Awaited<ReturnType<typeof fetchNetworkSettings>>>;

interface NetworkSettingsState {
	status: 'loading' | 'ready' | 'error';
	data: NetworkSettingsData | null;
}

function formatTimestampAuthority(entry: unknown): string {
	if (entry && typeof entry === 'object' && 'url' in entry) {
		const url = (entry as { url: unknown }).url;
		return typeof url === 'string' ? url : EM_DASH;
	}
	return EM_DASH;
}

const NetworkSettingsPanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<NetworkSettingsState>(PANEL_READ_LOADING);

	const { version, changedTables } = useDataVersion();
	const [readKey, setReadKey] = useState(0);
	const seenVersionRef = useRef(version);
	useEffect(() => {
		if (version === seenVersionRef.current) return;
		seenVersionRef.current = version;
		if (touchesTables(changedTables, NETWORK_SETTINGS_TABLES)) setReadKey((k) => k + 1);
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
				const data = await fetchNetworkSettings(boundDb);
				if (mounted) setState((prev) => settlePanelRead(prev, { ok: true, data }));
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('NetworkSettingsPanel: read failed:', (err as { name?: string })?.name ?? 'Error');
				if (mounted) setState((prev) => settlePanelRead(prev, { ok: false }));
			}
		})();

		return () => {
			mounted = false;
		};
	}, [db, readKey]);

	const markRows = useMemo(() => markRowsOrNull(state, networkSettingsMarkRows), [state]);
	const { markClass, isMarked } = useChangeMarks(markRows, markRowKey, markRowSig);

	/** Field class: the base class, the constant mark padding and the mark itself. */
	function markable(key: string, base: string): string {
		return [base, 'aa-markable', markClass(key)].filter((part) => part.length > 0).join(' ');
	}

	if (!db || state.status === 'loading') return null;

	if (state.status === 'error') {
		return (
			<dl className="aa-kv">
				<dt>Name</dt>
				<dd>{EM_DASH}</dd>
			</dl>
		);
	}

	if (!state.data) {
		return <p className="aa-empty">{t(capability.emptyKey)}</p>;
	}

	const { data } = state;
	const relaysDisplay = data.Relays.length > 0 ? data.Relays.map(String).join(', ') : EM_DASH;
	const tsaDisplay = data.TimestampAuthorities.length > 0 ? data.TimestampAuthorities.map(formatTimestampAuthority).join(', ') : EM_DASH;

	return (
		<dl className="aa-kv">
			<dt>Name</dt>
			<dd className={markable('Name', '')}>
				{data.Name}
				{isMarked('Name') ? <ChangeMarkWord /> : null}
			</dd>
			<dt>Hash</dt>
			<dd className={markable('Hash', 'aa-mono')}>
				{data.Hash}
				{isMarked('Hash') ? <ChangeMarkWord /> : null}
			</dd>
			<dt>PrimaryAuthorityId</dt>
			<dd className={markable('PrimaryAuthorityId', 'aa-mono')}>
				{data.PrimaryAuthorityId}
				{isMarked('PrimaryAuthorityId') ? <ChangeMarkWord /> : null}
			</dd>
			<dt>Relays</dt>
			<dd className={markable('Relays', '')}>
				{relaysDisplay}
				{isMarked('Relays') ? <ChangeMarkWord /> : null}
			</dd>
			<dt>TimestampAuthorities</dt>
			<dd className={markable('TimestampAuthorities', '')}>
				{tsaDisplay}
				{isMarked('TimestampAuthorities') ? <ChangeMarkWord /> : null}
			</dd>
			<dt>NumberRequiredTSAs</dt>
			<dd className={markable('NumberRequiredTSAs', '')}>
				{data.NumberRequiredTSAs}
				{isMarked('NumberRequiredTSAs') ? <ChangeMarkWord /> : null}
			</dd>
			<dt>ElectionType</dt>
			<dd className={markable('ElectionType', '')} title={data.ElectionType}>
				{data.ElectionTypeName ?? data.ElectionType}
				{isMarked('ElectionType') ? <ChangeMarkWord /> : null}
			</dd>
		</dl>
	);
};

export default NetworkSettingsPanel;
