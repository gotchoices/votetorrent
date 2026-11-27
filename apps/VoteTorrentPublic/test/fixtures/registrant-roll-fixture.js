/**
 * registrant-roll-fixture.js — TEST-ONLY. Nothing under
 * `apps/VoteTorrentPublic/src` may import this file (D-17): a production
 * bundle containing these facts would let a public page assert election facts
 * that are not true, on a page whose entire purpose is that its claims can be
 * checked. `test/node/election-harness.test.mjs` asserts the absence of any
 * import specifier reaching `fixtures/` (or `test/`) from `src/`.
 *
 * Frozen exports, and no import from anything this app builds — the one import
 * below is the signing primitive, nothing else. Every rendered string carries
 * the literal `vtx-fixture` marker so a `dist/` scan has a token to name.
 *
 * ONE EXTRA HEADER RULE, SPECIFIC TO THIS FILE. These rows are SYNTHETIC
 * PERSONAL DATA that is rendered verbatim on an ANONYMOUS page. Nothing
 * transforms them in between. So:
 *   - every `District` value must contain the literal `vtx-fixture`; and
 *   - no name may be a plausible real person's.
 * A reader who somehow reached this data in production must be able to tell at
 * a glance that it is scaffolding. `public-fixtures.test.mjs` asserts the
 * district marker on every row the roll read returns, so a row that lost it
 * fails tier 1 rather than shipping quietly.
 *
 * WHY THIS FILE EXISTS AT ALL. Until it landed, no fixture in this repo seeded
 * `RegistrantPublic`, so `readRegistrantRoll` had only ever been observed
 * returning `[]` — its `RP.Cid = R.PublicCid` fan-out pin and its
 * `R.Status = 'a'` filter were asserted by SOURCE SCAN only, and a scan proves
 * the column list, not that the join returns the rows the list describes.
 *
 * PRODUCTION-LENGTH BY MANDATE, NOT BY TASTE (D-19). Every `lastName` and
 * `firstName` here is at least 12 characters and every `district` at least 20,
 * per 54-UI-SPEC § Fixture & Sample-Instant Requirements item 2. This project
 * has TWICE shipped a UI defect every gate passed because the fixture was too
 * short to fail: an 84-character code that clipped silently, and a 7-character
 * name that satisfied a check a production-length one would not. Shortening any
 * value here re-opens that blindness.
 *
 * THE DISTRICT DISTRIBUTION IS DELIBERATELY UNBALANCED (`60-08`'s
 * `render-fidelity-gate.mjs` rung `roll-district-bars-proportional-and-folded`).
 * One district per row — the shape this fixture used to have — would put
 * every district's count at exactly one, which is below
 * `SMALL_DISTRICT_THRESHOLD` (`../../src/roll-disclosure.js`) for all of
 * them: every district would fold into "Other" and that rung could never
 * distinguish a SELECTIVE fold (the privacy control D-09 actually specifies)
 * from a TOTAL one (every district folds regardless of size) or from a
 * broken chart mount
 * — all three produce a single "Other" bar. This fixture instead seeds two
 * districts at or above the exported threshold and two below it, so that
 * rung can observe the fold firing selectively. Restoring the one-per-row
 * shape re-opens that blindness; do not "simplify" this distribution back to
 * it.
 *
 * ONE MORE CONSTRAINT ON THE EXACT COUNTS, discovered live rather than
 * planned: `r-roll-4`'s district literally contains the standalone digit `5`
 * ("...<b>Ward</b> 5 Precinct 40..."), and the existing
 * `keyrelease-renders-filled-with-nonzero-released` rung scans the WHOLE text
 * of every filled fact card for the seeded released/total pair (`3`/`5`,
 * `keyrelease-fixture.js`'s `EXPECTED_RELEASED`/`EXPECTED_TOTAL`) as
 * standalone numbers. Since `60-06` mounts the district chart INSIDE the same
 * fact card as the roll table, that card's own bar-count labels AND its
 * numeric axis ticks (Recharts renders a tick per integer step up to the
 * largest bar's count) are also scanned — so the largest surviving district's
 * count must never let a `3` tick appear, or it would combine with
 * `r-roll-4`'s literal "Ward 5" to falsely satisfy that unrelated rung on the
 * wrong card. Both surviving districts sit AT the fold threshold (2 rows
 * each) specifically to keep the axis's largest tick at 2, not 3 or higher —
 * measured live: at a max bar count of 2 Recharts ticks 0/0.5/1/1.5/2 (no
 * standalone `3`); at a max of 4 it ticks 0/1/2/3/4 (a `3` IS present).
 */

import { generatePrivateKey, getPublicKey, sign } from '@optimystic/quereus-plugin-crypto';

/**
 * The authority that signs every row here. `seed-founding-authority.js` does
 * not export its Authority id — it is an internal literal in that (frozen,
 * unowned-by-this-plan) file — so it is re-declared here rather than imported,
 * exactly as `seed-election-surface.js` re-declares it. A mismatch fails closed
 * with a bare `CHECK constraint failed: AuthorityIdValid`.
 * @type {string}
 */
const AUTHORITY_ID = 'a1';

/**
 * `Registrant.ExpirationValid` is `isISODatetime(Expiration) and like('%Z',
 * Expiration)` — this column REQUIRES the trailing `Z`, the exact opposite of
 * the canonical 19-character no-`Z` form every other datetime in these fixtures
 * uses. Do not "fix" it to match the others.
 * @type {string}
 */
const EXPIRATION = '2027-11-03T00:00:00Z';

/**
 * The same instant with the `Z` stripped. `Registrant.MutationValid` contains a
 * subquery, so Quereus promotes it to a DEFERRED check whose row snapshot
 * re-derives `new.Expiration` through a Temporal round-trip that strips the
 * trailing `Z`. The ceremony digest must therefore commit to the STRIPPED form
 * even though the row is bound with the `Z`. This mirrors vote-engine's
 * `toDeferredCheckDatetime` (`signing/ceremony-helpers.ts:66`), which
 * `registration-engine.ts`'s real `createRegistrant`/`updateRegistrantRow`
 * paths both use for this exact digest.
 * @type {string}
 */
const EXPIRATION_DEFERRED = EXPIRATION.replace(/Z$/, '');

/**
 * The literal that must never reach the DOM. Every seeded row's `ExtraFields`
 * is the JSON object `{"vtxNeverRender":"<this marker>"}`.
 *
 * Seeding `ExtraFields` NON-NULL ON PURPOSE is what turns D-19 from an omission
 * into a PROVABLE ABSENCE: an empty column could never fail, so a test over it
 * would report green while proving nothing. `votetorrent.qsql:1818` describes
 * the column as unconstrained, unreviewed, authority-supplied JSON with no
 * schema to reason about — which is exactly why `readRegistrantRoll` never
 * selects it.
 * @type {string}
 */
export const EXTRA_FIELDS_MARKER = 'EXTRAFIELDS-MUST-NOT-RENDER';

/** The `ExtraFields` JSON every seeded public record carries. @type {string} */
const EXTRA_FIELDS_JSON = JSON.stringify({ vtxNeverRender: EXTRA_FIELDS_MARKER });

/**
 * The six registrants whose CURRENT public records make up the roll, across
 * 4 districts — two districts AT `SMALL_DISTRICT_THRESHOLD` (North Riverbend,
 * 2 rows; Bracketed Ward, 2 rows) and two below it (Southgate Township, New
 * Millrace, 1 row each), so `60-08`'s C7 rung can observe D-09's fold firing
 * SELECTIVELY — and, since both survivors sit exactly AT the threshold, that
 * the boundary itself (count == threshold survives, not just count >>
 * threshold) is what is proven, not merely "big districts survive". See this
 * file's header for why this distribution, not a one-district-per-row shape,
 * is load-bearing, and why both survivors are capped at exactly 2 rather than
 * left larger.
 *
 * `r-roll-3` is the reissued registrant: this is its CURRENT record, and
 * `ROLL_SUPERSEDED` below is the one it replaced. Both rows persist —
 * `RegistrantPublic.InsertOnly` forbids the update and the delete — so the
 * roll's join genuinely fans out to two rows for that registrant and the
 * `RP.Cid = R.PublicCid` pin is what resolves it back to one. Its district
 * (New Millrace) stays below the fold threshold, so its name is absent from
 * the rendered chart for a second, independent reason.
 *
 * `r-roll-4` IS THE SECURITY ROW, and its shape is deliberate.
 * `RegistrantPublic` holds authority-supplied text that reaches an anonymous
 * page unreviewed, and the security domain's standing control against stored
 * XSS is React's JSX text-node escaping. This row is what makes that control
 * OBSERVABLE rather than assumed: a rung can require both that no `script`
 * element exists under the roll and that this exact string is present as text.
 * NEVER render this value through `dangerouslySetInnerHTML` anywhere. Its
 * district (Bracketed Ward) is kept AT the fold threshold (two rows) so it
 * SURVIVES the fold and the chart itself becomes an escaping probe, rather
 * than retiring this control by folding the markup-bearing district away.
 *
 * @type {ReadonlyArray<Readonly<{ id: string, lastName: string, firstName: string, district: string }>>}
 */
export const ROLL_REGISTRANTS = Object.freeze([
	Object.freeze({
		id: 'r-roll-1',
		lastName: 'Vandersteenhoven',
		firstName: 'Wilhelmina-Rose',
		district: 'North Riverbend Ward 7 Precinct 12 (vtx-fixture)',
	}),
	Object.freeze({
		id: 'r-roll-2',
		lastName: 'Okonkwo-Barrington',
		firstName: 'Bartholomeus',
		district: 'Southgate Township Precinct 4A (vtx-fixture)',
	}),
	Object.freeze({
		id: 'r-roll-3',
		lastName: 'Pemberton-Ashdown',
		firstName: 'Marguerite-Annelise',
		district: 'New Millrace Ward 8 Precinct 31 (vtx-fixture)',
	}),
	Object.freeze({
		id: 'r-roll-4',
		lastName: '<script>vtxFixtureXss()</script>',
		firstName: 'Angelicaesther',
		district: 'Bracketed <b>Ward</b> 5 Precinct 40 (vtx-fixture)',
	}),
	Object.freeze({
		id: 'r-roll-5',
		lastName: 'Quillfeather-Nwosu',
		firstName: 'Constantijn-Ade',
		district: 'North Riverbend Ward 7 Precinct 12 (vtx-fixture)',
	}),
	Object.freeze({
		id: 'r-roll-6',
		lastName: 'Brightwater-Osei',
		firstName: 'Thaddeus-Emeka',
		district: 'Bracketed <b>Ward</b> 5 Precinct 40 (vtx-fixture)',
	}),
]);

/**
 * `r-roll-3`'s SUPERSEDED public record — the registrant's FIRST state, before
 * the reissue moved `Registrant.PublicCid` to the current record's content id.
 *
 * THE INVARIANT THAT MAKES IT USEFUL AS A PROBE: `ROLL_SUPERSEDED.lastName`
 * must not be a substring of any current `lastName`, AND no current `lastName`
 * may be a substring of it. Only then can a DOM search or a result-set search
 * for this string never match the CURRENT record by accident — otherwise "the
 * superseded name is absent" would be unfalsifiable. `public-fixtures.test.mjs`
 * asserts BOTH directions rather than trusting the chosen strings.
 *
 * @type {Readonly<{ id: string, lastName: string, firstName: string, district: string }>}
 */
export const ROLL_SUPERSEDED = Object.freeze({
	id: 'r-roll-3',
	lastName: 'Ashdown-Prior',
	firstName: 'Marguerite-Anne',
	district: 'Old Millrace Ward 3 Precinct 22 (vtx-fixture)',
});

/** The six last names `readRegistrantRoll` must return — no more, no fewer. @type {ReadonlyArray<string>} */
export const EXPECTED_ROLL_LAST_NAMES = Object.freeze(ROLL_REGISTRANTS.map((r) => r.lastName));

/**
 * Row counts this fixture leaves behind.
 *
 * `RegistrantPublic` is SEVEN, not six: the superseded row is never deleted
 * (`InsertOnly check on update, delete (false)`), which is precisely the
 * production condition the roll's `RP.Cid = R.PublicCid` predicate defends
 * against.
 * @type {Readonly<Record<string, number>>}
 */
export const ROLL_EXPECTED_COUNTS = Object.freeze({
	Registrant: 6,
	ElectionRegistrant: 6,
	RegistrantPublic: 7,
});

/**
 * Ask the DATABASE for the content id `RegistrantPublic.CidValid` will
 * recompute. The argument order must match
 * `cid(Digest(RegistrantId, LastName, FirstName, District, ExtraFields))`
 * exactly.
 *
 * COMPUTED IN SQL, NEVER IN JS. Recomputing the same tuple with a JS digest
 * helper does not reproduce what the CHECK recomputes, and the failure is a
 * bare `CHECK constraint failed: CidValid` naming nothing.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ id: string, lastName: string, firstName: string, district: string }} entry
 * @returns {Promise<string>}
 */
async function publicCidFor(db, entry) {
	const row = await db.prepare('select cid(Digest(:rid, :last, :first, :district, :extra)) as c').get({
		rid: entry.id,
		last: entry.lastName,
		first: entry.firstName,
		district: entry.district,
		extra: EXTRA_FIELDS_JSON,
	});
	if (row?.c == null) {
		throw new Error('registrant-roll-fixture: cid(Digest(...)) returned null — crypto plugin not registered?');
	}
	return String(row.c);
}

/**
 * Ask the DATABASE for the digest `Registrant.SignatureValid` will recompute,
 * then sign it. Same "in SQL, never in JS" rule as `publicCidFor`.
 *
 * The encodings are not free choices: they must match the verifier
 * `registerDbPlugins` installs (`packages/vote-engine/src/database/initialize.ts`'s
 * `verifySig`), which is base64url digest / hex signature / hex key.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ id: string, pc: string, pub: string | null, sel: string | null, st: string }} row
 * @param {string} priv
 * @returns {Promise<string>}
 */
async function signRegistrantRow(db, row, priv) {
	const digestRow = await db
		.prepare('select Digest(:id, :aid, :pc, :pub, :sel, :st, :exp) as d')
		.get({ id: row.id, aid: AUTHORITY_ID, pc: row.pc, pub: row.pub, sel: row.sel, st: row.st, exp: EXPIRATION });
	if (digestRow?.d == null) {
		throw new Error('registrant-roll-fixture: Digest() returned null — crypto plugin not registered?');
	}
	// `String(...)`: the plugin's return type is `string | Uint8Array` because the
	// output encoding is a runtime argument. `'hex'` always yields a string —
	// the coercion is for the type checker, and narrows nothing at runtime.
	return String(sign(String(digestRow.d), priv, 'secp256k1', 'base64url', 'hex', 'hex'));
}

/**
 * Seed six `Registrant` rows, their six `ElectionRegistrant` enrolments
 * and SEVEN `RegistrantPublic` rows — one registrant having had its public
 * record REISSUED — behind a real `vrg` signing ceremony and a real
 * secp256k1 signature.
 *
 * `ceremony` IS A PARAMETER, NOT AN IMPORT. The helper lives in
 * `packages/web-data/test/fixtures/seed-election-surface.js`; injecting it
 * keeps this module reachable from both the tier-1 suite and a browser bundle
 * without this file reaching across the package boundary itself.
 *
 * `Registrant.SignatureValid` calls the crypto plugin FOR REAL — unlike
 * `AdminSigning`, this table has NO `context.IsSignatureValid` escape hatch —
 * so these rows carry an actual secp256k1 signature. ONE keypair is generated
 * for the whole fixture; the authority signs every row.
 *
 * TWO ORDERING RULES, AND THEY ARE THE WHOLE REASON THIS WORKS:
 *
 *  (a) THE REISSUE IS NOT WRAPPED IN A TRANSACTION.
 *      `RegistrantPublic.RegistrantCidMatch` contains a subquery and is
 *      therefore deferred to COMMIT. Each `db.exec` autocommits, so the
 *      superseded row is validated at ITS OWN commit, while
 *      `Registrant.PublicCid` still equals the old content id. Batching the
 *      reissue into one transaction would evaluate that row's deferred check
 *      AFTER the update moved `PublicCid` forward, and the superseded row would
 *      be rejected — the fan-out this fixture exists to create would silently
 *      never form.
 *      (`keyrelease-fixture.js` needs the EXACT OPPOSITE for its Task/extension
 *      pair. Both are stated side by side in that file's header so the contrast
 *      reads as deliberate rather than as an inconsistency to "fix".)
 *
 *  (b) The superseded row SURVIVES the update because constraints are evaluated
 *      against the MUTATING table's rows: updating `Registrant` does not
 *      re-evaluate `RegistrantPublic`'s checks. `InsertOnly` then makes the
 *      superseded row permanent.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {(db: import('@quereus/quereus').Database, options: { scope: string, tid: number, digestSql: string, params?: Record<string, unknown> }) => Promise<string>} ceremony
 * @param {{ electionId: string, seedNow: string }} options
 * @returns {Promise<void>}
 */
export async function seedRegistrantRoll(db, ceremony, options) {
	const { electionId, seedNow } = options ?? {};
	if (!electionId) throw new Error('seedRegistrantRoll: options.electionId is required');
	if (!seedNow) throw new Error('seedRegistrantRoll: options.seedNow is required');

	// `String(...)` on both: see `signRegistrantRow`'s note — `'hex'` always
	// yields a string, and the coercion exists for the type checker only.
	const priv = String(generatePrivateKey('secp256k1', 'hex'));
	const signorKey = String(getPublicKey(priv, 'secp256k1', 'hex', 'hex'));

	let tid = 5100;
	const nextTid = () => ++tid;

	/**
	 * Ceremony + insert for one `Registrant` row.
	 * @param {{ id: string, pc: string, pub: string, sel: string | null, st: string }} row
	 */
	const insertRegistrant = async (row) => {
		const sg = await signRegistrantRow(db, row, priv);
		const t = nextTid();
		const n = await ceremony(db, {
			scope: 'vrg',
			tid: t,
			digestSql: ':tid, :id, :aid, :pc, :pub, :sel, :st, :expDeferred, :sk, :sg',
			params: {
				id: row.id,
				aid: AUTHORITY_ID,
				pc: row.pc,
				pub: row.pub,
				sel: row.sel,
				st: row.st,
				expDeferred: EXPIRATION_DEFERRED,
				sk: signorKey,
				sg,
			},
		});
		await db.exec(
			`insert into Registrant (Id,AuthorityId,PrivateCid,PublicCid,SelectiveCid,Status,Expiration,SignorKey,Signature)
			 with context SigningNonce = :n, Tid = :tid, now = '${seedNow}'
			 values (:id,:aid,:pc,:pub,:sel,:st,:exp,:sk,:sg)`,
			{
				n,
				tid: t,
				id: row.id,
				aid: AUTHORITY_ID,
				pc: row.pc,
				pub: row.pub,
				sel: row.sel,
				st: row.st,
				exp: EXPIRATION,
				sk: signorKey,
				sg,
			},
		);
	};

	/**
	 * Ceremony + insert for one `ElectionRegistrant` enrolment.
	 * `RegistrantNotExpired` compares `Expiration > context.now`, so `seedNow`
	 * must stay the base fixture's `SEED_NOW`.
	 * @param {string} registrantId
	 */
	const enrol = async (registrantId) => {
		const t = nextTid();
		const n = await ceremony(db, {
			scope: 'vrg',
			tid: t,
			digestSql: ':tid, :eid, :rid',
			params: { eid: electionId, rid: registrantId },
		});
		await db.exec(
			`insert into ElectionRegistrant (ElectionId,RegistrantId)
			 with context SigningNonce = :n, Tid = :tid, now = '${seedNow}'
			 values (:eid,:rid)`,
			{ n, tid: t, eid: electionId, rid: registrantId },
		);
	};

	/**
	 * Ceremony + insert for one `RegistrantPublic` record.
	 *
	 * NOTE THE NARROWER CONTEXT ENVELOPE: `RegistrantPublic` declares only
	 * `( SigningNonce text, Tid int )`. Passing a `now` here is a PARSE-level
	 * failure, not a constraint failure — a different and much more confusing
	 * error than the ones above.
	 * @param {{ id: string, lastName: string, firstName: string, district: string }} entry
	 * @param {string} cidValue
	 */
	const insertPublic = async (entry, cidValue) => {
		const t = nextTid();
		const n = await ceremony(db, {
			scope: 'vrg',
			tid: t,
			digestSql: ':tid, :cid, :rid, :last, :first, :district, :extra',
			params: {
				cid: cidValue,
				rid: entry.id,
				last: entry.lastName,
				first: entry.firstName,
				district: entry.district,
				extra: EXTRA_FIELDS_JSON,
			},
		});
		await db.exec(
			`insert into RegistrantPublic (Cid,RegistrantId,LastName,FirstName,District,ExtraFields)
			 with context SigningNonce = :n, Tid = :tid
			 values (:cid,:rid,:last,:first,:district,:extra)`,
			{
				n,
				tid: t,
				cid: cidValue,
				rid: entry.id,
				last: entry.lastName,
				first: entry.firstName,
				district: entry.district,
				extra: EXTRA_FIELDS_JSON,
			},
		);
	};

	for (const entry of ROLL_REGISTRANTS) {
		const isReissued = entry.id === ROLL_SUPERSEDED.id;

		// The registrant's FIRST state. For the reissued registrant that is the
		// SUPERSEDED content, not the current one.
		const firstEntry = isReissued ? { ...ROLL_SUPERSEDED, id: entry.id } : entry;
		// eslint-disable-next-line no-await-in-loop -- sequential against one shared handle, this project's tier-1 discipline
		const cidFirst = await publicCidFor(db, firstEntry);

		// eslint-disable-next-line no-await-in-loop
		await insertRegistrant({ id: entry.id, pc: `cid-priv-${entry.id}`, pub: cidFirst, sel: null, st: 'a' });
		// eslint-disable-next-line no-await-in-loop
		await enrol(entry.id);
		// eslint-disable-next-line no-await-in-loop
		await insertPublic(firstEntry, cidFirst);

		if (!isReissued) continue;

		// --- The reissue. See ordering rules (a) and (b) in this function's doc. ---
		// eslint-disable-next-line no-await-in-loop
		const cidNew = await publicCidFor(db, entry);
		// eslint-disable-next-line no-await-in-loop
		const sgNew = await signRegistrantRow(
			db,
			{ id: entry.id, pc: `cid-priv-${entry.id}`, pub: cidNew, sel: null, st: 'a' },
			priv,
		);
		const tUpdate = nextTid();
		// eslint-disable-next-line no-await-in-loop
		const nUpdate = await ceremony(db, {
			scope: 'vrg',
			tid: tUpdate,
			digestSql: ':tid, :id, :aid, :pc, :pub, :sel, :st, :expDeferred, :sk, :sg',
			params: {
				id: entry.id,
				aid: AUTHORITY_ID,
				pc: `cid-priv-${entry.id}`,
				pub: cidNew,
				sel: null,
				st: 'a',
				expDeferred: EXPIRATION_DEFERRED,
				sk: signorKey,
				sg: sgNew,
			},
		});
		// REBIND `Expiration`, `SignorKey` AND `Signature` EXPLICITLY even though
		// only `PublicCid` is changing. A partial UPDATE that leaves a datetime
		// column out of the SET list lets the CHECK evaluate a Z-stripped
		// snapshot of it — a recorded trap in this project — and the digest
		// `SignatureValid` recomputes includes `Expiration`. This mirrors
		// `registration-engine.ts`'s own `updateRegistrantRow`, which rebinds the
		// same 4 columns for the same reason.
		// eslint-disable-next-line no-await-in-loop
		await db.exec(
			`update Registrant
			 with context SigningNonce = :n, Tid = :tid, now = '${seedNow}'
			 set PublicCid = :pub, Expiration = :exp, SignorKey = :sk, Signature = :sg
			 where Id = :id`,
			{ n: nUpdate, tid: tUpdate, id: entry.id, pub: cidNew, exp: EXPIRATION, sk: signorKey, sg: sgNew },
		);
		// eslint-disable-next-line no-await-in-loop
		await insertPublic(entry, cidNew);
	}
}
