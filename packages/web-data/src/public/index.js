/**
 * public/index.js — the anonymous-reader barrel of `@votetorrent/web-data`.
 *
 * Serves `apps/VoteTorrentPublic`, an unauthenticated visitor with no officer
 * identity. This barrel must NEVER re-export anything under `src/officer/`
 * (D-04) — that boundary is what makes the `./public` / `./officer` subpath
 * split structural rather than decorative.
 *
 * The connection layer (`open-db.js`, `reattach.js`, `networks-registry.js`)
 * landed here in this plan's Task 2 — explicit named re-exports only, never
 * `export *`, so the surface of this audience is readable at a glance and
 * 54-08's scan has a literal list to reason about. It is audience-neutral: it
 * opens a database and selects no application table.
 *
 * The public read modules landed in 54-06: `read-election.js` (header,
 * founding revision, election list), `read-registrant-roll.js` (D-18/D-19's
 * three-column voter roll) and `read-keyrelease.js` (D-14's counts-only
 * aggregate). Each module's raw SQL constants are deliberately NOT re-exported
 * here — they exist for that module's own import-time guards and for 54-08's
 * scan, which imports the modules by path. Each module's `TABLES_READ` IS
 * re-exported, under a module-qualified name, because three modules cannot all
 * re-export a binding of that name from one barrel without colliding — the
 * same convention `officer/index.js` adopted in 54-03b.
 */
export {
	STORE_MODULE_NAME,
	DB_NAME_PREFIX,
	dbNameFor,
	openStoreHandle,
	createNetworkDb,
	closeNetworkDb,
	listObjectStores,
	deleteNetworkDb,
} from '../open-db.js';

export {
	NotBootstrappedError,
	MissingRowCountsError,
	RowCountMismatchError,
	InvalidRowCountRecordError,
	ROW_COUNTS_KEY_PREFIX,
	rowCountsKeyFor,
	writeRowCounts,
	readRowCountsRecord,
	clearRowCounts,
	readRowCounts,
	assertRowCounts,
	attachNetworkDb,
} from '../reattach.js';

export {
	NETWORKS_REGISTRY_KEY,
	InvalidNetworkRegistryError,
	listNetworks,
	findNetwork,
	upsertNetwork,
	removeNetwork,
} from '../networks-registry.js';

export {
	readPublicElection,
	readPublicElectionRevision,
	listPublicElections,
	TABLES_READ as ELECTION_TABLES_READ,
} from './read-election.js';

export { readRegistrantRoll, TABLES_READ as ROLL_TABLES_READ } from './read-registrant-roll.js';

export { readKeyReleaseProgress, TABLES_READ as KEYRELEASE_TABLES_READ } from './read-keyrelease.js';

// D-27's live-read seam (54-15). ADDITIVE: nothing above changed. The
// allowlist it exports is DERIVED from the three read modules' own
// `TABLES_READ` above, so the notification channel this barrel publishes can
// never be wider than the read channel it publishes beside it.
export {
	PUBLIC_SUBSCRIBED_TABLES,
	subscribeToPublicChanges,
	enableChangePropagation,
	notifyPeerWrite,
} from './subscribe.js';

/**
 * @typedef {import('../open-db.js').DeleteNetworkDbOptions} DeleteNetworkDbOptions
 * @typedef {import('../reattach.js').StorageAdapter} StorageAdapter
 * @typedef {import('../reattach.js').RowCountsRecord} RowCountsRecord
 * @typedef {import('../networks-registry.js').NetworkRegistryEntry} NetworkRegistryEntry
 * @typedef {import('./read-election.js').PublicElection} PublicElection
 * @typedef {import('./read-election.js').PublicElectionRevision} PublicElectionRevision
 * @typedef {import('./read-election.js').PublicElectionListEntry} PublicElectionListEntry
 * @typedef {import('./read-registrant-roll.js').RegistrantRollRow} RegistrantRollRow
 * @typedef {import('./read-keyrelease.js').KeyReleaseProgress} KeyReleaseProgress
 * @typedef {import('./subscribe.js').PublicChangeNotice} PublicChangeNotice
 * @typedef {import('./subscribe.js').PublicChangeSubscription} PublicChangeSubscription
 * @typedef {import('./subscribe.js').ChangePropagation} ChangePropagation
 */
