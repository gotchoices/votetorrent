/**
 * The ceremony-backed extension of the founding seed: an Election, its
 * founding ElectionRevision (the row carrying the Timeline that drives the
 * three lifecycle phases), two Ballots with three Questions and seven
 * Options between them, and the two `vrg` rows tier 1 CAN create
 * (RegistrationBridgeKey, PollingDevice).
 *
 * TEST SCAFFOLDING, NOT A PRODUCTION WRITE PATH -- same standing exception
 * `seed-founding-authority.js` records: the dashboard makes no writes
 * (D-01), and this fixture reaches the schema through the placeholder-
 * signature admin ceremony (`ceremony()` below, ported in shape from spike
 * 078's `engine.js:76-84`) rather than through `vote-engine`, because the
 * engine entry point that would honour the "write through vote-engine"
 * rule (`NetworksEngine`/`ElectionsEngine`) is exactly what this dashboard
 * is forbidden from importing (outline contract 2). This is not a
 * precedent for any production write path in this app.
 *
 * DATETIME LITERALS HERE ARE CANONICAL 19-CHARACTER, NO `Z` -- the OPPOSITE
 * of `seed-founding-authority.js`'s `Z`-suffixed literals. Both are
 * correct: the founding fixture's literals sit in `isISODatetime`-checked
 * columns under a null `SigningNonce`, where the `Z` is required. Every
 * datetime literal here sits inside a `Digest(...)` tuple that a signed
 * admin ceremony recomputes bit-for-bit -- passing a `Z`-suffixed value
 * would make every one of those digests mismatch and fail closed with a
 * bare `CHECK constraint failed: MutationValid`/`InsertValid` that names
 * nothing about why. Do not "fix" either fixture's literals to match the
 * other's.
 *
 * `RegistrationRequest` and `Registrant` are NOT seeded here -- see
 * `<measured_facts>` in 50-10-PLAN.md. Both carry a row-level
 * `SignatureValid(Digest(...), Signature, Key)` CHECK requiring a genuine
 * secp256k1 (or P-256) signature, and this workspace has no signing
 * dependency and may not add one. This is the CHECK doing its job, not a
 * gap to route around -- `officer-reads.test.mjs`'s tests cover those
 * two tables' read paths at the SQL-validity level instead (zero rows,
 * correct shape), never by fabricating a signature.
 */

// `seed-founding-authority.js` does not export its Authority/User ids, nor
// its Officer's `AdminEffectiveAt` -- they are internal literals in that
// (frozen, unowned-by-this-plan) file. These three constants MUST match
// those internal literals exactly (AdminSigning.UserIdValid requires
// `O.AdminEffectiveAt = new.AdminEffectiveAt` -- a mismatch fails closed
// with a bare `CHECK constraint failed: UserIdValid`, not a helpful
// message); they are re-declared here rather than imported because there
// is nothing to import.
const AUTHORITY_ID = 'a1';
const OFFICER_USER_ID = 'u1';
const ADMIN_EFFECTIVE_AT = '2026-01-01T00:00:00.000Z';

/**
 * The pretend wall clock this seed runs at. Must sit AFTER
 * `ElectionRevision.RevisionTimestamp` (`RevisionTimestampValid`:
 * `RevisionTimestamp < context.now`), BEFORE `Election.Date`
 * (`DateValid`: `Date >= context.now`), and BEFORE both `RevisionDeadline`
 * and `BallotDeadline` (`Ballot.MutationValid` requires
 * `E.BallotDeadline > context.now`). Getting this wrong surfaces as a bare
 * deferred `CHECK constraint failed: RevisionTimestampValid` at COMMIT
 * time, far from the offending statement.
 * @type {string}
 */
export const SEED_NOW = '2026-03-01T00:00:00';

/**
 * The election this fixture creates, and the values `readElectionOverview`
 * / `selectActiveElection` tests assert against directly rather than
 * re-deriving.
 */
export const SEED_ELECTION = Object.freeze({
	id: 'e1',
	title: 'Test County General Election',
	date: '2026-11-03T00:00:00',
	revisionDeadline: '2026-10-01T00:00:00',
	ballotDeadline: '2026-10-01T00:00:00',
	type: 'o',
});

/**
 * The election timeline, canonical string form (inherited-spec item 3's
 * "spike 078 shape"). `derivePhase` reads these ten cut-offs NEWEST-FIRST
 * and the boundaries are half-open: `pre` before `votingStarts`, `voting`
 * from `votingStarts` up to (not including) `tallyingStarts`, `settling`
 * from `tallyingStarts` up to (not including) `closed`, and `closed` from
 * `closed` onward. All four phases are already reachable from the ten
 * events below -- the four-phase model needs NO new timeline event.
 *
 * Grown from seven to ten events (Phase 59, D-08/D-09): `accruingVotes`,
 * `hashingVotes` and `releasingKeys` sit between `votingStarts` and
 * `tallyingStarts`, at `14:00`/`16:00`/`18:00` on the same day. This window
 * is deliberately NARROWER than the plain [08:00, 20:00) `votingStarts` ->
 * `tallyingStarts` span: every instant must fall STRICTLY AFTER
 * `SEED_PHASE_INSTANTS.voting` (12:00, below) -- placing any of the three
 * before 12:00 would make `finestStage` return it instead of `votingStarts`
 * at that instant, breaking
 * `four-phase-alignment.test.mjs`'s `derivePhase(...).stage === 'votingStarts'`
 * assertion at the `voting` phase instant.
 *
 * The `ElectionRevision.Timeline` COLUMN stores the JSON **string** form of
 * this object (`JSON.stringify(SEED_TIMELINE)` at the insert below), and
 * `readElectionOverview` returns it raw and unparsed. Every consumer --
 * `ElectionsPanel.tsx`, the tier-3 browser harness and
 * `test/node/four-phase-alignment.test.mjs` -- therefore exercises
 * `parseTimeline`'s JSON-string path deliberately, because that is the
 * shape production carries.
 * @type {Record<string, string>}
 */
export const SEED_TIMELINE = Object.freeze({
	registrationEnds: '2026-10-05T00:00:00',
	ballotsFinal: '2026-10-01T00:00:00',
	votingStarts: '2026-11-03T08:00:00',
	accruingVotes: '2026-11-03T14:00:00',
	hashingVotes: '2026-11-03T16:00:00',
	releasingKeys: '2026-11-03T18:00:00',
	tallyingStarts: '2026-11-03T20:00:00',
	validation: '2026-11-05T00:00:00',
	certificationStarts: '2026-11-10T00:00:00',
	closed: '2026-11-20T00:00:00',
});

/**
 * One canonical instant per `PHASE_IDS` member, in `PHASE_IDS` order --
 * chosen so `derivePhase(SEED_ELECTION, SEED_TIMELINE, instant)` returns
 * that member and nothing else.
 *
 * This list exists so the tier-3 browser harness
 * (`apps/VoteTorrentDashboard/test/browser/gate-matrix.tsx`) and the tier-1
 * suite read ONE list instead of two: the harness previously carried its own
 * three-entry `INSTANTS` map, which could drift from both the vocabulary and
 * this timeline with nothing to notice.
 * `apps/VoteTorrentDashboard/test/node/four-phase-alignment.test.mjs` binds
 * the key set to `PHASE_IDS` and each value to `derivePhase`'s real output,
 * so a renamed or added phase id fails there first.
 *
 * The first three values are moved verbatim from that harness map (where
 * they carried the retired `organizing`/`running`/`released` ids and were
 * already proven against this very timeline by the `mode=seed` rung); only
 * `closed` is new, and it must stay after `SEED_TIMELINE.closed`.
 *
 * Canonical 19 characters, NO trailing `Z` -- see this file's header for why
 * a `Z` here would be silently stripped and so would test nothing.
 * @type {Readonly<Record<string, string>>}
 */
export const SEED_PHASE_INSTANTS = Object.freeze({
	pre: '2026-06-01T00:00:00',
	voting: '2026-11-03T12:00:00',
	settling: '2026-11-12T00:00:00',
	closed: '2026-11-25T00:00:00',
});

/** Row counts a freshly-run `seedElectionSurface` must leave behind. @type {Record<string, number>} */
export const SEED_EXPECTED_COUNTS = Object.freeze({
	Election: 1,
	ElectionRevision: 1,
	Ballot: 2,
	Question: 3,
	Option: 7,
	RegistrationBridgeKey: 1,
	PollingDevice: 1,
});

let nonceSeq = 0;

/**
 * Run a signing ceremony for one privileged mutation and return its nonce.
 * Ported in shape from spike 078's `engine.js:76-84`. `digestSql` must
 * reproduce EXACTLY the `Digest(...)` tuple the target table's CHECK
 * recomputes, in order, with `Tid` bound as an integer -- callers author
 * `digestSql` as a plain `:name, :name, ...` bind-name list (never a
 * template-interpolated value) and pass the matching values, `tid`
 * included, via `params`.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ scope: string, tid: number, digestSql: string, params?: Record<string, unknown> }} options
 * @returns {Promise<string>}
 */
export async function ceremony(db, { scope, tid, digestSql, params = {} }) {
	const nonce = `n-${scope}-${++nonceSeq}`;
	await db.exec(
		`insert into AdminSigning (Nonce,AuthorityId,AdminEffectiveAt,Scope,Digest,UserId,SignerKey,Signature)
		 with context now = '${SEED_NOW}', IsSignerKeyValid = true, IsPlaceholderSignature = true
		 values (:nonce, '${AUTHORITY_ID}', '${ADMIN_EFFECTIVE_AT}', '${scope}',
		         (select Digest(${digestSql})), '${OFFICER_USER_ID}', 'placeholder-key', 'placeholder-sig')`,
		{ nonce, tid, ...params },
	);
	await db.exec(
		`insert into AdminSignature (SigningNonce) with context IsSignatureValid = true values (:nonce)`,
		{ nonce },
	);
	return nonce;
}

/**
 * Extend an already-`seedFoundingAuthority`'d database with the election
 * surface: `Election`, its founding `ElectionRevision`, two `Ballot`s,
 * three `Question`s, seven `Option`s, one `RegistrationBridgeKey` and one
 * `PollingDevice` -- every row behind a genuine placeholder-signature admin
 * ceremony, no key material. Takes an already-prepared handle; opens
 * nothing and registers nothing.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<void>}
 */
export async function seedElectionSurface(db) {
	const E = SEED_ELECTION;
	const tidE = 101;
	const nE = await ceremony(db, {
		scope: 'mel',
		tid: tidE,
		digestSql: ':tid, :id, :aid, :title, :date, :rev, :bal, :type',
		params: {
			id: E.id,
			aid: AUTHORITY_ID,
			title: E.title,
			date: E.date,
			rev: E.revisionDeadline,
			bal: E.ballotDeadline,
			type: E.type,
		},
	});
	await db.exec(
		`insert into Election (Id,AuthorityId,Title,Date,RevisionDeadline,BallotDeadline,Type)
		 with context SigningNonce = :n, Tid = :tid, now = '${SEED_NOW}'
		 values (:id,'${AUTHORITY_ID}',:title,:date,:rev,:bal,:type)`,
		{
			n: nE,
			tid: tidE,
			id: E.id,
			title: E.title,
			date: E.date,
			rev: E.revisionDeadline,
			bal: E.ballotDeadline,
			type: E.type,
		},
	);

	const R = {
		revision: 0,
		timestamp: '2026-02-01T00:00:00',
		tags: JSON.stringify(['general']),
		instructions: 'Vote for one candidate per office. Bring photo ID to your polling place.',
		timeline: JSON.stringify(SEED_TIMELINE),
		threshold: 3,
	};
	const tidR = 102;
	const nR = await ceremony(db, {
		scope: 'mel',
		tid: tidR,
		digestSql: ':tid, :eid, :rev, :ts, :tags, :ins, :tl, :thr',
		params: {
			eid: E.id,
			rev: R.revision,
			ts: R.timestamp,
			tags: R.tags,
			ins: R.instructions,
			tl: R.timeline,
			thr: R.threshold,
		},
	});
	await db.exec(
		`insert into ElectionRevision (ElectionId,Revision,RevisionTimestamp,Tags,Instructions,Timeline,KeyholderThreshold)
		 with context SigningNonce = :n, Tid = :tid, now = '${SEED_NOW}'
		 values (:eid,:rev,:ts,:tags,:ins,:tl,:thr)`,
		{
			n: nR,
			tid: tidR,
			eid: E.id,
			rev: R.revision,
			ts: R.timestamp,
			tags: R.tags,
			ins: R.instructions,
			tl: R.timeline,
			thr: R.threshold,
		},
	);

	// Two Ballots. Bind names are :bdesc / :bdis, NOT :desc / :dis -- `desc`
	// is a reserved word, and Quereus rejects it after a parameter prefix
	// with "Expected identifier or number after parameter prefix", a parse
	// error naming no column and no statement.
	const ballots = [
		{ id: 'b1', desc: 'Countywide offices', districts: JSON.stringify(['county']) },
		{ id: 'b2', desc: 'District 3 offices and measures', districts: JSON.stringify(['county', 'd3']) },
	];
	let tidB = 200;
	for (const b of ballots) {
		tidB += 1;
		// eslint-disable-next-line no-await-in-loop -- sequential against one shared handle, this project's tier-1 discipline
		const n = await ceremony(db, {
			scope: 'ceb',
			tid: tidB,
			digestSql: ':tid, :id, :eid, :aid, :bdesc, :bdis',
			params: { id: b.id, eid: E.id, aid: AUTHORITY_ID, bdesc: b.desc, bdis: b.districts },
		});
		// eslint-disable-next-line no-await-in-loop
		await db.exec(
			`insert into Ballot (Id,ElectionId,AuthorityId,Description,Districts)
			 with context SigningNonce = :n, Tid = :tid, now = '${SEED_NOW}'
			 values (:id,:eid,'${AUTHORITY_ID}',:bdesc,:bdis)`,
			{ n, tid: tidB, id: b.id, eid: E.id, bdesc: b.desc, bdis: b.districts },
		);
	}

	// Three Questions across the two ballots: two distinct Type codes, one
	// Required = 0, one with a non-null Grouping (bound as :grp, never
	// :group -- the same reserved-word hazard as :desc above).
	const questions = [
		{
			ballotId: 'b1',
			code: 'q1',
			title: 'County Clerk',
			instructions: 'Vote for one.',
			dependsOn: null,
			type: 'select',
			optionRange: JSON.stringify({ min: 1, max: 1 }),
			scoreRange: null,
			grouping: 'offices',
			sequence: 1,
			required: 1,
		},
		{
			ballotId: 'b1',
			code: 'q2',
			title: 'Write-in Comment',
			instructions: 'Optional free text.',
			dependsOn: null,
			type: 'text',
			optionRange: JSON.stringify({ min: 0, max: 0 }),
			scoreRange: null,
			grouping: null,
			sequence: 2,
			required: 0,
		},
		{
			ballotId: 'b2',
			code: 'q1',
			title: 'District 3 Measure Ranking',
			instructions: 'Rank all options.',
			dependsOn: null,
			type: 'rank',
			optionRange: JSON.stringify({ min: 1, max: 3 }),
			scoreRange: null,
			grouping: null,
			sequence: 1,
			required: 1,
		},
	];
	let tidQ = 300;
	for (const q of questions) {
		tidQ += 1;
		// eslint-disable-next-line no-await-in-loop
		const n = await ceremony(db, {
			scope: 'ceb',
			tid: tidQ,
			digestSql: ':tid, :bid, :code, :title, :ins, :dep, :type, :orange, :srange, :grp, :seq, :req',
			params: {
				bid: q.ballotId,
				code: q.code,
				title: q.title,
				ins: q.instructions,
				dep: q.dependsOn,
				type: q.type,
				orange: q.optionRange,
				srange: q.scoreRange,
				grp: q.grouping,
				seq: q.sequence,
				req: q.required,
			},
		});
		// eslint-disable-next-line no-await-in-loop
		await db.exec(
			`insert into Question (BallotId,Code,Title,Instructions,DependsOn,Type,OptionRange,ScoreRange,Grouping,Sequence,Required)
			 with context SigningNonce = :n, Tid = :tid, now = '${SEED_NOW}'
			 values (:bid,:code,:title,:ins,:dep,:type,:orange,:srange,:grp,:seq,:req)`,
			{
				n,
				tid: tidQ,
				bid: q.ballotId,
				code: q.code,
				title: q.title,
				ins: q.instructions,
				dep: q.dependsOn,
				type: q.type,
				orange: q.optionRange,
				srange: q.scoreRange,
				grp: q.grouping,
				seq: q.sequence,
				req: q.required,
			},
		);
	}

	// Seven Options, unevenly distributed (3 / 2 / 2) so per-question option
	// counts differ and a constant OptionCount would fail the read tests.
	const options = [
		{ ballotId: 'b1', questionCode: 'q1', code: 'o1', sequence: 1, title: 'Alex Rivera' },
		{ ballotId: 'b1', questionCode: 'q1', code: 'o2', sequence: 2, title: 'Jordan Blake' },
		{ ballotId: 'b1', questionCode: 'q1', code: 'o3', sequence: 3, title: 'Sam Okafor' },
		{ ballotId: 'b1', questionCode: 'q2', code: 'o1', sequence: 1, title: 'Yes' },
		{ ballotId: 'b1', questionCode: 'q2', code: 'o2', sequence: 2, title: 'No' },
		{ ballotId: 'b2', questionCode: 'q1', code: 'o1', sequence: 1, title: 'Measure 3A' },
		{ ballotId: 'b2', questionCode: 'q1', code: 'o2', sequence: 2, title: 'Measure 3B' },
	];
	let tidO = 400;
	for (const o of options) {
		tidO += 1;
		// eslint-disable-next-line no-await-in-loop
		const n = await ceremony(db, {
			scope: 'ceb',
			tid: tidO,
			digestSql: ':tid, :bid, :qcode, :code, :seq, :title, :details, :infoUrl, :image, :video',
			params: {
				bid: o.ballotId,
				qcode: o.questionCode,
				code: o.code,
				seq: o.sequence,
				title: o.title,
				details: null,
				infoUrl: null,
				image: null,
				video: null,
			},
		});
		// eslint-disable-next-line no-await-in-loop
		await db.exec(
			`insert into Option (BallotId,QuestionCode,Code,Sequence,Title,Details,InfoURL,Image,Video)
			 with context SigningNonce = :n, Tid = :tid, now = '${SEED_NOW}'
			 values (:bid,:qcode,:code,:seq,:title,:details,:infoUrl,:image,:video)`,
			{
				n,
				tid: tidO,
				bid: o.ballotId,
				qcode: o.questionCode,
				code: o.code,
				seq: o.sequence,
				title: o.title,
				details: null,
				infoUrl: null,
				image: null,
				video: null,
			},
		);
	}

	// One RegistrationBridgeKey and one PollingDevice -- the only two `vrg`
	// rows tier 1 can create (Registrant/RegistrationRequest need a genuine
	// signature -- see the file header). These exist so the Registrations
	// panel's read path has a non-zero positive control.
	const tidBridgeKey = 500;
	const nBridgeKey = await ceremony(db, {
		scope: 'vrg',
		tid: tidBridgeKey,
		digestSql: ':tid, :id, :aid, :label, :bkey, :revokedAt',
		params: {
			id: 'bk1',
			aid: AUTHORITY_ID,
			label: 'Paper Intake Desk',
			bkey: 'bridge-public-key-hex',
			revokedAt: null,
		},
	});
	await db.exec(
		`insert into RegistrationBridgeKey (Id,AuthorityId,Label,BridgeKey,RevokedAt)
		 with context SigningNonce = :n, Tid = :tid
		 values (:id,'${AUTHORITY_ID}',:label,:bkey,:revokedAt)`,
		{ n: nBridgeKey, tid: tidBridgeKey, id: 'bk1', label: 'Paper Intake Desk', bkey: 'bridge-public-key-hex', revokedAt: null },
	);

	const tidPollingDevice = 501;
	const nPollingDevice = await ceremony(db, {
		scope: 'vrg',
		tid: tidPollingDevice,
		digestSql: ':tid, :aid, :dhash, :label',
		params: { aid: AUTHORITY_ID, dhash: 'polling-device-hash-1', label: 'Precinct 1 Tablet' },
	});
	await db.exec(
		`insert into PollingDevice (AuthorityId,DeviceHash,Label)
		 with context SigningNonce = :n, Tid = :tid
		 values ('${AUTHORITY_ID}',:dhash,:label)`,
		{ n: nPollingDevice, tid: tidPollingDevice, dhash: 'polling-device-hash-1', label: 'Precinct 1 Tablet' },
	);
}
