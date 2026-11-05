/**
 * liveness-gate.tsx — the harness for 56-14's computed-style browser gate
 * (Surface 5: D-16's UI feedback half, D-19's UI half).
 *
 * Modelled on `test/offline/offline-gate.tsx`'s own shape: imports
 * `../../src/app.css` FIRST so the built bundle carries `app.css`,
 * `tokens.css` and `components.css`; the module-constant `source` awaits the
 * real `attachNetworkDb` and records the resolved handle; a bounded
 * `requestAnimationFrame` poll settles readiness — never a fixed sleep. See
 * that file's own header for the conventions this one inherits rather than
 * re-derives.
 *
 * MOUNTS `ElectionShell` DIRECTLY, NEVER `PublicApp`. `PublicApp.tsx` (56-14,
 * Task 1) owns the ONE production `startPublicPeerBoot` call site, and this
 * gate's whole subject is the seam from `applyPeerRowBatch` +
 * `notifyPeerWrite` onward — the real store write, the real projection, the
 * real hook, the real render, the real CSS. The libp2p transport and the
 * threshold-signature verification IN FRONT OF that seam are `56-11`'s proof
 * (`test:mesh-read`) and are not re-claimed here; mounting `PublicApp` would
 * additionally attempt a real peer dial this gate's `publicDir: false` build
 * has no `config.json` to satisfy, and would conflate two different proofs.
 *
 * `peerFeed` ARRIVES FROM THIS PAGE'S OWN `?feed=` PARAMETER, constrained to
 * the three-valued union `usePublicElection` accepts. Anything else is a
 * HARNESS ERROR recorded on the readout, never a silent default — a silently
 * defaulted `'unobserved'` would make rung 5's `feed=stopped` navigation
 * indistinguishable from a typo.
 *
 * WHY `applyLocalWrite` CANNOT USE `Election` AS ITS OWN FIRING VEHICLE, and
 * how it is built instead — measured this session, stated here rather than
 * discovered by a future reader chasing a rung that stays green for the
 * wrong reason:
 *
 *   1. `Election`'s own schema carries `constraint InsertOnly check on
 *      update, delete (false)` (`votetorrent.qsql`) — an UNCONDITIONAL
 *      CHECK. An ordinary SQL `update ... set Title = ...` against `Election`
 *      is refused by the engine itself, with or without a valid signing
 *      context; there is no legitimate SQL path that changes an existing
 *      election's title.
 *   2. `Database.ingestExternalRowChanges` (the seam `applyPeerRowBatch`
 *      wraps) NEVER fires a module `db.onDataChange` event, under EITHER
 *      `captureChanges` setting — measured directly this session, not
 *      inferred from the docstring: `captureChanges` feeds `Database.watch`'s
 *      post-commit dispatch, a DIFFERENT subscription system from the
 *      per-module `onDataChange` `subscribe.js` listens on. So the external
 *      seam can silently change what a handle reads without ever notifying
 *      that handle's own subscription — which is exactly why `notifyPeerWrite`
 *      exists as a SEPARATE, manually-invoked channel (`REMOTE_SINKS`), and
 *      exactly why that channel has no `remote: false` mode: nothing about
 *      it is tied to a genuine local engine event at all.
 *   3. So `applyLocalWrite` does TWO things, deliberately, and the second is
 *      the one that makes the discrimination real: (a) apply the SAME
 *      Title-changing external write `applyPeerBatch` uses, SILENTLY (no
 *      `notifyPeerWrite` call) — the store now holds the new title, and
 *      nothing has been told; then (b) perform a GENUINE, ordinary SQL
 *      `delete` against a seeded `Keyholder` row -- the exact row
 *      `test/browser/live-read-gate.js`'s own rung 7 already proved needs no
 *      signing ceremony to touch -- through THIS SAME handle. That delete is
 *      real engine DML: it fires a REAL local `db.onDataChange` event,
 *      delivered with `remote` unset (`event?.remote === true` is false), so
 *      `subscribeToPublicChanges` marks the resulting notice `remote: false`.
 *      That notice is what actually reaches `bumpDataVersion` and forces the
 *      full re-read that reveals the ALREADY-CHANGED title. The rendered
 *      title change is therefore genuine and the triggering notice is
 *      genuinely local — exactly what rung 4 needs to discriminate, and the
 *      only way this schema admits it.
 *
 * WHY THIS GATE SEEDS A SECOND ELECTION UNDER ITS OWN PRODUCTION-LENGTH ID,
 * RATHER THAN REUSING `FIXTURE_ELECTION_DB_ID`. `seed-public-surface.js`'s
 * own header records that `FIXTURE_ELECTION_DB_ID` (`SEED_ELECTION.id`,
 * `'e1'`) is a deliberately SHORT, 2-character seed token — exactly the
 * `project_ui_defects_invisible_to_every_tier` shape the runner's own
 * anti-vacuity check refuses (a requested election id under 43 characters,
 * or failing `ELECTION_ID_PATTERN`, is a hard bail, never a pass). `e1`
 * would make every navigation this gate makes vacuous by construction. This
 * file therefore clones `e1`'s own `Election`/`ElectionRevision` rows
 * BYTE-IDENTICAL except for the id (via the SAME external-write seam
 * `applyPeerBatch` uses), under `LIVENESS_ELECTION_ID` (43 characters,
 * `ELECTION_ID_PATTERN`-conformant, distinct from `UNHELD_ELECTION_ID`), and
 * bumps `writeRowCounts` by exactly the two rows added — `attachNetworkDb`
 * compares live counts to the recorded ones EXACTLY (`reattach.js`'s
 * `assertRowCounts`) and would refuse every subsequent attach with
 * `RowCountMismatchError` otherwise. The original `e1` election is left
 * completely untouched; nothing this gate does affects
 * `PUBLIC_SURFACE_EXPECTED_COUNTS`'s own meaning for any OTHER gate, and no
 * other gate shares this gate's own origin (port 5196) or its IndexedDB
 * namespace.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { ElectionShell } from '../../src/screens/ElectionShell';
import { LIVE_UPDATE_BADGE_MS } from '../../src/screens/use-public-election';
import type { PublicPeerFeedState } from '../../src/screens/use-public-election';
import { DEFAULT_PUBLIC_SOURCE } from '../../src/public-election-source.js';
import type { PublicSourceDeps } from '../../src/public-election-source.js';
import { ELECTION_ADDRESS_PARAM, NETWORK_ADDRESS_PARAM } from '../../src/election-address.js';
import { applyPeerRowBatch } from '../../src/peer/reactivity-bridge.js';
import {
	FIXTURE_NETWORK_HASH,
	FIXTURE_ELECTION_DB_ID,
	FIXTURE_REVISION,
	FIXTURE_SETTLING_INSTANT,
	LIVENESS_ELECTION_ID,
	PUBLIC_SURFACE_EXPECTED_COUNTS,
	SEED_NOW,
	SEED_ELECTION,
	seedPublicSurface,
} from '../fixtures/seed-public-surface.js';
import { seedKeyholderPrerequisites, insertBoundKeyholder } from '../fixtures/seed-bound-keyholder.js';
import { createNetworkDb, closeNetworkDb, deleteNetworkDb, writeRowCounts, upsertNetwork, notifyPeerWrite } from '@votetorrent/web-data/public';

declare global {
	interface Window {
		__LIVENESS_GATE__?: Readonly<{
			harness: string;
			requestedElectionId: string | null;
			requestedFeed: string | null;
			error: string | null;
			handleRecorded: boolean;
			liveUpdateBadgeMs: number;
			applyPeerBatch: (title: string) => Promise<number>;
			applyLocalWrite: (title: string) => Promise<void>;
		}>;
		__UI_GATE_DONE__?: boolean;
	}
}

// ---------------------------------------------------------------------------
// Fixture-parameter resolution. The election id / network hash are read off
// THIS PAGE's own URL (defaulting to the seeded fixture values), same idiom
// `offline-gate.tsx`'s 'stale' branch uses. `feed` is THIS page's own second
// parameter, read by this file only.
// ---------------------------------------------------------------------------

const FEED_PARAM = 'feed';
const VALID_FEED_VALUES: ReadonlyArray<PublicPeerFeedState> = Object.freeze(['unobserved', 'running', 'stopped']);

const pageParams = new URLSearchParams(window.location.search);
const requestedFeedRaw = pageParams.get(FEED_PARAM);
const feedValue: PublicPeerFeedState | null = (VALID_FEED_VALUES as ReadonlyArray<string>).includes(requestedFeedRaw ?? '')
	? (requestedFeedRaw as PublicPeerFeedState)
	: null;

const networkHash = pageParams.get(NETWORK_ADDRESS_PARAM) ?? FIXTURE_NETWORK_HASH;
const electionId = pageParams.get(ELECTION_ADDRESS_PARAM) ?? LIVENESS_ELECTION_ID;
const SEARCH = `?${NETWORK_ADDRESS_PARAM}=${networkHash}&${ELECTION_ADDRESS_PARAM}=${electionId}`;

// ---------------------------------------------------------------------------
// The module-constant `source` (56-12/D-17's own precedent). A MODULE
// constant, never a per-render object literal: `source` is one of
// `use-public-election.ts`'s own effect dependencies, and a fresh object
// every render would re-run the read on every commit. `attachNetworkDb`
// awaits the REAL one and RECORDS the resolved handle -- the whole reason
// this gate can be honest: `notifyPeerWrite` dispatches to `REMOTE_SINKS`
// keyed by the `db` OBJECT, so a notice sent against any other handle would
// never reach this page's subscription and every rung would be vacuous.
// ---------------------------------------------------------------------------

let recordedHandle: import('@quereus/quereus').Database | null = null;

const source: PublicSourceDeps = Object.freeze({
	...DEFAULT_PUBLIC_SOURCE,
	attachNetworkDb: async (attachHash: string, options?: unknown) => {
		const real = await DEFAULT_PUBLIC_SOURCE.attachNetworkDb(attachHash, options as never);
		recordedHandle = real as unknown as import('@quereus/quereus').Database;
		return real;
	},
});

/**
 * The one keyholder row seeded FOR THE CLONED ELECTION, dedicated to
 * `applyLocalWrite`'s own delete. `'u1'` already carries a Keyholder row
 * against `FIXTURE_ELECTION_DB_ID` (`e1`) -- a DIFFERENT primary-key tuple
 * (`Keyholder`'s PK is `(ElectionId, ElectionRevision, UserId)`), so reusing
 * the same `UserId` here creates no collision. Inserted through GENUINE SQL,
 * via `seed-bound-keyholder.js` (62-02, D-26: `Keyholder.InsertValid` now
 * requires a signed `KeyholderDkgBinding` in the same transaction), never the
 * external-write seam -- this row's whole purpose is to be deleted by a real,
 * local `db.onDataChange`-firing statement later.
 */
const LOCAL_WRITE_KEYHOLDER_USER_ID = 'u1';

/**
 * Clone `FIXTURE_ELECTION_DB_ID`'s own `Election`/`ElectionRevision` rows
 * BYTE-IDENTICAL except for the id, under `LIVENESS_ELECTION_ID` -- see this
 * file's own header for why. Uses the SAME external-write seam
 * `applyPeerBatch`/`applyLocalWrite` use (bypassing `Election`'s own
 * `InsertOnly` posture is exactly what this seam is for), against the
 * SEEDING handle, not the page's own. Also seeds ONE dedicated `Keyholder`
 * row for the cloned election -- see `LOCAL_WRITE_KEYHOLDER_USER_ID`'s own
 * comment.
 */
async function seedLivenessElection(db: import('@quereus/quereus').Database): Promise<void> {
	const schemaName = db.schemaManager.getCurrentSchemaName();
	const electionSchema = db.schemaManager.getTable(schemaName, 'Election');
	const revisionSchema = db.schemaManager.getTable(schemaName, 'ElectionRevision');
	if (!electionSchema || !revisionSchema) {
		throw new Error('seedLivenessElection: the seeding handle declares no schema for Election/ElectionRevision');
	}
	const baseElection = (await db.prepare('select * from Election where Id = :id').get({ id: FIXTURE_ELECTION_DB_ID })) as
		| Record<string, unknown>
		| undefined;
	const baseRevision = (await db.prepare('select * from ElectionRevision where ElectionId = :id').get({ id: FIXTURE_ELECTION_DB_ID })) as
		| Record<string, unknown>
		| undefined;
	if (!baseElection || !baseRevision) {
		throw new Error('seedLivenessElection: the base fixture election/revision was not found -- seedPublicSurface must run first');
	}
	const electionRow = electionSchema.columns.map((column: { name: string }) =>
		column.name === 'Id' ? LIVENESS_ELECTION_ID : baseElection[column.name],
	);
	const revisionRow = revisionSchema.columns.map((column: { name: string }) =>
		column.name === 'ElectionId' ? LIVENESS_ELECTION_ID : baseRevision[column.name],
	);
	await applyPeerRowBatch(db, 'Election', [{ op: 'upsert', row: electionRow as never }]);
	await applyPeerRowBatch(db, 'ElectionRevision', [{ op: 'upsert', row: revisionRow as never }]);
	// 62-02 (D-26): prerequisites before the observed write, insertBoundKeyholder
	// AS the write -- u1 already has a UserKey from seedPublicSurface's own
	// seedKeyReleaseTasks call, so this only adds an InviteSlot/InviteResult
	// scoped to LIVENESS_ELECTION_ID.
	const prereq = await seedKeyholderPrerequisites(db, {
		electionId: LIVENESS_ELECTION_ID,
		userId: LOCAL_WRITE_KEYHOLDER_USER_ID,
		userName: 'vtx-fixture Liveness Keyholder',
		now: SEED_NOW,
	});
	await insertBoundKeyholder(db, prereq, { electionId: LIVENESS_ELECTION_ID, revision: FIXTURE_REVISION, tid: 56014 });
}

/**
 * Seed the same public surface `test/offline/offline-gate.tsx` and
 * `test/browser/election-shell-gate.tsx` each seed — same recipe, same
 * reason: this branch's read path is `findNetwork` -> `attachNetworkDb`, and
 * `attachNetworkDb` refuses a handle with no persisted row-count record.
 * Unlike `offline-gate.tsx`'s 'stale' branch, this gate's `source` wraps the
 * handle UNCHANGED (no channel-hiding Proxy) -- the whole point here is a
 * REAL change channel that a real notice can travel through. Additionally
 * clones a second, production-length-id election -- see this file's own
 * header and `seedLivenessElection`'s own comment.
 */
async function seedFixtureSurface(): Promise<void> {
	try {
		await deleteNetworkDb(FIXTURE_NETWORK_HASH);
	} catch {
		// A database that was never created is the normal first-run case.
	}
	const db = await createNetworkDb(FIXTURE_NETWORK_HASH);
	try {
		await seedPublicSurface(db);
		await seedLivenessElection(db);
		await writeRowCounts(FIXTURE_NETWORK_HASH, {
			...PUBLIC_SURFACE_EXPECTED_COUNTS,
			Election: PUBLIC_SURFACE_EXPECTED_COUNTS.Election + 1,
			ElectionRevision: PUBLIC_SURFACE_EXPECTED_COUNTS.ElectionRevision + 1,
			Keyholder: PUBLIC_SURFACE_EXPECTED_COUNTS.Keyholder + 1,
			// 62-02 (D-26): seedLivenessElection's own InviteSlot/InviteResult/
			// KeyholderDkgBinding trio for its one extra Keyholder (its UserKey is
			// NOT new -- u1 already has one from seedPublicSurface).
			InviteSlot: PUBLIC_SURFACE_EXPECTED_COUNTS.InviteSlot + 1,
			InviteResult: PUBLIC_SURFACE_EXPECTED_COUNTS.InviteResult + 1,
			KeyholderDkgBinding: PUBLIC_SURFACE_EXPECTED_COUNTS.KeyholderDkgBinding + 1,
		});
		upsertNetwork({
			networkHash: FIXTURE_NETWORK_HASH,
			authorityName: 'vtx-fixture Authority',
			domain: 'vtx-fixture.invalid',
			officerUserId: 'u1',
			bootstrappedAt: SEED_NOW,
		});
	} finally {
		await closeNetworkDb(db);
	}
}

// ---------------------------------------------------------------------------
// The two drivers. Both operate on `recordedHandle` -- the SAME handle the
// mounted page reads through -- never a second, differently-routed handle.
// ---------------------------------------------------------------------------

/** @returns the current full `Election` row, keyed by column name. */
async function currentElectionRow(): Promise<Record<string, unknown>> {
	if (recordedHandle === null) throw new Error('no handle recorded yet -- attachNetworkDb has not resolved');
	const row = await recordedHandle.prepare('select * from Election where Id = :electionId').get({ electionId });
	if (!row) throw new Error(`no Election row found for id "${electionId}"`);
	return row as Record<string, unknown>;
}

/**
 * Re-order `row` against the handle's own schema for `Election`, replacing
 * `Title` with `newTitle` and leaving every other column BYTE-IDENTICAL --
 * the same `toUiOrderedRow` technique `src/peer/strand-read.js` uses for the
 * production read path, re-derived here (this harness does not import that
 * module's private helper).
 */
function electionRowWithTitle(row: Record<string, unknown>, newTitle: string): unknown[] {
	if (recordedHandle === null) throw new Error('no handle recorded yet -- attachNetworkDb has not resolved');
	const schemaName = recordedHandle.schemaManager.getCurrentSchemaName();
	const tableSchema = recordedHandle.schemaManager.getTable(schemaName, 'Election');
	if (!tableSchema) throw new Error('the recorded handle declares no schema for Election');
	return tableSchema.columns.map((column: { name: string }) => (column.name === 'Title' ? newTitle : row[column.name]));
}

/**
 * The peer path. Real `applyPeerRowBatch` + real `notifyPeerWrite`, against
 * the recorded handle. Resolves with the EFFECTIVE change count so a no-op
 * write is visible to the runner rather than being read as a delivered
 * update. Derives the notify op from the returned effective change; never
 * hardcodes one.
 */
async function applyPeerBatch(title: string): Promise<number> {
	const row = await currentElectionRow();
	const ordered = electionRowWithTitle(row, title);
	const changes = await applyPeerRowBatch(recordedHandle as unknown as Parameters<typeof applyPeerRowBatch>[0], 'Election', [
		{ op: 'upsert', row: ordered as never },
	]);
	if (changes.length > 0) {
		notifyPeerWrite(recordedHandle, FIXTURE_NETWORK_HASH, 'Election', changes[0].op);
	}
	return changes.length;
}

/**
 * The discrimination path. See this file's own header for why it is built
 * from two steps rather than one, and why `Election` cannot be the vehicle
 * for the second. Calls `notifyPeerWrite` NOT AT ALL.
 *
 * A THIRD STEP, MEASURED THIS SESSION AND NOT PREDICTED BY EITHER PLAN'S OWN
 * TEXT: any notice at all -- remote or local -- increments this page's
 * invalidation counter, which re-runs `use-public-election.ts`'s WHOLE
 * attach effect, which calls `attachNetworkDb` AGAIN. `attachNetworkDb`
 * re-validates EVERY recorded row count on EVERY attach (`reattach.js`'s
 * `assertRowCounts`, exact equality). So the genuine `delete` above, having
 * just reduced the live `Keyholder` count by one, would make that very next
 * re-attach throw `RowCountMismatchError` -- turning the discrimination rung
 * into a FAULT page instead of a title change. This corrects the recorded
 * expectation to match the new live count immediately after the delete,
 * using the same `writeRowCounts` the seeding step calls -- never a second
 * db handle, never a race: `writeRowCounts` writes straight to storage and
 * needs no handle at all.
 */
async function applyLocalWrite(title: string): Promise<void> {
	const row = await currentElectionRow();
	const ordered = electionRowWithTitle(row, title);
	await applyPeerRowBatch(recordedHandle as unknown as Parameters<typeof applyPeerRowBatch>[0], 'Election', [
		{ op: 'upsert', row: ordered as never },
	]);
	if (recordedHandle === null) throw new Error('no handle recorded yet -- attachNetworkDb has not resolved');
	await recordedHandle.exec(
		'delete from Keyholder where ElectionId = :electionId and ElectionRevision = :revision and UserId = :userId',
		{ electionId, revision: FIXTURE_REVISION, userId: LOCAL_WRITE_KEYHOLDER_USER_ID },
	);
	await writeRowCounts(FIXTURE_NETWORK_HASH, {
		...PUBLIC_SURFACE_EXPECTED_COUNTS,
		Election: PUBLIC_SURFACE_EXPECTED_COUNTS.Election + 1,
		ElectionRevision: PUBLIC_SURFACE_EXPECTED_COUNTS.ElectionRevision + 1,
		// 62-02 (D-26): the delete above removes only the Keyholder row (hence no
		// override for it here — it reverts to the base count). Its
		// InviteSlot/InviteResult/KeyholderDkgBinding siblings are NOT deleted
		// (the first two are InsertOnly; the binding is NoDelete), so the live
		// count is STILL seedLivenessElection's +1 — these three must stay
		// overridden here or the very next re-attach (triggered by this delete's
		// own local notice) throws RowCountMismatchError before the title ever
		// re-renders.
		InviteSlot: PUBLIC_SURFACE_EXPECTED_COUNTS.InviteSlot + 1,
		InviteResult: PUBLIC_SURFACE_EXPECTED_COUNTS.InviteResult + 1,
		KeyholderDkgBinding: PUBLIC_SURFACE_EXPECTED_COUNTS.KeyholderDkgBinding + 1,
	});
}

// ---------------------------------------------------------------------------
// Mount.
// ---------------------------------------------------------------------------

const rootElement = document.getElementById('root');
if (!rootElement) {
	throw new Error('liveness-gate.tsx: #root element not found in liveness-gate.html');
}
const gateContainer: HTMLElement = rootElement;

let harnessError: string | null =
	feedValue === null ? `invalid or missing "${FEED_PARAM}" query parameter: ${JSON.stringify(requestedFeedRaw)}` : null;

async function mount(): Promise<void> {
	if (harnessError !== null) return;
	try {
		await seedFixtureSurface();
	} catch (err) {
		harnessError = harnessError ?? `seed failed: ${String((err as { message?: unknown })?.message ?? err)}`;
		return;
	}
	try {
		createRoot(gateContainer).render(
			<StrictMode>
				<ElectionShell search={SEARCH} at={FIXTURE_SETTLING_INSTANT} source={source} peerFeed={feedValue ?? undefined} />
			</StrictMode>,
		);
	} catch (err) {
		harnessError = harnessError ?? String((err as { message?: unknown })?.message ?? err);
	}
}

/**
 * Bounded `requestAnimationFrame` poll -- NEVER a fixed sleep -- on the same
 * precedent `offline-gate.tsx`/`election-shell-gate.tsx` set.
 */
function settleUntilMounted(maxFrames: number, ready: () => boolean): Promise<void> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (ready() || frames >= maxFrames) {
				resolve();
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

/**
 * The ready predicate: wait for `.election-title` to carry the SEEDED
 * fixture title, read from the seeded fixture and never transcribed. A
 * predicate that resolves during `reading` is the single most likely way
 * this gate would report a false green.
 */
function pageReady(): boolean {
	const el = document.querySelector('#root .election-title');
	return el !== null && (el.textContent ?? '') === SEED_ELECTION.title;
}

const mountPromise = mount();

mountPromise
	.then(() => (harnessError === null ? settleUntilMounted(900, pageReady) : undefined))
	.then(() => {
		window.__LIVENESS_GATE__ = Object.freeze({
			harness: 'liveness-gate',
			requestedElectionId: electionId,
			requestedFeed: requestedFeedRaw,
			error: harnessError,
			handleRecorded: recordedHandle !== null,
			liveUpdateBadgeMs: LIVE_UPDATE_BADGE_MS,
			applyPeerBatch,
			applyLocalWrite,
		});
		window.__UI_GATE_DONE__ = true;
	});
