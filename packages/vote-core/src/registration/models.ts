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
 */
export interface RegisterInit {
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

  selective?: {
    expiration: Timestamp | string
    details: SaltedLeaf[]
  }
}
