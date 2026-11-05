/**
 * seed-registrant-association.ts — D-23(f) registered-state dev fixture (Phase 59-03,
 * owner-locked 2026-09-15).
 *
 * WHY THIS FIXTURE EXISTS (verified in source, not inferred):
 *   1. `Association.InsertValid` (`votetorrent.qsql`) requires a `'vrg'`-scoped
 *      `AdminSignature`/`AdminSigning` pair. Writing an `Association` row IS the
 *      authority's registration ceremony — a raw SQL insert cannot satisfy it.
 *   2. `Association.RegistrantIdValid` additionally requires a `Registrant` row with
 *      `Status = 'a'` to already exist, and `RegistrationEngine.createRegistrant` runs
 *      its own `'vrg'` ceremony too.
 *   3. The voter app's `no-vrg-ceremony.gate.test.ts` scans every non-`*.test.ts` file
 *      under `apps/VoteTorrentVoter/src` and fails on any occurrence of `register(`,
 *      `associate(`, `seedSignedMutation` or `issueAttestationChallenge` — both tokens
 *      this seeding needs are on that list, so the ceremony cannot live under the
 *      voter's own source tree.
 * There is therefore no way to make the `registered` panel state reachable in dev
 * without driving both real ceremonies from somewhere outside the voter's `src/` scan
 * — this module is that somewhere. It is ENGINE-SIDE, where authority ceremonies
 * legitimately live, and it names `associate(`/`issueAttestationChallenge` openly
 * (calling the real `AssociationEngine`/`RegistrationEngine` methods directly) — that
 * is the entire point of moving it here rather than dodging the gate with an alias.
 *
 * `__DEV__`-ONLY, NEVER SHIPPED: this module exists purely to be reached from
 * `apps/VoteTorrentVoter/src/engines/dev-seed.ts` behind a `__DEV__` + deep-relative
 * lazy `require` (the established `attach-voter-request-transport.ts` pattern) — Metro
 * replaces `__DEV__` with a literal `false` in a release transform, so that branch is
 * unreachable in a release module graph and this file's code never ships.
 *
 * HONESTY FENCE (carried verbatim into `dev-seed.ts`'s call site and the plan's
 * SUMMARY): a `registered` state produced by this module is a UI FIXTURE and is NEVER
 * evidence that the real registration ceremony works. The real ceremony requires a
 * cross-device authority decision (an authority app deciding a request submitted by a
 * DIFFERENT device) that this single-process fixture does not exercise at all.
 *
 * SUNSET (required, not optional): this fixture is DELETED once D-17 / P2P-11 unblocks
 * the real cross-device authority path, at which point `registered` becomes reachable
 * only through a genuine authority decision. Tracked at
 * `.planning/todos/pending/2026-09-15-retire-engine-side-registered-state-dev-fixture.md`.
 */

import type { Association, Registrant, Signature } from '@votetorrent/vote-core'
import { RegistrationEngine } from '../registration/registration-engine.js'
import { AssociationEngine } from '../association/association-engine.js'
import type { EngineContext } from '../types.js'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/** D-23c: the seeded Registrant/Association validity window — 365 days out, a FUTURE instant. */
const SEED_VALIDITY_MS = 365 * 86_400_000

/**
 * Placeholder private-tier CID. This fixture writes no real `RegistrantPrivate` detail
 * rows — the D-06/D-23 registration panel this feeds reads only `Registrant.status` /
 * `Registrant.expiration`, never any private-tier field.
 */
const SEED_PRIVATE_CID_PLACEHOLDER = 'dev-seed-registrant-association-private-cid-placeholder-NOT-REAL'

/** Mirrors `StubAttestationProducer`'s own NOT_REAL placeholder convention. */
const SEED_CERTIFICATE_PLACEHOLDER = 'DEV_SEED_ASSOCIATION_CERTIFICATE_PLACEHOLDER_NOT_REAL'

export interface SeedRegistrantIdentity {
  /** 32-byte random registrant id — caller-supplied so seeding is stable/idempotent across dev boots. */
  id: string
  /** Overrides the default placeholder private-tier CID. */
  privateCid?: string
  /** Overrides the default 365-day future expiration. Per D-23c this MUST remain a future instant. */
  expiration?: number | string
}

export interface SeedRegistrantAssociationResult {
  registrant: Registrant
  association: Association
}

/**
 * Idempotently seed (or re-attach to) a `Status = 'a'` `Registrant` and its matching
 * `Association` bound to `deviceKey` — driven through the real
 * `RegistrationEngine.createRegistrant` / `AssociationEngine.issueAttestationChallenge`
 * / `AssociationEngine.associate` ceremony methods (`packages/vote-engine/test/
 * association-reads.spec.ts`'s own `seedRegistrant()`/`associateDevice()` helpers
 * exercise the identical calls). No hand-rolled signing SQL, no lexical alias.
 *
 * Idempotent: a second call with the same `(registrant.id, deviceKey)` returns the
 * EXISTING rows rather than attempting a duplicate insert — `dev-seed.ts` re-runs on
 * every dev boot and must not fail on the second run.
 *
 * `deviceKey` MUST be the P-256 device key from
 * `resolveAttestationProducer().provisionDeviceKey()` (D-23b) — NOT the secp256k1
 * `deviceUserKey` that signs the registration request. The two are structurally
 * distinct; binding the wrong one makes `getAssociationsByDeviceKey` read "not
 * registered" forever for a real device key.
 */
export async function seedRegistrantAssociation (
  ctx: EngineContext,
  authorityId: string,
  registrant: SeedRegistrantIdentity,
  deviceKey: string,
  sign: SignatureOrCallback
): Promise<SeedRegistrantAssociationResult> {
  const registrationEngine = new RegistrationEngine(ctx)
  const associationEngine = new AssociationEngine(ctx)

  let registrantRow = await registrationEngine.getRegistrant(registrant.id)
  if (!registrantRow) {
    registrantRow = await registrationEngine.createRegistrant(
      {
        id: registrant.id,
        authorityId,
        privateCid: registrant.privateCid ?? SEED_PRIVATE_CID_PLACEHOLDER,
        status: 'a',
        expiration: registrant.expiration ?? Date.now() + SEED_VALIDITY_MS
      },
      sign
    )
  }

  let associationRow = await associationEngine.getAssociation(registrant.id, deviceKey)
  if (!associationRow) {
    const challenge = await associationEngine.issueAttestationChallenge(registrant.id, deviceKey, sign)
    await associationEngine.associate(
      {
        registrantId: registrant.id,
        deviceKey,
        nonce: challenge.nonce,
        attestation: {
          publicKey: deviceKey,
          deviceId: `dev-seed-association-device-${registrant.id}`,
          attestationTime: Date.now(),
          certificateChain: [SEED_CERTIFICATE_PLACEHOLDER]
        }
      },
      sign
    )
    associationRow = await associationEngine.getAssociation(registrant.id, deviceKey)
    if (!associationRow) {
      throw new Error(
        `seedRegistrantAssociation: Association not found immediately after associate() for registrantId=${registrant.id}`
      )
    }
  }

  return { registrant: registrantRow, association: associationRow }
}
