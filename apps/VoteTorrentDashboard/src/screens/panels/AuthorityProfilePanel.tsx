/**
 * AuthorityProfilePanel.tsx -- the `uai` panel body.
 *
 * Renders its own body content only -- this panel does not wrap or import
 * the shared chrome component (contract C7). It re-reads when a completed
 * sync pass changed one of its tables, keeps showing the last data
 * meanwhile, and marks changed values briefly; the read is owned by this
 * component alone, so it still makes no visibility decision of its own
 * (D-12) and offers nothing to act on (D-10) (see `NetworkSettingsPanel.tsx`'s
 * header for the shared reasoning, not repeated per file).
 *
 * `<dt>` labels are the schema column identifiers `Name`, `DomainName`,
 * `Id` and `ImageRef` (binding decision A). `Id` is `aa-mono` because its
 * value IS the authority's SID.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '@votetorrent/ui-web';
import { fetchAuthorityProfile, AUTHORITY_PROFILE_TABLES, authorityProfileMarkRows, PANEL_READ_LOADING, settlePanelRead, markRowsOrNull, markRowKey, markRowSig } from './authority-admin-queries.js';
import { useDataVersion, touchesTables } from '../../live/DataVersionContext.js';
import { useChangeMarks, ChangeMarkWord } from '../../live/useChangeMarks.js';
import './authority-admin.css';

const EM_DASH = '—';

type AuthorityProfileData = NonNullable<Awaited<ReturnType<typeof fetchAuthorityProfile>>>;

interface AuthorityProfileState {
	status: 'loading' | 'ready' | 'error';
	data: AuthorityProfileData | null;
}

function formatImageRef(imageRef: string | null): string {
	if (!imageRef) return EM_DASH;
	try {
		const parsed = JSON.parse(imageRef) as { url?: unknown; cid?: unknown };
		if (typeof parsed.url === 'string') return parsed.url;
		if (typeof parsed.cid === 'string') return parsed.cid;
		return EM_DASH;
	} catch {
		return EM_DASH;
	}
}

const AuthorityProfilePanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<AuthorityProfileState>(PANEL_READ_LOADING);

	const { version, changedTables } = useDataVersion();
	const [readKey, setReadKey] = useState(0);
	const seenVersionRef = useRef(version);
	useEffect(() => {
		if (version === seenVersionRef.current) return;
		seenVersionRef.current = version;
		if (touchesTables(changedTables, AUTHORITY_PROFILE_TABLES)) setReadKey((k) => k + 1);
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
				const data = await fetchAuthorityProfile(boundDb);
				if (mounted) setState((prev) => settlePanelRead(prev, { ok: true, data }));
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('AuthorityProfilePanel: read failed:', (err as { name?: string })?.name ?? 'Error');
				if (mounted) setState((prev) => settlePanelRead(prev, { ok: false }));
			}
		})();

		return () => {
			mounted = false;
		};
	}, [db, readKey]);

	const markRows = useMemo(() => markRowsOrNull(state, authorityProfileMarkRows), [state]);
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

	return (
		<dl className="aa-kv">
			<dt>Name</dt>
			<dd className={markable('Name', '')}>
				{data.Name}
				{isMarked('Name') ? <ChangeMarkWord /> : null}
			</dd>
			<dt>DomainName</dt>
			<dd className={markable('DomainName', '')}>
				{data.DomainName ?? EM_DASH}
				{isMarked('DomainName') ? <ChangeMarkWord /> : null}
			</dd>
			<dt>Id</dt>
			<dd className={markable('Id', 'aa-mono')}>
				{data.Id}
				{isMarked('Id') ? <ChangeMarkWord /> : null}
			</dd>
			<dt>ImageRef</dt>
			<dd className={markable('ImageRef', '')}>
				{formatImageRef(data.ImageRef)}
				{isMarked('ImageRef') ? <ChangeMarkWord /> : null}
			</dd>
		</dl>
	);
};

export default AuthorityProfilePanel;
