import type { Timestamp } from '../common/index.js'

/** ********* Enums (D-08, text codes — avoids the number/boolean-in-Digest pitfalls) ***********/

/** RegistrantTier(Code) — which content-addressed tier a field's value lands in. */
export type RegistrantTier = 'public' | 'selective' | 'private'

/** FieldRequirement(Code) — whether a policy-declared field is mandatory at Register time. */
export type FieldRequirement = 'required' | 'optional'

/** RegistrantStatus(Code) — Active / Suspended / Revoked. */
export type RegistrantStatus = 'a' | 's' | 'r'

/** ********* Registrant (core, admin-signed under 'vrg') ***********/
export interface Registrant {
  /** 32 byte random unique registrant identifier */
  id: string

  /** Authority that validated this registrant */
  authorityId: string

  /** Content-addressed hash of the registrant's private data (never null — every registrant has a private tier) */
  privateCid: string

  /** Content-addressed hash of the registrant's public data (undefined if no public data) */
  publicCid?: string

  /** Content-addressed hash of the registrant's selective-disclosure data (undefined if none) */
  selectiveCid?: string

  /** references RegistrantStatus(Code) */
  status: RegistrantStatus

  expiration: Timestamp | string

  /** Public key of the authority signor */
  signorKey: string

  /** Signature of this record by the signor */
  signature: string
}

/** ********* RegistrantPublic (D-18: fixed columns + ExtraFields json) ***********/
export interface RegistrantPublic {
  /** Content-addressed hash of this record */
  cid: string

  /** references Registrant.id */
  registrantId: string

  lastName?: string
  firstName?: string
  district?: string

  /** Authority/election-specific extra public fields, resolved via json_extract/json_each */
  extraFields?: Record<string, unknown>
}

/**
 * Recursive private-detail attribute triple (RegistrantPrivate.PrivateDetails, D-21).
 * `value` is either a scalar (top-level field) or a nested array of triples (an object).
 * Never disclosed — the selectively-disclosable tier is a separate record (RegistrantSelective).
 */
export interface PrivateDetail {
  name: string
  value: string | number | boolean | PrivateDetail[]
  hint?: string
}

/** ********* RegistrantPrivate (authority-held, insert-only, 'vrg'-signed) ***********/
export interface RegistrantPrivate {
  /** Content-addressed hash of this record */
  cid: string

  /** references Registrant.id */
  registrantId: string

  expiration: Timestamp | string

  /** json array of { name, value, hint? } triples (recursive); never disclosed */
  privateDetails?: PrivateDetail[]
}

/**
 * Flat salted-leaf disclosure attribute (RegistrantSelective.SelectiveDetails, D-11/D-12/D-13).
 * Committed via the crypto plugin's set_commit as
 * leafDigest = digest([SD_LEAF_DOMAIN, name, value, salt]); Cid = cid(set_commit(SelectiveDetails))
 * over the sorted leaf digests (Optimystic issue #5 — the landed flat-set design, NOT a Merkle tree).
 */
export interface SaltedLeaf {
  name: string
  value: string | number | boolean
  /** random_bytes (>=128 bits); duplicate names and empty salts are rejected at commit */
  salt: string
}

/**
 * Alias for {@link SaltedLeaf}, mirroring the crypto plugin's own `SaltedLeaf`
 * naming (`@optimystic/quereus-plugin-crypto/src/sd.ts`) at the Register-flow
 * selective-disclosure surface (D-11/D-12/D-13/D-14) — the stored, salted
 * `{ name, value, salt }` shape returned by `getDisclosedSelective` (both the
 * revealed `disclosed` leaves and, structurally, the withheld ones before
 * they're reduced to opaque hidden digests).
 */
export type SelectiveLeaf = SaltedLeaf

/**
 * One caller-supplied selective-disclosure field input for the Register flow
 * (D-13). Deliberately carries NO `salt` — the engine generates a fresh
 * `random_bytes` (>=128 bits) salt per leaf at commit time; a caller-supplied
 * salt would defeat the "authority alone can enforce uniqueness / freshness"
 * property `assertUniqueNames`/`requireSaltBytes` rely on authority-side.
 */
export interface SelectiveFieldInput {
  name: string
  value: string | number | boolean
}

/**
 * Draft payload for the Register flow's optional selective-disclosure tier
 * (D-11/D-12/D-13) — an ORDERED list of `{ name, value }` field inputs, salts
 * omitted (engine-generated). Duplicate names are rejected before the DB
 * ceremony (D-13); an absent or empty list means no `RegistrantSelective`
 * row is ever created (Pitfall 3 — `set_commit` is never invoked on NULL).
 */
export type RegisterSelectivePayload = SelectiveFieldInput[]

/** ********* RegistrantSelective (authority-held, insert-only, 'vrg'-signed) ***********/
export interface RegistrantSelective {
  /** Content-addressed CIDv1 of this record: cid(set_commit(SelectiveDetails)) */
  cid: string

  /** references Registrant.id */
  registrantId: string

  expiration: Timestamp | string

  /** json array of flat { name, value, salt } salted leaves (SaltedLeaf[]) */
  selectiveDetails?: SaltedLeaf[]
}

/**
 * Result of `getDisclosedSelective` (D-14) — a per-field disclosure of a
 * registrant's `RegistrantSelective` set, filtered by `ElectionDisclosurePolicy`
 * for the caller's audience. `root` is the BARE `set_commit(SelectiveDetails)`
 * value (base64url) that `setVerify(root, { disclosed, hidden })` checks
 * against — NOT the `cid()`-wrapped `SelectiveCid` (`cid` is included purely
 * for linkage back to `Registrant.selectiveCid` / the `RegistrantSelective`
 * row). `disclosed` carries the revealed `(name, value, salt)` triples;
 * `hidden` carries only opaque leaf digests (base64url) of the withheld
 * leaves — no name, no value, no salt ever crosses this boundary.
 */
export interface DisclosedSelective {
  cid: string
  root: string
  disclosed: SelectiveLeaf[]
  hidden: string[]
}

/** DisclosureAudience(Code) — which recipients a selective field may be revealed to. */
export type DisclosureAudience = 'district' | 'everyone'

/**
 * Election policy: which `RegistrantSelective` field names may be disclosed,
 * and to which audience (D-14). Companion to `ElectionRegistrationField` —
 * same 'mel'-signed, election-keyed shape. Delivery/filtering of disclosed
 * data to recipients is handled off-schema by `getDisclosedSelective` at
 * query time (no on-network disclosure record).
 */
export interface ElectionDisclosurePolicy {
  /** references Election.id */
  electionId: string

  /** a top-level attribute name within RegistrantSelective.SelectiveDetails */
  fieldName: string

  /** references DisclosureAudience(Code) */
  audience: DisclosureAudience
}

/**
 * Election policy: whether this election requires device attestation to Associate (D-14a/b).
 * Single row per election (admin-signed 'mel', keyed by electionId alone). Companion to
 * ElectionDisclosurePolicy/ElectionRegistrationField (same 'mel'-signed, election-keyed shape).
 * Fail-closed enforcement (no row => attestation required) is engine-side at the associate()
 * read (45-04) — this interface only describes the stored policy row itself.
 */
export interface ElectionAttestationPolicy {
  /** references Election.id */
  electionId: string

  /** true = attestation required (fail-closed default), false = not required */
  attestationRequired: boolean
}

/** ********* ElectionRegistrant (roster, authority-only 'vrg'-signed insert/delete) ***********/
export interface ElectionRegistrant {
  /** references Election.id */
  electionId: string

  /** references Registrant.id */
  registrantId: string
}

/**
 * Per-election registration field policy (D-08/D-09/D-10). Declares which
 * registrant detail fields an election expects, which tier each belongs to,
 * and whether furnishing it is required. Companion to ElectionDisclosurePolicy.
 * Admin-signed under 'mel', keyed by ElectionId (election-scoped, not network-wide).
 * Enforcement that a Register submission furnishes the Required fields is
 * engine-side at Register time — this table only declares the policy.
 */
export interface ElectionRegistrationField {
  /** references Election.id */
  electionId: string

  /** Attribute name (a RegistrantPublic column / ExtraFields key, or a top-level name within SelectiveDetails / PrivateDetails) */
  fieldName: string

  /** references RegistrantTier(Code) */
  tier: RegistrantTier

  /** references FieldRequirement(Code) */
  requirement: FieldRequirement
}

/**
 * Draft payload for the Register builder (D-02). Carries the Registrant core
 * fields plus the optional Public/Private/Selective tier payloads; `private`
 * is required because Registrant.PrivateCid is never null on the schema.
 *
 * `electionId` (D-10, 42-07) scopes the submission to the ElectionRegistrationField
 * policy the engine enforces at Register time (D-09) — optional so a
 * submission with no election context (no field policy to enforce against)
 * behaves exactly as before this field was added.
 */
export interface RegisterInit {
  /** references Election.id — when present, gates the submission against that election's ElectionRegistrationField policy (D-09/D-10) */
  electionId?: string

  registrant: {
    id: string
    authorityId: string
    expiration: Timestamp | string
  }

  public?: {
    lastName?: string
    firstName?: string
    district?: string
    extraFields?: Record<string, unknown>
  }

  private: {
    expiration: Timestamp | string
    details: PrivateDetail[]
  }

  /**
   * D-11/D-12/D-13: optional selective-disclosure tier. `details` carries
   * PLAIN `{ name, value }` field inputs — no salt (engine-generated, D-13).
   * Absent or empty means no `RegistrantSelective` row is created at all
   * (Pitfall 3: `set_commit` is never invoked on NULL/absent details).
   */
  selective?: {
    expiration: Timestamp | string
    details: RegisterSelectivePayload
  }
}
