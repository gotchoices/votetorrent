/**
 * AuthorityPeersPanel.tsx -- the `cap` panel body.
 *
 * Renders its own body content only -- this panel does not wrap or import
 * the shared chrome component (contract C7). It re-reads when a completed
 * sync pass changed one of its tables, keeps showing the last data
 * meanwhile, and marks changed values briefly; the read is owned by this
 * component alone, so it still makes no visibility decision of its own
 * (D-12) and offers nothing to act on (D-10) (see `NetworkSettingsPanel.tsx`'s
 * header for the shared reasoning, not repeated per file).
 *
 * One `aa-row` per peer, each a single `PeerId` (binding decision A: the
 * schema column identifier) pair, `aa-mono`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '@votetorrent/ui-web';
import { fetchAuthorityPeers, AUTHORITY_PEERS_TABLES, authorityPeersMarkRows, PANEL_READ_LOADING, settlePanelRead, markRowsOrNull, markRowKey, markRowSig } from './authority-admin-queries.js';
import { useDataVersion, touchesTables } from '../../live/DataVersionContext.js';
import { useChangeMarks, ChangeMarkWord } from '../../live/useChangeMarks.js';
import './authority-admin.css';

type AuthorityPeersData = Awaited<ReturnType<typeof fetchAuthorityPeers>>;

interface AuthorityPeersState {
	status: 'loading' | 'ready' | 'error';
	data: AuthorityPeersData | null;
}

const AuthorityPeersPanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<AuthorityPeersState>(PANEL_READ_LOADING);

	const { version, changedTables } = useDataVersion();
	const [readKey, setReadKey] = useState(0);
	const seenVersionRef = useRef(version);
	useEffect(() => {
		if (version === seenVersionRef.current) return;
		seenVersionRef.current = version;
		if (touchesTables(changedTables, AUTHORITY_PEERS_TABLES)) setReadKey((k) => k + 1);
	}, [version]);

	const loadedDbRef = useRef<typeof db | undefined>(undefined);

	useEffect(() => {
		let mounted = true;

		if (!db) {
			loadedDbRef.current = db;
			setState({ status: 'ready', data: [] });
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
				const data = await fetchAuthorityPeers(boundDb);
				if (mounted) setState((prev) => settlePanelRead(prev, { ok: true, data }));
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('AuthorityPeersPanel: read failed:', (err as { name?: string })?.name ?? 'Error');
				if (mounted) setState((prev) => settlePanelRead(prev, { ok: false }));
			}
		})();

		return () => {
			mounted = false;
		};
	}, [db, readKey]);

	const markRows = useMemo(() => markRowsOrNull(state, authorityPeersMarkRows), [state]);
	const { markClass, isMarked } = useChangeMarks(markRows, markRowKey, markRowSig);

	/** Field class: the base class, the constant mark padding and the mark itself. */
	function markable(key: string, base: string): string {
		return [base, 'aa-markable', markClass(key)].filter((part) => part.length > 0).join(' ');
	}

	if (!db || state.status === 'loading') return null;

	if (state.status === 'error') {
		return <p className="aa-empty">{t(capability.emptyKey)}</p>;
	}

	const peerIds = state.data ?? [];
	if (peerIds.length === 0) {
		return <p className="aa-empty">{t(capability.emptyKey)}</p>;
	}

	return (
		<>
			{peerIds.map((peerId) => (
				<div className={markable(peerId, 'aa-row')} key={peerId}>
					<dl className="aa-kv">
						<dt>PeerId</dt>
						<dd className="aa-mono">
							{peerId}
							{isMarked(peerId) ? <ChangeMarkWord /> : null}
						</dd>
					</dl>
				</div>
			))}
		</>
	);
};

export default AuthorityPeersPanel;
