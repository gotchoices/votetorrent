/**
 * officer/index.js — the authenticated-officer barrel of `@votetorrent/web-data`.
 *
 * Serves `apps/VoteTorrentDashboard`, the dashboard app used by a signed-in
 * officer. This barrel re-exports the audience-neutral connection layer plus
 * everything scoped to `src/officer/` (per-capability read helpers,
 * `CAPABILITY_TABLES`).
 *
 * `CAPABILITY_TABLES` landed in 54-03a's Task 1 — needed ahead of Task 2 so
 * `capabilities.test.mjs`'s cross-check could import it "through the
 * package's real export surface, not a file read". The connection layer
 * (`open-db.js`, `reattach.js`, `networks-registry.js`) landed in 54-03a's
 * Task 2 — explicit named re-exports only, never `export *`, so the surface
 * of this audience is readable at a glance.
 *
 * 54-06 adds `read-keyholders.js`, the per-row `Keyholder` join `User` roster.
 * It is exported HERE and nowhere under `src/public/`: that placement is what
 * makes D-04's audience split structural — the public audience's counterpart to
 * it, `public/read-keyrelease.js`, answers the same subject with counts alone.
 *
 * The officer read helpers (`elections.js`, `ballots.js`, `registrations.js`)
 * land here in 54-03b. Same discipline, one addition: each module also
 * exports its own `TABLES_READ` constant, and three modules cannot all
 * re-export a binding named `TABLES_READ` from one barrel without a
 * collision — so each is re-exported under a module-qualified name
 * (`ELECTIONS_TABLES_READ` / `BALLOTS_TABLES_READ` / `REGISTRATIONS_TABLES_READ`)
 * rather than as a namespace object, keeping every read function itself a
 * flat, directly-importable name for the three dashboard panels.
 *
 * The live dashboard's store surface lives here and never in `./public`
 * (D-04 audience split): `attachLiveDb` opens a peer-fed local copy without
 * the snapshot-era row-count record, `subscribe.js` carries row-less,
 * per-network change notices, and the registry's pairing record, legacy
 * check and last-pass time are exported alongside the existing registry
 * functions. The pairing tables include the revocation table, which is
 * officer only.
 */
export { CAPABILITY_TABLES } from './capability-tables.js';

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
	isLegacyEntry,
	recordLastPassAt,
	PAIRING_RELAY_ADDRS_MAX,
} from '../networks-registry.js';

export { attachLiveDb, LiveStoreMissingError, LiveStoreUnavailableError } from './attach-live.js';

export {
	PAIRING_TABLES,
	ADMIN_PANEL_AND_GATE_TABLES,
	OFFICER_SUBSCRIBED_TABLES,
	OFFICER_CHANGE_OPS,
	OFFICER_CHANGE_CHANNEL_PREFIX,
	officerChangeChannelName,
	notifyOfficerPeerWrite,
	subscribeToOfficerChanges,
} from './subscribe.js';

export {
	selectActiveElection,
	readElectionOverview,
	readElectionPolicies,
	countElections,
	TABLES_READ as ELECTIONS_TABLES_READ,
} from './elections.js';

export { readBallots, readQuestions, parseOptionRange, countBallotSigningTasks, TABLES_READ as BALLOTS_TABLES_READ } from './ballots.js';

export {
	ROSTER_PAGE_SIZE,
	readRegistrantStatusBreakdown,
	readRegistrationRequestBreakdown,
	readRegistrantRoster,
	readRegistrationSurfaceCounts,
	hasAnyRegistrationData,
	readRegistrationIntakeSeries,
	IntakeSeriesReadError,
	TABLES_READ as REGISTRATIONS_TABLES_READ,
} from './registrations.js';
// readRegistrationIntakeSeries (D-04, C3) -- 60-05's Registrations panel is
// the consumer. The three pure bucket helpers and the SQL constants stay OUT
// of this barrel: they are internals, reached by direct module URL in
// registrations-intake.test.mjs, and this barrel's job is to keep the
// officer audience's surface readable at a glance.

export { readKeyholders, TABLES_READ as KEYHOLDER_TABLES_READ } from './read-keyholders.js';

/**
 * @typedef {import('../open-db.js').DeleteNetworkDbOptions} DeleteNetworkDbOptions
 * @typedef {import('../reattach.js').StorageAdapter} StorageAdapter
 * @typedef {import('../reattach.js').RowCountsRecord} RowCountsRecord
 * @typedef {import('../networks-registry.js').NetworkRegistryEntry} NetworkRegistryEntry
 * @typedef {import('../networks-registry.js').PairingRecord} PairingRecord
 * @typedef {'absent' | 'not-initialized'} LiveStoreMissingReason
 * @typedef {import('./subscribe.js').OfficerChangeNotice} OfficerChangeNotice
 * @typedef {import('./elections.js').ActiveElection} ActiveElection
 * @typedef {import('./elections.js').ElectionOverview} ElectionOverview
 * @typedef {import('./elections.js').ElectionPolicies} ElectionPolicies
 * @typedef {import('./elections.js').RegistrationFieldBreakdownRow} RegistrationFieldBreakdownRow
 * @typedef {import('./ballots.js').BallotRow} BallotRow
 * @typedef {import('./ballots.js').QuestionRow} QuestionRow
 * @typedef {import('./registrations.js').StatusBreakdownRow} StatusBreakdownRow
 * @typedef {import('./registrations.js').RequestBreakdownRow} RequestBreakdownRow
 * @typedef {import('./registrations.js').RosterRow} RosterRow
 * @typedef {import('./registrations.js').RosterResult} RosterResult
 * @typedef {import('./registrations.js').SurfaceCountEntry} SurfaceCountEntry
 * @typedef {import('./registrations.js').IntakeBucketRow} IntakeBucketRow
 * @typedef {import('./read-keyholders.js').KeyholderRosterRow} KeyholderRosterRow
 */
