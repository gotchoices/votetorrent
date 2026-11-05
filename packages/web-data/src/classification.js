/**
 * classification.js — which schema tables may an ANONYMOUS reader be shown,
 * and the executable rules each answer implies.
 *
 * PROVENANCE. This is a product-owned CORRECTED COPY of spike 087's module,
 * `.claude/skills/spike-findings-votetorrent/sources/087-public-observable-inventory/classification.js`.
 * That spike file is a historical record of what 087 found and is deliberately
 * left untouched; this file is what the product enforces. Three entries differ
 * from the spike, each for a reason recorded on the entry itself (D-15 twice,
 * D-18 once). Everything else — the class vocabulary, all 61 entries, the
 * `[class, why, phases]` tuple shape, `NO_SOURCE` — is carried over verbatim in
 * substance.
 *
 * WHY A POLICY LAYER EXISTS AT ALL (087's central finding, unchanged):
 * VoteTorrent's 41 signature CHECK sites all gate MUTATION. Nothing in
 * `votetorrent.qsql` gates a READ. So "is this row public?" is a policy layer
 * that does not exist in the schema — this file is that layer, written so it
 * can be audited line by line and so the schema growing a table BREAKS the gate
 * rather than silently defaulting the new table to visible (`classOf` throws
 * `UnknownTableError`; every read module resolves each of its tables through it
 * at import).
 *
 * SCAN-ROOT NOTE, so nothing is "fixed" by reflex: this file legitimately
 * contains every forbidden table name as an object KEY — it IS the table list.
 * It therefore sits at `src/` root, OUTSIDE `src/public/`, and 54-08's
 * comment-stripped anonymity scan roots at `packages/web-data/src/public/**`.
 * Widening that scan's root over this file would make the checker permanently
 * green — the self-tripping-checker failure mode this repo has hit repeatedly.
 * Do not widen it.
 *
 * Classes:
 *   PUBLIC        — published governance / election definition. Whole rows renderable.
 *   AGGREGATE     — per-person or operational rows. Counts and distributions only, never rows.
 *   POLICY_GATED  — visibility decided per election by ElectionDisclosurePolicy.
 *   NEVER         — key material, private detail, internal machinery.
 *   DRAFT         — unsigned proposals. Never public: rendering a draft as if it
 *                   were the election is the most dangerous thing this page
 *                   could do, and it is one careless `select` away.
 */

export const CLASS = {
	PUBLIC: 'PUBLIC',
	AGGREGATE: 'AGGREGATE',
	POLICY_GATED: 'POLICY_GATED',
	NEVER: 'NEVER',
	DRAFT: 'DRAFT',
};

/**
 * table -> [class, why, phases] ; phases from spike 086's four-phase model.
 * @type {Readonly<Record<string, readonly [string, string, readonly string[]]>>}
 */
export const CLASSIFICATION = {
	// ── PUBLIC: the published record. This is what a public election view is FOR.
	Network:            [CLASS.PUBLIC, 'Network identity, relays and TSA policy — already broadcast to every peer', ['pre','voting','settling','closed']],
	Authority:          [CLASS.PUBLIC, 'Who runs the election; the root of every signature chain shown', ['pre','voting','settling','closed']],
	Admin:              [CLASS.PUBLIC, 'Signed admin roster — governance transparency', ['pre','voting','settling','closed']],
	Officer:            [CLASS.PUBLIC, 'Officer roster with scopes; who is empowered to do what', ['pre','voting','settling','closed']],
	AdminSigning:       [CLASS.PUBLIC, 'The signing record a viewer needs to verify any published row', ['pre','voting','settling','closed']],
	AdminSignature:     [CLASS.PUBLIC, 'The signature itself — verifiability depends on it being readable', ['pre','voting','settling','closed']],
	OfficerSignature:   [CLASS.PUBLIC, 'Officer counter-signatures on admin changes', ['pre','voting','settling','closed']],
	RevisionCancellation:[CLASS.PUBLIC,'A withdrawn governance proposal is part of the public audit trail', ['pre','voting','settling','closed']],
	Election:           [CLASS.PUBLIC, 'Title, date and the three schema-enforced deadlines', ['pre','voting','settling','closed']],
	ElectionRevision:   [CLASS.PUBLIC, 'Instructions, tags, timeline, keyholder threshold; revision history', ['pre','voting','settling','closed']],
	Ballot:             [CLASS.PUBLIC, 'Ballot definition per district', ['pre','voting','settling','closed']],
	Question:           [CLASS.PUBLIC, 'Ballot questions', ['pre','voting','settling','closed']],
	Option:             [CLASS.PUBLIC, 'Ballot options', ['pre','voting','settling','closed']],
	Keyholder:          [CLASS.PUBLIC, 'WHO holds election keys. PUBLIC as a COUNT and as a roster the authority already publishes — but a per-row join to User is an identity graph, which is why that query lives under src/officer/ (D-04) and the anonymous audience gets counts only (D-14)', ['pre','voting','settling','closed']],
	ElectionKey:        [CLASS.PUBLIC, '62-02 (D-13, D-16): the joint public key voters encrypt ballots to — publishing it is the whole point; it holds only public material (Y and commitments), never a private share', ['pre','voting','settling','closed']],
	KeyholderShareRelease:[CLASS.PUBLIC,'62-02 (D-13, D-17): by design, a released signing share is PUBLIC once released — anyone with k shares may reconstruct (D-17); visible only once the election has reached settling/closed, when release legitimately happens', ['settling','closed']],
	ElectionRegistrationField:[CLASS.PUBLIC,'What a voter must supply to register — must be public to be actionable', ['pre','voting']],
	ElectionDisclosurePolicy:[CLASS.PUBLIC,'The disclosure policy is itself public; it governs RegistrantSelective', ['pre','voting','settling','closed']],
	ElectionAttestationPolicy:[CLASS.PUBLIC,'Whether device attestation is required to associate', ['pre','voting']],
	AuthorityIntakePolicy:[CLASS.PUBLIC,'62-01 (D-29, D-46): mirrors ElectionAttestationPolicy — the signed intake policy voters must read to act on (the https bridge URL and whether re-association is reviewed manually); no person-level column', ['pre','voting']],
	ElectionRecordValidityPolicy:[CLASS.PUBLIC,'How long registrant/association records stay valid', ['pre','voting']],
	AuthorityPeer:      [CLASS.PUBLIC, 'Network topology — which peers an authority runs', ['pre','voting','settling','closed']],
	PollingDevice:      [CLASS.PUBLIC, 'Registered polling devices; where in-person voting happens', ['pre','voting']],

	// ── D-18 CORRECTION (differs from spike 087, which said POLICY_GATED).
	RegistrantPublic:   [CLASS.PUBLIC, 'D-18: the voter roll is published. SCHEMA FINDING that reframed 087: ElectionDisclosurePolicy.FieldName is documented as "a top-level attribute name within RegistrantSelective.SelectiveDetails" (votetorrent.qsql:2298-2300), so the two-audience disclosure policy governs RegistrantSelective ONLY — RegistrantPublic has no per-field audience lever at all. 087 classified both POLICY_GATED; only one of them actually has a policy. The publish decision is D-18 (the table is named public, the authority signs each row under vrg, published rolls are normal practice); D-19 bounds the render to LastName, FirstName, District — NEVER ExtraFields, which votetorrent.qsql:1818 describes as unconstrained authority-supplied JSON', ['pre','voting','settling','closed']],
	// ── POLICY_GATED: the one table that genuinely has a policy, and no evaluator.
	RegistrantSelective:[CLASS.POLICY_GATED, 'Field-by-field via ElectionDisclosurePolicy x DisclosureAudience; anonymous can only ever reach the "everyone" subset. D-22: this phase reads it NOT AT ALL — the everyone subset needs setDisclose/setVerify handling over salted leaves, and no evaluator exists. POLICY_GATED is a FORBIDDEN_CLASSES member, so a public module listing this table is a crash at import rather than a review miss', ['pre','voting','settling','closed']],

	// ── AGGREGATE: counts yes, rows no.
	Registrant:         [CLASS.AGGREGATE, 'Per-person. Count by RegistrantStatus is a strong public stat', ['pre','voting','settling','closed']],
	ElectionRegistrant: [CLASS.AGGREGATE, 'Per-person eligibility roster; count = eligible electorate size', ['pre','voting','settling','closed']],
	Association:        [CLASS.AGGREGATE, 'Per-person device association; count = voters ready to vote', ['pre','voting']],
	User:               [CLASS.AGGREGATE, 'Identities. Count only', ['pre','voting','settling','closed']],
	UserKey:            [CLASS.AGGREGATE, 'Public keys are not secret, but a full key-to-user listing is an identity graph', ['pre','voting','settling','closed']],
	UserEncryptionKey:  [CLASS.AGGREGATE, '62-01 (D-04): mirrors UserKey — public envelope-recipient keys are not secret, but a full key-to-user listing is an identity graph', ['pre','voting','settling','closed']],
	UserEvent:          [CLASS.AGGREGATE, 'Per-user event log — a behavioural trail', ['pre','voting','settling','closed']],
	RegistrationRequest:[CLASS.AGGREGATE, 'Counts by RegistrationRequestStatus = queue health, a genuinely useful public number', ['pre','voting']],
	AssociationRequest: [CLASS.AGGREGATE, 'Counts by AssociationRequestStatus', ['pre','voting']],
	AttestationVerdict: [CLASS.AGGREGATE, 'Device-integrity verdicts; per-device rows identify hardware', ['pre','voting']],
	RegistrantAccessEvent:[CLASS.AGGREGATE,'Audit of who READ registrant data — publishing rows would leak the very access it audits', ['pre','voting','settling','closed']],
	// Vote blocks. Counts are the turnout an observer wants (gap A); a row is per-person: the block
	// row lists its voters' RegistrantIds (frozen voter set) and a voter row names who voted where.
	VoteBlock:          [CLASS.AGGREGATE, 'Encrypted ballot block. count(*) and sum(EntryCount) are public turnout; the row also carries VoterRegistrantIds, so rows are never published', ['voting','settling','closed']],
	VoteBlockVoter:     [CLASS.AGGREGATE, 'Who voted on which ballot, and in which block — never what they voted. count(*) by ballot is turnout; a row names a registrant, so rows are never published', ['voting','settling','closed']],

	// ── D-15 CORRECTION (both differ from spike 087, which said NEVER).
	Task:               [CLASS.AGGREGATE, 'D-15: the ROW is still never published — an operational work-queue row names the user it belongs to. Only count(*) / sum(IsCompleted) over it may reach an anonymous reader (D-14: "N of M keyholders have released", with no task row exposed). Classified AGGREGATE rather than allowlisted so the existing counts-only rule covers it with no carve-out to rot. IsCompleted (votetorrent.qsql:1138) lives HERE, not on the extension table, which is why D-14 needs a join', ['settling','closed']],
	OnboardingTaskExtension:[CLASS.NEVER,'Task extension', []],
	ReleaseKeyTaskExtension:[CLASS.AGGREGATE,'D-15: same treatment as Task, same reason — the row is never published, only count(*) / sum(IsCompleted) over the joined pair may reach an anonymous reader. This table carries the election scope (TaskId, ElectionId, ElectionRevision) and NO status column of its own (votetorrent.qsql:1162-1170), so an aggregate over it alone would count release-key tasks that EXIST, not ones that COMPLETED. It remains the only trace of key release anywhere (087 gap D)', ['settling','closed']],
	NetworkSignatureTaskExtension:[CLASS.NEVER,'Task extension', []],
	AuthoritySignatureTaskExtension:[CLASS.NEVER,'Task extension', []],
	AdminSignatureTaskExtension:[CLASS.NEVER,'Task extension', []],
	ElectionSignatureTaskExtension:[CLASS.NEVER,'Task extension', []],
	ElectionRevisionSignatureTaskExtension:[CLASS.NEVER,'Task extension', []],
	BallotSignatureTaskExtension:[CLASS.NEVER,'Task extension', []],
	RegistrantSignatureTaskExtension:[CLASS.NEVER,'Task extension', []],

	// ── 62-01 (D-03, D-05, D-06, D-07, D-15): the five staging/decision tables the P2P transports
	// land this phase. Three staging tables are NEVER (sealed envelopes in transit plus a clear
	// Digest that is an accepted equality/guessing-oracle exposure, D-47/T-62-01-08 — the public
	// queue-health number already comes from RegistrationRequest/AssociationRequest counts, so not
	// even a row COUNT of the staging tables is needed). The two decision tables are AGGREGATE,
	// mirroring RegistrationRequest: counts by status are decision throughput, but a row names the
	// deciding officer's key, a free-text Reason and, on AssociationDecision, a revoked device key,
	// so individual rows are never published.
	RegistrationRequestStaging:   [CLASS.NEVER, 'Sealed registration-request envelope in transit; the clear Digest is an accepted equality/guessing oracle (D-47), and a count adds nothing RegistrationRequest does not already publish', []],
	AssociationRequestStaging:    [CLASS.NEVER, 'Sealed association-request envelope in transit; same D-47 Digest exposure, same no-added-count reasoning as RegistrationRequestStaging', []],
	AssociationAttestationStaging:[CLASS.NEVER,'Sealed device-attestation-answer envelope in transit; carries the richest device-identifying material of the three staging tables', []],
	KeyholderDkgBinding:[CLASS.NEVER, '62-02 (D-26): protocol plumbing binding a keyholder to their DKG receiving key — a per-keyholder public key and user id, nothing a public reader needs beyond the Keyholder count already published', []],
	KeyholderDkgMessage:[CLASS.NEVER, '62-02 (D-19): DKG round-trip transport — commitments, encrypted R2 share bundles and acks/complaints between keyholders; opaque protocol machinery, not an election artifact', []],
	RegistrationDecision: [CLASS.AGGREGATE, 'Counts by status are decision throughput, a genuinely useful public number (mirrors RegistrationRequest); a row names the deciding officer and a free-text Reason, so rows are never published', ['pre','voting']],
	AssociationDecision:  [CLASS.AGGREGATE, 'Counts by status are decision throughput; a row names the deciding officer, a free-text Reason and, on an approved re-association, a revoked device key, so rows are never published', ['pre','voting']],

	// ── NEVER
	RegistrantPrivate:  [CLASS.NEVER, 'Private registrant detail by definition', []],
	AssociationPrivate: [CLASS.NEVER, 'Private association detail by definition', []],
	RegistrationBridgeKey:[CLASS.NEVER,'Key material', []],
	AttestationChallenge:[CLASS.NEVER,'Live challenge/nonce material — publishing aids replay', []],
	TidHighWater:       [CLASS.NEVER, 'Internal anti-replay allocator (999.1)', []],
	InviteSlot:         [CLASS.NEVER, 'Invitation slots carry CIDs/secrets used to redeem an invite', []],
	InviteResult:       [CLASS.NEVER, 'Invite redemption detail', []],
	InviteCancellation: [CLASS.NEVER, 'Invite lifecycle detail', []],
	Onboarding:         [CLASS.NEVER, 'Internal onboarding state', []],

	// ── Officer-only rows added after the first classification pass.
	AdminCancellation:  [CLASS.NEVER, 'An officer-signed record that stops one administration change before it takes effect (the authority, the change\'s effective time and the cancelling officer\'s user id). Administration machinery that the current roster already reflects, so an anonymous reader needs nothing from it, and it is never shown on the Public page', []],
	DashboardPairingRevocation:[CLASS.NEVER, 'An officer-signed revocation of one dashboard browser pairing (a user id and a pairing nonce). Pairing machinery that only the officer dashboard reads, to unpair itself; nothing an anonymous reader needs, and never shown on the Public page', []],
	ElectionTally:      [CLASS.NEVER, 'The officer-published tally row (the tally tree JSON, the publisher user id and key). It landed unclassified, so this is an INTERIM NEVER: no public or officer reader names it yet. The phase that shows results on the Public page reclassifies it deliberately and re-pins the counts', []],

	// ── DRAFT: unsigned proposals. All ten stay DRAFT, and DRAFT is forbidden:
	// rendering a draft as if it were the election is this page's worst outcome.
	ProposedNetwork:    [CLASS.DRAFT, 'Unsigned proposal', []],
	ProposedAuthority:  [CLASS.DRAFT, 'Unsigned proposal', []],
	ProposedAdmin:      [CLASS.DRAFT, 'Unsigned proposal', []],
	ProposedOfficer:    [CLASS.DRAFT, 'Unsigned proposal', []],
	ProposedOfficerUser:[CLASS.DRAFT, 'Unsigned proposal', []],
	ProposedElection:   [CLASS.DRAFT, 'Unsigned proposal — an election that does not exist yet', []],
	ProposedElectionRevision:[CLASS.DRAFT,'Unsigned proposal', []],
	ProposedBallot:     [CLASS.DRAFT, 'Unsigned proposal — a ballot nobody has signed', []],
	ProposedQuestion:   [CLASS.DRAFT, 'Unsigned proposal', []],
	ProposedOption:     [CLASS.DRAFT, 'Unsigned proposal', []],
};

/**
 * Facts a public observer most wants, which have NO table in the schema.
 * Each cites the prose that promises it, so the gap is attributable. Carried
 * over from 087 unchanged; note that gap D is the one this phase FILLS, by
 * aggregate rather than by a new table (D-14 + D-15, D-13 forbids the table).
 * @type {ReadonlyArray<readonly [string, string, string, string]>}
 */
export const NO_SOURCE = [
	['A', 'Ballots cast so far / turnout during voting', 'doc/election.md:95-110', 'The schema now models blocks (VoteBlock, VoteBlockVoter; both AGGREGATE, so count(*) by ballot is turnout), but no public reader counts them yet and nothing writes them until a block former exists.'],
	['B', 'Voter-verifiable receipt (check my vote nonce is included)', 'doc/election.md:97', 'The nonce is held privately by the voter; nothing on the network to check it against.'],
	['C', 'Merkle root of the vote blocks', 'doc/election.md:114', 'No Block or MerkleNode table. Prose still asks "Q: Where is this stored and cached?".'],
	['D', 'Keyholder key-release status (how many of N released)', 'doc/election.md:118-122', 'Keyholder names WHO holds a key; nothing records WHETHER one was released. Only ReleaseKeyTaskExtension exists, and Task is internal.'],
	['E', 'Tally / results / per-level histogram', 'doc/election.md:124-132', 'No Tally table. Prose still asks "Q: How is this coordinated?".'],
	['F', 'Validation report and suggested error margin', 'doc/election.md:134-153', 'No Validation table. Prose still asks "Q: How is this built and stored?".'],
	['G', 'Certification (positive/negative, per ballot authority)', 'doc/election.md:155-159', 'No Certification table. Prose still asks "Q: How specifically is this built and stored?".'],
	['H', 'Runoff trigger / runoff status', 'doc/election.md:196-228', 'No runoff modelling of any kind.'],
];

/* ─────────────────────────────────────────────────────────────────────────────
 * The executable form of the rules the class vocabulary above states in prose.
 * Everything below is frozen and exported; the public read modules call it at
 * MODULE SCOPE, so a widening edit is a crash at import, not a review miss.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Classes an anonymous reader may reach at all. AGGREGATE is reachable for counts ONLY — the class name is the contract, and `assertNoIdentifyingColumns` is the enforcement. @type {ReadonlyArray<string>} */
export const PUBLIC_SAFE_CLASSES = Object.freeze([CLASS.PUBLIC, CLASS.AGGREGATE]);

/**
 * Classes no public module may list. POLICY_GATED sits here because no policy
 * evaluator exists (D-22) — NOT because the class is unreachable forever. When
 * a `setDisclose`/`setVerify` evaluator lands, that entry is the thing to
 * revisit; NEVER and DRAFT are permanent.
 * @type {ReadonlyArray<string>}
 */
export const FORBIDDEN_CLASSES = Object.freeze([CLASS.NEVER, CLASS.DRAFT, CLASS.POLICY_GATED]);

/**
 * Column-name tokens that identify a PERSON if they appear in a public select
 * list. Per token, why:
 *   UserId       — on Task, this answers WHICH keyholder released a key (D-14).
 *   SigningNonce — on Task, the same answer by another route: the nonce ties
 *                  the row back to one AdminSigning record and so to one user.
 *   ExtraFields  — RegistrantPublic's unconstrained authority-supplied JSON
 *                  (votetorrent.qsql:1818); publishing it publishes whatever an
 *                  authority happened to put there, unreviewed (D-19).
 *   RegistrantId — a correlation handle from a roll row back into Registrant.
 *   PublicCid    — likewise: Registrant.PublicCid is the roll row's content hash.
 *   PrivateCid   — likewise, and it addresses the private tier specifically.
 *   SelectiveCid — likewise, for the selective tier (D-22's table).
 * @type {ReadonlyArray<string>}
 */
export const IDENTIFYING_COLUMN_TOKENS = Object.freeze([
	'UserId',
	'SigningNonce',
	'ExtraFields',
	'RegistrantId',
	'PublicCid',
	'PrivateCid',
	'SelectiveCid',
]);

/** Thrown when a table name is not in CLASSIFICATION at all — the schema grew and the gate was not updated. */
export class UnknownTableError extends Error {
	/** @param {string} table */
	constructor(table) {
		super(`UnknownTableError: table "${table}" is not classified; classify it in packages/web-data/src/classification.js before reading it`);
		this.name = 'UnknownTableError';
	}
}

/** Thrown when a module declares a table whose class is forbidden for its audience. */
export class ForbiddenTableError extends Error {
	/** @param {string} table @param {string} cls @param {string} moduleLabel */
	constructor(table, cls, moduleLabel) {
		super(`ForbiddenTableError: ${moduleLabel} declares table "${table}", classified ${cls}`);
		this.name = 'ForbiddenTableError';
	}
}

/** Thrown when a select list contains a person-identifying column token. */
export class IdentifyingColumnError extends Error {
	/** @param {string} token @param {string} moduleLabel */
	constructor(token, moduleLabel) {
		super(`IdentifyingColumnError: ${moduleLabel} selects the identifying column token "${token}"`);
		this.name = 'IdentifyingColumnError';
	}
}

/** Thrown when `selectListOf` cannot locate a select list — it fails CLOSED rather than returning an empty string a guard would then happily approve. */
export class UnparseableSelectError extends Error {
	/** @param {string} reason */
	constructor(reason) {
		super(`UnparseableSelectError: ${reason}`);
		this.name = 'UnparseableSelectError';
	}
}

/**
 * The class of one table. Throws `UnknownTableError` for any name not in
 * `CLASSIFICATION` — 087's stated design intent made executable: the schema
 * growing a table must BREAK the gate, never default the new table to visible.
 * The message names the table name only; it never carries a row value.
 *
 * @param {string} table
 * @returns {string}
 */
export function classOf(table) {
	if (!Object.prototype.hasOwnProperty.call(CLASSIFICATION, table)) throw new UnknownTableError(table);
	return CLASSIFICATION[table][0];
}

/**
 * Assert every table a public module reads is reachable by an anonymous
 * audience. Throws `ForbiddenTableError` (naming the error class, the table and
 * the module — never row content) on the first forbidden member, and
 * `UnknownTableError` via `classOf` on an unclassified one.
 *
 * @param {ReadonlyArray<string>} tables
 * @param {string} moduleLabel
 * @returns {void}
 */
export function assertPublicSafe(tables, moduleLabel) {
	for (const table of tables) {
		const cls = classOf(table);
		if (FORBIDDEN_CLASSES.includes(cls)) throw new ForbiddenTableError(table, cls, moduleLabel);
	}
}

/**
 * The substring between a statement's leading `select` and its first ` from `.
 *
 * DELIBERATELY NAIVE, and fails closed: it throws `UnparseableSelectError`
 * rather than returning something a guard would approve by default. Any future
 * public SQL with a subquery in its select list must be REWRITTEN, not have
 * this helper loosened — a loosened helper is how a guard starts passing for
 * the wrong reason.
 *
 * @param {string} sql
 * @returns {string}
 */
export function selectListOf(sql) {
	const trimmed = sql.trim();
	if (!/^select\s/i.test(trimmed)) throw new UnparseableSelectError('statement does not begin with "select"');
	const fromAt = trimmed.toLowerCase().indexOf(' from ');
	if (fromAt < 0) throw new UnparseableSelectError('statement contains no " from " clause');
	return trimmed.slice('select'.length, fromAt);
}

/**
 * Assert a statement's SELECT LIST names no person-identifying column.
 *
 * It checks the select list ONLY, deliberately: `public/read-keyrelease.js`'s
 * join condition legitimately mentions `T.Id`, and forbidding a bare `Id`
 * anywhere in a statement would forbid `Election.Id` too. Restricting the check
 * to the select list is what lets the D-14 join stay legal while `UserId` and
 * `SigningNonce` cannot appear in anything the function returns.
 *
 * @param {string} sql
 * @param {string} moduleLabel
 * @returns {void}
 */
export function assertNoIdentifyingColumns(sql, moduleLabel) {
	const selectList = selectListOf(sql);
	for (const token of IDENTIFYING_COLUMN_TOKENS) {
		if (selectList.includes(token)) throw new IdentifyingColumnError(token, moduleLabel);
	}
}
