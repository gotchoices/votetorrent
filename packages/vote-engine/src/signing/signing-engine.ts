import { ConstraintError, MisuseError, QuereusError } from '@quereus/quereus';
import {
	type AdminDigestArgs,
	type ISigningEngine,
	type ISigningSignBuilder,
	type ISigningStartSigningSessionBuilder,
	type Scope,
	type Signature,
	type SignOptions,
	type SignOutcome,
	type SigningResult,
	type SigningStatus,
} from '@votetorrent/vote-core';
import { SigningSignBuilder } from './builders/signing-sign-builder.js';
import { SigningStartSigningSessionBuilder } from './builders/signing-start-signing-session-builder.js';
import { type EngineContext } from '../types';
import { nowCanonicalDatetime } from '../utils.js';
import { adminSigningKeyValidity, officerSignatureValidity } from './signer-validity.js';
import {
	countQualifyingSignatures,
	computeSigningStatus,
	DerivedSigningError,
	readSessionThreshold,
} from './threshold.js';

export class SigningEngine implements ISigningEngine {
	constructor(private readonly ctx: EngineContext) {}

	/** D-18: Generate a fresh nonce without creating AdminSigning.
	 *  Invite flows call this first, then INSERT InviteSlots (with the nonce),
	 *  then call startSigningSession with digestArgs=null + the same nonce. */
	generateSigningNonce(): string {
		return crypto.randomUUID();
	}

	async sign(
		nonce: string,
		signature: Signature,
		options?: SignOptions,
	): Promise<boolean> {
		// D-10: sign() keeps its exact Promise<boolean> contract byte-for-byte — every
		// pre-62-07 caller is unaffected. It delegates to signWithOutcome, which carries
		// the new crossedNow signal for callers that need it (62-11's finalize gate).
		return (await this.signWithOutcome(nonce, signature, options)).thresholdReached;
	}

	/** D-10: records `signature` for `nonce`, then reports whether the threshold is reached
	 *  AND whether THIS call is the one that crossed it (inserted the AdminSignature row).
	 *  `crossedNow` is true for exactly one call per nonce — every later signature on an
	 *  already-reached nonce still records its OfficerSignature and returns
	 *  thresholdReached=true, crossedNow=false (the normal late-signature path, T-62-07-02). */
	async signWithOutcome(
		nonce: string,
		signature: Signature,
		options?: SignOptions,
	): Promise<SignOutcome> {
		// Phase 42-03: Quereus's transaction model is FLAT (a nested explicit
		// BEGIN inside an already-explicit transaction throws "Cannot begin
		// transaction: already in a transaction" — no true SAVEPOINT-style
		// nesting for this call shape). Callers that need this method's work
		// to be part of a LARGER atomic ceremony (e.g. RegistrationEngine.
		// register()'s multi-row Cids-before-parent envelope) start their OWN
		// outer BEGIN first and pass `{ ownsTransaction: false }` explicitly —
		// this method then must NOT issue its own nested BEGIN/COMMIT/ROLLBACK,
		// the outer caller owns the commit/rollback boundary.
		//
		// T-42-03 (Phase 42-03): an earlier draft of this guard auto-detected
		// via `this.ctx.db.getAutocommit()` instead of an explicit caller flag.
		// It was replaced with this explicit opt-in because auto-detecting the
		// ambient transaction state from inside a shared helper is inherently
		// fragile (relies on precise knowledge of Quereus's autocommit/implicit-
		// transaction bookkeeping) — an explicit flag removes that ambiguity
		// entirely. Default `ownsTransaction: true` preserves IDENTICAL behavior
		// for every pre-existing caller (zero regression risk); only
		// `register()`'s internal ceremony calls opt in to `false`. (The actual
		// root cause of the flaky-test hunt that surfaced this call site was a
		// SEPARATE bug — a datetime-precision mismatch in the digest fed to the
		// deferred CHECK, fixed in `registration-engine.ts`'s
		// `toDeferredCheckDatetime` — this transaction-composability guard is
		// independently correct and required for `register()`'s multi-row
		// ceremony regardless.)
		const ownsTransaction = options?.ownsTransaction ?? true;
		// 999.1 R-02/R-04: `isPlaceholderSignature` propagates the narrow, explicit DEBT-11
		// escape hatch (schema's IsPlaceholderSignature context flag) — ONLY the known
		// system-derived callers (SignatureTasksEngine.finalizeBallot's per-question/option
		// rows) pass true. Every other caller (real officer-supplied Signature) defaults to
		// false, so OfficerSignature.SignatureValid's UDF actually verifies the signature.
		//
		// WR-07: the schema-side allowlist (votetorrent.qsql, AdminSigning.SignatureValid) now names
		// a fourth producer of `IsPlaceholderSignature = true` — SignatureTasksEngine's
		// seedRegistrantSignatureTasks, which binds the flag DIRECTLY on its `insert into
		// AdminSigning`, NOT through this method. It is recorded here so the two allowlists stay in
		// agreement about which call sites are permitted to set the flag; it does not reach this
		// `sign()` seam, and no `sign()` caller was added by that path. Reason it is correct there:
		// the seeded row is "not yet signed" — the officer's real crypto arrives later as a separate
		// OfficerSignature row over the same Digest (see the schema comment for the full rationale).
		const isPlaceholderSignature = options?.isPlaceholderSignature ?? false;
		try {
			// AUTH-08: BEGIN/COMMIT/ROLLBACK envelope around OfficerSignature
			// insert + threshold check + (optional) AdminSignature insert.
			if (ownsTransaction) await this.ctx.db.exec('BEGIN');
			try {
				// WR-05: idempotency probe on OfficerSignature's primary key, (SigningNonce, UserId).
				//
				// The defect this closes: every ceremony that calls sign() and THEN does more work
				// (SignatureTasksEngine.completeSignature's registrant finalize is the sharpest case,
				// but finalizeBallot's per-row signing and register()'s inner path have the same
				// shape) commits this row before that later work runs. If the later work throws for
				// ANY reason — a CHECK failure, a transient storage error — the task stays
				// incomplete while this row is already committed, and the retry died here on
				// `UNIQUE constraint failed: OfficerSignature PK`. The officer could never complete
				// that ceremony again by retrying it. 48-34 narrowed the TRIGGER (its acceptability
				// gate moved the requester-choosable refusals ahead of sign()); this closes the
				// mechanism itself.
				//
				// Why skipping is correct rather than merely convenient: OfficerSignature is
				// `InsertOnly check on update, delete (false)`, so the FIRST signature at
				// (nonce, userId) is the only one that can ever exist — an UPDATE is not an option
				// the schema offers. Re-running sign() therefore cannot change what is recorded; it
				// can only throw or no-op. This makes it no-op, and the threshold logic below then
				// runs against the true count exactly as it would have on the first call (that count
				// already includes this row), so the AdminSignature outcome is unchanged.
				//
				// What this deliberately does NOT do: it does not compare the supplied
				// signature/signerKey against the stored ones, and it must not start doing so
				// silently. A second call with DIFFERENT bytes is not a conflict to resolve here —
				// the stored row stands, because the schema says it stands.
				const existingOfficerSignature = await this.ctx.db
					.prepare(
						'select 1 as x from OfficerSignature where SigningNonce = :nonce and UserId = :userId',
					)
					.get({ nonce, userId: signature.signerUserId });

				// AUTH-06: bind :signerKey (not :key) — the previous binding silently
				// dropped the signer's public key. The SQL placeholder is :signerKey;
				// the JS object key now matches.
				if (!existingOfficerSignature) {
					const now = nowCanonicalDatetime();
					const validity = await officerSignatureValidity(this.ctx.db, {
						nonce,
						userId: signature.signerUserId,
						signerKey: signature.signerKey,
						now,
						isPlaceholderSignature,
					});
					await this.ctx.db.exec(
						`insert into OfficerSignature (
							SigningNonce,
							UserId,
							SignerKey,
							Signature
						)
						with context now = :now, IsSignerKeyValid = :isSignerKeyValid, IsOfficerValid = :isOfficerValid, IsPlaceholderSignature = :isPlaceholderSignature
						values (
							:nonce,
							:userId,
							:signerKey,
							:signature
						)`,
						{
							nonce,
							userId: signature.signerUserId,
							signerKey: signature.signerKey,
							signature: signature.signature,
							now,
							isSignerKeyValid: validity.isSignerKeyValid,
							isOfficerValid: validity.isOfficerValid,
							isPlaceholderSignature,
						},
					);
				}

				// 62-07 (D-08/D-12): read BOTH Scope AND AuthorityId off AdminSigning — the
				// authority is needed to resolve the current scope-holder set for holder-only counting.
				const sessionRes = await this.ctx.db
					.prepare('select Scope, AuthorityId from AdminSigning where Nonce = :nonce')
					.get({ nonce });
				const scope = sessionRes?.Scope as Scope;
				const authorityId = sessionRes?.AuthorityId as string;

				const threshold = await readSessionThreshold(this.ctx.db, nonce, scope);
				const signatureCount = await countQualifyingSignatures(this.ctx.db, nonce, authorityId, scope, threshold);

				const thresholdMet = signatureCount >= threshold;
				if (thresholdMet) {
					// D-10: probe for an EXISTING AdminSignature row BEFORE attempting the insert. A hit
					// here means some earlier call already crossed the threshold for this nonce — this is
					// the NORMAL late-signature path (not a race), so it returns crossedNow=false without
					// a console.warn (T-62-07-02).
					const existingAdminSignature = await this.ctx.db
						.prepare('select 1 as x from AdminSignature where SigningNonce = :nonce')
						.get({ nonce });
					if (existingAdminSignature) {
						if (ownsTransaction) await this.ctx.db.exec('COMMIT');
						return { thresholdReached: true, crossedNow: false };
					}
					try {
						// 999.1 R-06: bind the REAL computed threshold boolean (not a literal `true`) —
						// AdminSignature has no Digest/Signature/SignerKey columns to re-verify, so this
						// TS-computed value IS the thing SignatureValid gates on.
						await this.ctx.db.exec(
							'insert into AdminSignature (SigningNonce) with context IsSignatureValid = :thresholdMet values (:nonce)',
							{ nonce, thresholdMet },
						);
						if (ownsTransaction) await this.ctx.db.exec('COMMIT');
						// D-10: THIS call inserted the AdminSignature row — the ONE crossedNow=true per nonce.
						return { thresholdReached: true, crossedNow: true };
					} catch (pkErr) {
						// D-17: PK violation on AdminSignature.SigningNonce means a
						// concurrent caller already inserted the AdminSignature row
						// for this nonce (lost the race against the pre-insert probe above).
						// Treat as idempotent threshold completion. The signatureCount gate
						// guarantees SignatureValid is already satisfied, so the only
						// reachable ConstraintError here is a PK collision.
						if (pkErr instanceof ConstraintError) {
							// WR-02 (42-REVIEW): the redundant AdminSignature insert is correctly
							// skipped, but this call already inserted a genuine OfficerSignature row
							// above — THIS officer's audit evidence — which must NOT be
							// discarded. COMMIT (not ROLLBACK) so the OfficerSignature persists; the
							// pre-existing AdminSignature already satisfies SignatureValid, so the
							// threshold outcome is unchanged. 62-07 (D-10): this concurrent-crosser
							// branch now returns crossedNow=false — THIS call did not insert the row.
							if (ownsTransaction) await this.ctx.db.exec('COMMIT');
							console.warn(
								`SigningEngine.signWithOutcome: threshold already reached for nonce ${nonce}; AdminSignature row exists (this officer's OfficerSignature is recorded — ${existingOfficerSignature ? 'it already existed and was reused (idempotent retry)' : 'it was inserted by this call'}).`,
							);
							return { thresholdReached: true, crossedNow: false };
						}
						throw pkErr;
					}
				} else {
					if (ownsTransaction) await this.ctx.db.exec('COMMIT');
					return { thresholdReached: false, crossedNow: false };
				}
			} catch (innerErr) {
				if (ownsTransaction) await this.ctx.db.exec('ROLLBACK');
				throw innerErr;
			}
		} catch (err) {
			// AUTH-07: control flow exits via the inner try's return statements or
			// via this throw. No statements remain reachable after the catch.
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
	}

	/** Finding 4.1 (tier 2): signs a DERIVED session (e.g. a finalize-time Question/Option row,
	 *  or a registration/association decision seeded via seedSignedMutation's headerNonce option)
	 *  whose AdminSignature may only be written once its HEADER nonce has already reached
	 *  AdminSignature, for the SAME scope and authority. The engine attests the header is
	 *  satisfied; the schema trusts the boolean exactly as it does for sign(). Every check below
	 *  runs BEFORE any write. */
	async signDerived(
		nonce: string,
		signature: Signature,
		headerNonce: string,
		options?: SignOptions,
	): Promise<SignOutcome> {
		const ownsTransaction = options?.ownsTransaction ?? true;
		const isPlaceholderSignature = options?.isPlaceholderSignature ?? false;
		try {
			// 1. Read the derived AdminSigning (Scope, AuthorityId).
			const derivedRes = await this.ctx.db
				.prepare('select Scope, AuthorityId from AdminSigning where Nonce = :nonce')
				.get({ nonce });
			if (!derivedRes) {
				throw new DerivedSigningError('session-not-found', `signDerived: no AdminSigning for nonce ${nonce}`);
			}
			const derivedScope = derivedRes.Scope as Scope;
			const derivedAuthorityId = derivedRes.AuthorityId as string;

			// 2. Read the header AdminSigning.
			const headerRes = await this.ctx.db
				.prepare('select Scope, AuthorityId from AdminSigning where Nonce = :headerNonce')
				.get({ headerNonce });
			if (!headerRes) {
				throw new DerivedSigningError('header-not-found', `signDerived: no AdminSigning for headerNonce ${headerNonce}`);
			}
			const headerScope = headerRes.Scope as Scope;
			const headerAuthorityId = headerRes.AuthorityId as string;

			// 3. Compare scope and authority.
			if (derivedScope !== headerScope) {
				throw new DerivedSigningError('scope-mismatch', `signDerived: derived scope ${derivedScope} !== header scope ${headerScope}`);
			}
			if (derivedAuthorityId !== headerAuthorityId) {
				throw new DerivedSigningError('authority-mismatch', `signDerived: derived authority ${derivedAuthorityId} !== header authority ${headerAuthorityId}`);
			}

			// 4. Require an AdminSignature row for headerNonce.
			const headerReached = await this.ctx.db
				.prepare('select 1 as x from AdminSignature where SigningNonce = :headerNonce')
				.get({ headerNonce });
			if (!headerReached) {
				throw new DerivedSigningError('header-not-reached', `signDerived: header nonce ${headerNonce} has not reached AdminSignature`);
			}

			if (ownsTransaction) await this.ctx.db.exec('BEGIN');
			try {
				// 5. Insert the OfficerSignature, same idempotency probe + context flags as signWithOutcome.
				const existingOfficerSignature = await this.ctx.db
					.prepare(
						'select 1 as x from OfficerSignature where SigningNonce = :nonce and UserId = :userId',
					)
					.get({ nonce, userId: signature.signerUserId });
				if (!existingOfficerSignature) {
					const now = nowCanonicalDatetime();
					const validity = await officerSignatureValidity(this.ctx.db, {
						nonce,
						userId: signature.signerUserId,
						signerKey: signature.signerKey,
						now,
						isPlaceholderSignature,
					});
					await this.ctx.db.exec(
						`insert into OfficerSignature (
							SigningNonce,
							UserId,
							SignerKey,
							Signature
						)
						with context now = :now, IsSignerKeyValid = :isSignerKeyValid, IsOfficerValid = :isOfficerValid, IsPlaceholderSignature = :isPlaceholderSignature
						values (
							:nonce,
							:userId,
							:signerKey,
							:signature
						)`,
						{
							nonce,
							userId: signature.signerUserId,
							signerKey: signature.signerKey,
							signature: signature.signature,
							now,
							isSignerKeyValid: validity.isSignerKeyValid,
							isOfficerValid: validity.isOfficerValid,
							isPlaceholderSignature,
						},
					);
				}

				// 6. Insert AdminSignature for the derived nonce with IsSignatureValid = true if none
				//    exists (true/true), else return true/false — mirrors signWithOutcome's probe/insert
				//    shape, but a derived row is always considered satisfied once reached (no threshold
				//    recount — the header's reached-ness IS the gate).
				const existingAdminSignature = await this.ctx.db
					.prepare('select 1 as x from AdminSignature where SigningNonce = :nonce')
					.get({ nonce });
				if (existingAdminSignature) {
					if (ownsTransaction) await this.ctx.db.exec('COMMIT');
					return { thresholdReached: true, crossedNow: false };
				}
				await this.ctx.db.exec(
					'insert into AdminSignature (SigningNonce) with context IsSignatureValid = :thresholdMet values (:nonce)',
					{ nonce, thresholdMet: true },
				);
				if (ownsTransaction) await this.ctx.db.exec('COMMIT');
				return { thresholdReached: true, crossedNow: true };
			} catch (innerErr) {
				if (ownsTransaction) await this.ctx.db.exec('ROLLBACK');
				throw innerErr;
			}
		} catch (err) {
			if (err instanceof DerivedSigningError) {
				throw err;
			}
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
	}

	/** D-11: a read-only, no-veto derivation of nonce's reached/unreachable state. */
	async getSigningStatus(nonce: string): Promise<SigningStatus | null> {
		return computeSigningStatus(this.ctx.db, nonce);
	}

	/** D-06/D-08/D-17: Two-path startSigningSession.
	 *
	 * PATH A (digestArgs provided — used by proposeAdmin):
	 *   Generate a fresh nonce, INSERT AdminSigning with inline
	 *   Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) in
	 *   alphabetical order (57-01/D-02: `officers` is the deterministically
	 *   sorted, serialized admin roster — see `authority-engine.ts`'s
	 *   `sortRosterEntries` — so a later co-signer's recomputation here
	 *   matches the producer's digest byte-for-byte).
	 *
	 * PATH B (digestArgs is null — used by invite flows via saveInviteWithSigning):
	 *   Callers must first call generateSigningNonce() to get the nonce, INSERT
	 *   InviteSlots with that nonce, then call this with digestArgs=null + the same nonce.
	 *   INSERT AdminSigning with a Digest subquery over the InviteSlot tagged with that nonce.
	 */
	async startSigningSession(
		authorityId: string,
		digestArgs: AdminDigestArgs | null,
		scope: Scope,
		signature: Signature,
		nonce?: string,
		options?: SignOptions,
	): Promise<SigningResult> {
		// PATH A: non-invite callers — generate a fresh nonce
		// PATH B: invite callers — must supply the pre-generated nonce
		const sessionNonce =
			digestArgs !== null
				? crypto.randomUUID()
				: (() => {
						if (!nonce)
							throw new Error(
								'nonce is required when digestArgs is null (invite flow)',
							);
						return nonce;
					})();

		try {
			const adminDB = await this.ctx.db
				.prepare(
					`select CurrentAdmin.EffectiveAt from CurrentAdmin join Officer
						on CurrentAdmin.AuthorityId = Officer.AuthorityId
							and CurrentAdmin.EffectiveAt = Officer.AdminEffectiveAt
								where Officer.UserId = :userId and Officer.AuthorityId = :authorityId`,
				)
				.get({
					userId: signature.signerUserId,
					authorityId,
				});
			if (!adminDB) {
				throw new Error('Admin not found');
			}
			const now = nowCanonicalDatetime();
			const isSignerKeyValid = await adminSigningKeyValidity(this.ctx.db, {
				userId: signature.signerUserId,
				signerKey: signature.signerKey,
				now,
				isPlaceholderSignature: false,
			});

			if (digestArgs !== null) {
				// PATH A: inline Digest() — fields in alphabetical order (D-07d)
				// AdminDigestArgs fields: authorityId, effectiveAt, officers, thresholdPolicies
				await this.ctx.db.exec(
					`insert into AdminSigning (
						Nonce,
						AuthorityId,
						AdminEffectiveAt,
						Scope,
						Digest,
						UserId,
						SignerKey,
						Signature
					)
					with context now = :now, IsSignerKeyValid = :isSignerKeyValid, IsPlaceholderSignature = false
					values (
						:nonce,
						:authorityId,
						:adminEffectiveAt,
						:scope,
						Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies),
						:userId,
						:signerKey,
						:signature
					)`,
					{
						nonce: sessionNonce,
						authorityId,
						adminEffectiveAt: adminDB.EffectiveAt as string,
						scope,
						effectiveAt: digestArgs.effectiveAt,
						officers: digestArgs.officers,
						thresholdPolicies: digestArgs.thresholdPolicies,
						userId: signature.signerUserId,
						signerKey: signature.signerKey,
						signature: signature.signature,
						now,
						isSignerKeyValid,
					},
				);
			} else {
				// PATH B: Digest subquery over the InviteSlot tagged with this nonce (D-17)
				await this.ctx.db.exec(
					`insert into AdminSigning (
						Nonce,
						AuthorityId,
						AdminEffectiveAt,
						Scope,
						Digest,
						UserId,
						SignerKey,
						Signature
					)
					with context now = :now, IsSignerKeyValid = :isSignerKeyValid, IsPlaceholderSignature = false
					values (
						:nonce,
						:authorityId,
						:adminEffectiveAt,
						:scope,
						(SELECT Digest(Cid) FROM InviteSlot WHERE SigningNonce = :nonce),
						:userId,
						:signerKey,
						:signature
					)`,
					{
						nonce: sessionNonce,
						authorityId,
						adminEffectiveAt: adminDB.EffectiveAt as string,
						scope,
						userId: signature.signerUserId,
						signerKey: signature.signerKey,
						signature: signature.signature,
						now,
						isSignerKeyValid,
					},
				);
			}
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
		// 62-13 (D-08): forward ONLY options.ownsTransaction to the internal signWithOutcome
		// call — isPlaceholderSignature never flows through this path. Default (unset or
		// true) is a self-owned transaction, byte-identical to every pre-62-13 caller.
		const { thresholdReached, crossedNow } = await this.signWithOutcome(sessionNonce, signature, {
			ownsTransaction: options?.ownsTransaction ?? true,
		});
		return { nonce: sessionNonce, thresholdReached, crossedNow };
	}

	buildSign(): ISigningSignBuilder {
		return new SigningSignBuilder(this);
	}

	buildStartSigningSession(): ISigningStartSigningSessionBuilder {
		return new SigningStartSigningSessionBuilder(this);
	}
}
