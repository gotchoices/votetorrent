/**
 * InviteAuthoritiesPanel.tsx -- the `iad` panel body (tier 2, zero schema
 * enforcement sites).
 *
 * Renders its own body content only -- this panel does not wrap or import
 * the shared chrome component (contract C7). It re-reads when a completed
 * sync pass changed one of its tables, keeps showing the last data
 * meanwhile, and marks changed rows briefly; the read is owned by this
 * component alone, so it still makes no visibility decision of its own
 * (D-12) (see `NetworkSettingsPanel.tsx`'s header for the shared reasoning,
 * not repeated per file).
 *
 * Invite state shows live. When at least one invite is still waiting for an
 * answer, one short action note sits above the rows saying where that
 * decision is taken, and each waiting row points its accessible description
 * at that one note. Whether an invite is still waiting is worked out at
 * render time against the coarse clock, so an invite that expires while the
 * panel is open stops counting without another read.
 *
 * THIS PANEL DISPLAYS EXISTING INVITE STATE; IT DOES NOT OFFER TO CREATE
 * ONE. The multi-officer invite ceremony is out of scope for this phase,
 * and the schema admits exactly one user through the unsigned shoe-in --
 * `User.InsertValid` requires `count(*) from User = 1`, so a second `User`
 * is rejected and its `Officer` then fails `UserIdValid` (measured
 * empirically). There is no "Create authority invite" control of any kind,
 * whether it could be interacted with or not -- its absence is a decision
 * recorded here, not an omission.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '@votetorrent/ui-web';
import { fetchAuthorityInvites, AUTHORITY_INVITES_TABLES, authorityInvitesMarkRows, isOpenInvite, PANEL_READ_LOADING, settlePanelRead, markRowsOrNull, markRowKey, markRowSig } from './authority-admin-queries.js';
import { useDataVersion, touchesTables } from '../../live/DataVersionContext.js';
import { useChangeMarks, ChangeMarkWord } from '../../live/useChangeMarks.js';
import { useNow } from '../../live/useNow.js';
import { ReadOnlyNote } from '../../live/ReadOnlyNote.js';
import './authority-admin.css';

const EM_DASH = '—';

type AuthorityInviteRows = Awaited<ReturnType<typeof fetchAuthorityInvites>>;

interface InviteAuthoritiesState {
	status: 'loading' | 'ready' | 'error';
	data: AuthorityInviteRows | null;
}

function formatIsAccepted(value: boolean | null): string {
	if (value === null) return EM_DASH;
	return value ? 'true' : 'false';
}

const InviteAuthoritiesPanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<InviteAuthoritiesState>(PANEL_READ_LOADING);
	const now = useNow();
	const noteId = useId();

	const { version, changedTables } = useDataVersion();
	const [readKey, setReadKey] = useState(0);
	const seenVersionRef = useRef(version);
	useEffect(() => {
		if (version === seenVersionRef.current) return;
		seenVersionRef.current = version;
		if (touchesTables(changedTables, AUTHORITY_INVITES_TABLES)) setReadKey((k) => k + 1);
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
				const data = await fetchAuthorityInvites(boundDb);
				if (mounted) setState((prev) => settlePanelRead(prev, { ok: true, data }));
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('InviteAuthoritiesPanel: read failed:', (err as { name?: string })?.name ?? 'Error');
				if (mounted) setState((prev) => settlePanelRead(prev, { ok: false }));
			}
		})();

		return () => {
			mounted = false;
		};
	}, [db, readKey]);

	const markRows = useMemo(() => markRowsOrNull(state, authorityInvitesMarkRows), [state]);
	const { markClass, isMarked } = useChangeMarks(markRows, markRowKey, markRowSig);

	/** Field class: the base class, the constant mark padding and the mark itself. */
	function markable(key: string, base: string): string {
		return [base, 'aa-markable', markClass(key)].filter((part) => part.length > 0).join(' ');
	}

	if (!db || state.status === 'loading') return null;

	const rows = state.data ?? [];
	if (state.status === 'error' || rows.length === 0) {
		return <p className="aa-empty">{t(capability.emptyKey)}</p>;
	}

	/** One invite's fields; the waiting rows below also point at the note. */
	function inviteFields(row: AuthorityInviteRows[number]) {
		return (
			<dl className="aa-kv">
				<dt>Name</dt>
				<dd>
					{row.Name}
					{isMarked(row.Cid) ? <ChangeMarkWord /> : null}
				</dd>
				<dt>Type</dt>
				<dd title={row.Type}>{row.TypeName ?? row.Type}</dd>
				<dt>Expiration</dt>
				<dd>{row.Expiration}</dd>
				<dt>IsAccepted</dt>
				<dd>{formatIsAccepted(row.IsAccepted)}</dd>
				<dt>CancelledAt</dt>
				<dd>{row.CancelledAt ?? EM_DASH}</dd>
				<dt>Cid</dt>
				<dd className="aa-mono">{row.Cid}</dd>
			</dl>
		);
	}

	const openCids = new Set(rows.filter((row) => isOpenInvite(row, now)).map((row) => row.Cid));
	const openCount = openCids.size;

	return (
		<>
			{openCount > 0 ? <ReadOnlyNote variant="short" id={noteId} /> : null}
			{rows.map((row) =>
				openCids.has(row.Cid) ? (
					<div className={markable(row.Cid, 'aa-row')} key={row.Cid} aria-describedby={noteId}>
						{inviteFields(row)}
					</div>
				) : (
					<div className={markable(row.Cid, 'aa-row')} key={row.Cid}>
						{inviteFields(row)}
					</div>
				),
			)}
		</>
	);
};

export default InviteAuthoritiesPanel;
