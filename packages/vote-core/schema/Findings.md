# Finding Summary

Here’s a structured walkthrough of the schema’s domain model, the relationships among entities, and the business rules encoded via constraints.

## Core Enumerations and Views
- **ElectionType**
  - Codes: `o` (Official), `a` (Adhoc).
  - Used by `Network.ElectionType`.
- **Scope**
  - Admin action scopes: `rn` (Revise Network), `rad` (Revise/replace Admin), `vrg`, `iad`, `uai`, `ceb`, `mel`, `cap`.
  - Used to control which officers can authorize certain mutations.
- **CurrentAdmin**
  - View of the latest active `Admin` epoch per `Authority` (max `EffectiveAt` <= now).

## Core Entities
- **Network**
  - Fields: `Id`, `Hash`, `PrimaryAuthorityId`, `Name`, `ImageRef`, `Relays`, `TimestampAuthorities`, `NumberRequiredTSAs`, `ElectionType`.
  - Primary authority owns the network; only it can update.
  - Immutable fields: `Id`, `Hash`, `PrimaryAuthorityId`.
  - Update requires a valid admin signing session with scope `rn` and a digest over the new content.

- **Authority**
  - Fields: `Id`, `Name`, `DomainName`, `ImageRef`.
  - Insert path:
    - First-ever authority: no invite, no signing.
    - Otherwise: validated `InviteResult` whose digest matches the new authority’s content.
  - Update path:
    - Requires admin signing with scope `uai` and a digest over the changed fields.

- **Admin** (administration epochs per authority)
  - PK: `(AuthorityId, EffectiveAt)`.
  - Holds `ThresholdPolicies` (JSON list: `{ scope, threshold }`), default empty implies threshold=1 when missing.
  - Insert/update paths:
    - First admin for first authority: no invite, no signing.
    - First admin of a new authority: invite-backed, digest covers Admin + its Officers.
    - Subsequent or revised admin: requires signing session; digest covers Admin + its Officers.
  - Integrity checks reference officers under the same epoch via digest rollups.

- **Officer**
  - PK: `(AuthorityId, AdminEffectiveAt, UserId)`.
  - Belongs to an `Admin` epoch and an underlying `User`.
  - `Scopes` must be in `Scope` enum.
  - Insert-only, validated through same digest/signing flow as Admin.
  - Indexed by `UserId`.

## Signing Workflow (Multi-party Authorization)
- **AdminSigning** (session)
  - A single initiator officer starts a session with `Nonce`, `AuthorityId`, `AdminEffectiveAt`, `Scope`, `Digest`, `UserId`, `SignerKey`, `Signature`.
  - `Signature` validates the initiator signed the session payload.
  - Digest ties the intended mutation to be authorized.
- **OfficerSignature**
  - Other officers attest to the same session by signing the session `Digest` with their `SignerKey`.
- **AdminSignature**
  - Finalization: exists only when the count of `OfficerSignature`s meets/exceeds the `ThresholdPolicies[scope]` required for that session’s `Scope`.

This triad enforces: propose mutation → collect scoped officer signatures → finalize once threshold met.

## Invitations (External Authorization for onboarding)
- **InviteSlot**
  - Created for a batch via a signed `AdminSigning` session (must be already fully authorized).
  - Has `Cid = Digest(Name, Expiration, InviteKey, InviteSignature, SigningNonce)`.
  - Batch integrity check `InviteSlotSigningValid` ensures the combined digest over the batch matches the authorizing session.
- **InviteResult**
  - Accept/reject outcome for a slot.
  - If accepted, includes a `Digest` that must match the future object being created (e.g., `Authority`, new `Admin`/`Officer` sets).
  - `InviteSignature` must be verifiable against the slot’s `InviteKey`.

Invites are then referenced by constraints on `Authority`, `Admin`, `Officer`, and proposal tables to prove rightful creation.

## Proposal Layer (Pre-commit, signed by officers)
These represent proposed changes that must be authorized by the active admin of the relevant authority via a user’s key and signature.
- **ProposedNetwork**
  - New network parameters. Only officers of the primary authority with scope `rn`, holding a non-expired `UserKey`, can propose and sign.
- **ProposedAuthority**
  - Proposed change to a specific authority (e.g., name/domain/image). Requires `uai` scope by an officer of that authority.
- **ProposedAdmin**
  - Proposed future `Admin` epoch and threshold policies for an authority. Requires `rad` scope.
- **ProposedOfficer**
  - Proposed officers for a proposed admin epoch. Requires `rad` scope.
- Optional extension:
  - **ProposedOfficerUser** (possibly deprecated): augments `ProposedOfficer` with an explicit `UserId`, `UserKey`, `UserSignature`.

Across proposals:
- Common pattern: `UserValid` constraints join `Officer` → `CurrentAdmin` → `UserKey` and assert:
  - The proposer is an officer in the current admin epoch.
  - The officer has the correct `Scope`.
  - The provided `UserKey` is valid and non-expired.
  - The signature verifies a deterministic `Digest(...)` of the proposed content (plus `Tid`).

## Users and Keys
- **User**
  - `Id`, `Name`, `ImageRef`.
  - Must be associated to at least one `Keyholder` or `Officer` (note: `Keyholder` table is referenced but not defined in this file).
  - Must have at least one `UserKey`.
  - Insertion can use invites; first user exception is encoded but appears to expect exactly one existing user (`(select count(*) from User) = 1`) which might be a logic bug vs “0” for first.
- **UserKey**
  - PK: `(UserId, PubKey)`.
  - Enforces `Expiration > now`.
  - Signature check on create/delete using an existing valid key unless it’s the first key for the user (then `UserKey` in context can be null).
  - Prevents deleting the last key and requires a valid current key in context for deletion.

## Relationships and Cardinality
- **Network 1 → 1 Authority** via `PrimaryAuthorityId`.
- **Authority 1 → N Admin** epochs (time-versioned by `EffectiveAt`).
- **Admin 1 → N Officer** (scoped roles tied to that epoch).
- **Officer N → 1 User**.
- **AdminSigning 1 → N OfficerSignature**, and 1 → 1 AdminSignature (upon threshold met).
- **InviteSlot 1 → 1 InviteResult** (by `Cid`), and batch slots 1 → 1 AdminSigning session.
- Proposals reference back to current admin and officers for authorization.

## Security/Integrity Patterns
- **Digest discipline**
  - Mutations and proposals compute deterministic `Digest(...)` over all material fields.
  - For sets (e.g., admin epochs, officers), digest rollups use `DigestAll(...) over (order by ...)` to bind content and order.
- **Scopes**
  - Every sensitive mutation ties to a `Scope`, and checks ensure the officer holds the scope and the session scope matches the mutation type.
- **Threshold policies**
  - Stored per `Admin` and used for multi-sig finalization.

## Notable Constraints and Business Logic Highlights
- **Immutability**
  - Many IDs and linkage fields are immutable (`Id`, `Hash`, `PrimaryAuthorityId`).
- **Temporal validity**
  - `EffectiveAt` must be ISO datetime ending with Z.
  - Keys and invites must be unexpired.
- **JSON validation**
  - Several TODOs to validate JSON shapes (`ImageRef`, `Relays`, `TimestampAuthorities`, `ThresholdPolicies`).
- **Update gating**
  - Critical tables use `with context (...)` parameters (`SigningNonce`, `InviteSlotCid`, `UserKey`, `Signature`, `Tid`) to authorize mutations.
- **Only-insert tables**
  - Officers and signatures are append-only or insert-only to preserve auditability.

# Recommended Actions
- **Clarify first-user rule**: `User.InsertValid` checks `(select count(*) from User) = 1` for first user; confirm if this should be `= 0`.
- **Implement JSON validation TODOs** where marked to harden input constraints.
- **Reconcile references**:
  - `Keyholder` is referenced but not defined here; ensure it exists elsewhere or adjust rules.
  - Some commented constraints (e.g., referencing `AuthoritySignature` or field names like `Nonce` vs `SigningNonce`) should be aligned.
- **Consistency pass on naming**:
  - `AdminSignature` uses `SigningNonce` as PK; ensure all joins use the same column name.

# Summary
The schema models a permissioned governance network: authorities with time-versioned administrations, officers with scoped powers, and a robust multi-party signing workflow to authorize sensitive changes. Invitations bridge external onboarding. Proposal tables capture staged changes validated by current officers’ user keys and signatures. Integrity is enforced with deterministic digests, scope checks, thresholds, and temporal validity.






# VoteTorrent Schema: Domain Entities & Business Logic

## Core Domain Entities

### 1. **Network** (lines 6–43)
The top-level entity — represents a voting network. Singleton (empty primary key `()`).

| Column | Purpose |
|---|---|
| `Id` / `Hash` | Identity; `Hash` = `H16(Id)` |
| `PrimaryAuthorityId` | The governing authority — FK to `Authority` |
| `Relays` | P2P relay endpoints (JSON array) |
| `TimestampAuthorities` | TSA URLs for timestamping (JSON array) |
| `ElectionType` | `'o'` (Official) or `'a'` (Adhoc) |

### 2. **Authority** (lines 56–90)
An organization that administers elections. Multiple authorities can exist in a network, but one is the **primary authority** for the network.

### 3. **Admin** (lines 94–147)
A versioned administration configuration for an authority, keyed by `(AuthorityId, EffectiveAt)`. Contains `ThresholdPolicies` — JSON specifying how many officer signatures are needed per scope.

### 4. **Officer** (lines 155–202)
A person (user) who holds a role within an `Admin` epoch. Each officer has a `Title` and a set of `Scopes` (permissions). Keyed by `(AuthorityId, AdminEffectiveAt, UserId)`.

### 5. **User** (lines 533–561)
An identity in the system. Must be associated with either a `Keyholder` or an `Officer`. Has a name and optional image.

### 6. **UserKey** (lines 563–603)
Public keys belonging to a user. Supports types `'M'` (Mobile) and `'Y'` (Yubico). Keys expire and cannot be updated — only inserted or deleted.

---

## Signing / Authorization Subsystem

This is the most intricate part — a **multi-signature approval workflow**:

### 7. **AdminSigning** (lines 207–226)
A signing *session*. An officer initiates it by specifying:
- The **scope** of the action (e.g. `'rn'` = Revise Network)
- A **digest** of the content to be approved
- Their own **signature** proving they initiated it

### 8. **OfficerSignature** (lines 231–256)
Other officers co-sign the same `AdminSigning` session by providing their signature of the same digest. This builds toward the threshold.

### 9. **AdminSignature** (lines 259–273)
Materializes **only when the required threshold** of `OfficerSignature` rows is met for the signing session. Acts as a "proof of approval" that other constraints reference, avoiding expensive re-validation.

### Flow:
```
Officer initiates → AdminSigning
Other officers co-sign → OfficerSignature (1..N)
Threshold met → AdminSignature (proof)
AdminSignature referenced by → Network update, Authority insert, Admin mutation, InviteSlot, etc.
```

---

## Invitation Subsystem

### 10. **InviteSlot** (lines 465–485)
A one-time invitation token approved by admin signing. Contains an `InviteKey` (temporary public key) and an `Expiration`. The `Cid` is a content-addressed hash of the slot's fields.

### 11. **InviteResult** (lines 501–521)
Records acceptance or rejection of an invitation. If accepted, includes a `Digest` of whatever the invitee intends to create (authority, user, etc.). Signed with the invite key to prove possession.

### 12. **AcceptedInvite** (view, lines 523–528)
Convenience join of accepted `InviteResult` → `InviteSlot` → `AdminSigning` to surface the scope.

---

## Proposal ("Staged Change") Entities

These are **draft/proposed versions** of core entities, requiring officer-level authorization but not yet the full multi-sig approval:

| Entity | Mirrors | Scope Required |
|---|---|---|
| **ProposedNetwork** (275–347) | `Network` | `'rn'` (Revise Network) |
| **ProposedAuthority** (349–383) | `Authority` | `'uai'` (Update Authority Info) |
| **ProposedAdmin** (385–409) | `Admin` | `'rad'` (Revise Admin) |
| **ProposedOfficer** (411–437) | `Officer` | `'rad'` (Revise Admin) |
| **ProposedOfficerUser** (442–463) | Officer↔User link | user self-signs acceptance |

---

## Scope (Permission) Model

Defined in the `Scope` view (lines 45–54):

| Code | Meaning |
|---|---|
| `rn` | Revise Network |
| `rad` | Revise or replace the Admin |
| `vrg` | Validate registrations |
| `iad` | Invite other Authorities |
| `uai` | Update Authority Information |
| `ceb` | Create/Edit ballot templates |
| `mel` | Manage Elections |
| `cap` | Configure Authority Peers |

Officers are granted a subset of these scopes. `Admin.ThresholdPolicies` maps each scope to a required number of co-signatures.

---

## Key Business Rules Encoded in Constraints

### Bootstrap / Genesis
- The **very first authority** in the network is a "shoe-in" — no invite or signing required (`Authority.InsertValid`, `Admin.MutationValid`, `Officer.InsertValid`, `User.InsertValid`).
- After that, every new authority requires a valid **invite** (`InviteResult.IsAccepted = true` with matching digest).

### Immutability & Append-Only
- `Network.Id`, `Hash`, `PrimaryAuthorityId` are **immutable** after creation.
- `Authority.Id` is immutable.
- `Officer`, `OfficerSignature`, `AdminSigning`, `AdminSignature`, `InviteSlot`, `InviteResult` are all **insert-only** — no updates or deletes.
- `Network`, `Authority`, `User` **cannot be deleted**.

### Cryptographic Integrity
- Every mutation requires a **digital signature** validated via `SignatureValid(digest, signature, publicKey)`.
- Digests are computed over the exact fields being changed, bound to a **Tid** (transaction ID) to prevent replay attacks.
- `AdminSigning.SignatureValid` proves the initiator holds the private key.
- `OfficerSignature.SignatureValid` proves each co-signer signed the same digest.
- `InviteSlot.CidValid` ensures content-addressing — the `Cid` is the hash of the slot's contents.

### Threshold-Based Multi-Sig
- `AdminSignature` can only be inserted when the count of `OfficerSignature` rows meets or exceeds the threshold defined in `Admin.ThresholdPolicies` for the relevant scope.
- If no threshold policy is defined for a scope, **1 is assumed** (noted as TODO).

### Context-Based Authorization
Many tables use `with context(...)` to receive caller-provided values (`SigningNonce`, `UserId`, `UserKey`, `Signature`, `Tid`, etc.) that are validated in constraints but not persisted. This is the mechanism for **out-of-band authentication** — the caller proves identity and intent via cryptographic context.

### User Key Lifecycle
- Keys **cannot be updated**, only inserted or deleted.
- Deletion requires proving ownership of another non-expired key (you can't delete your last key).
- Expiration must be in the future at insertion time.

---

## Entity Relationship Summary

```
Network ──1:1──▶ Authority (PrimaryAuthorityId)
Authority ──1:N──▶ Admin (versioned by EffectiveAt)
Admin ──1:N──▶ Officer (users in that admin epoch)
Officer ──N:1──▶ User
User ──1:N──▶ UserKey

AdminSigning ──1:N──▶ OfficerSignature (co-signatures)
AdminSigning ──0..1──▶ AdminSignature (threshold met)

InviteSlot ──0..1──▶ InviteResult (accept/reject)
InviteResult ──used by──▶ Authority insert, Admin insert, Officer insert

Proposed* tables mirror their counterparts as staging areas for changes.
```

The overall design is a **decentralized, cryptographically-verified governance system** where authorities manage elections, officers perform scoped administrative actions requiring multi-party approval, and all mutations are traceable through digest-based signing chains.



## Comparision with vote-core models in TS

Starting with the Network entity as a singleton, it has an immutable ID and hash derived from that ID, with a required primary authority reference. The entity stores network metadata like name and image references as JSON, along with relay endpoints and timestamp authority configurations including a minimum required count. The schema definition appears to continue with additional fields.

Moving to the TypeScript model representation, it restructures some of these fields into a nested NetworkPolicies object that groups election type, timestamp authority requirements, and the authorities themselves—semantically the same data but organized differently than the flat SQL schema.

The Authority entity is simpler, with an immutable ID, a name field, and an optional domain name.

Now looking at the Admin table, which tracks administration epochs with a composite primary key of authority ID and effective date, storing threshold policies as a JSON array with scope and threshold values.

The TypeScript model diverges in a couple ways: it introduces a surrogate id field that doesn't exist in the schema where the composite key is actually used, and it denormalizes officers as an embedded array rather than keeping them as a separate related table.

Moving to the Officer table, which uses a three-part composite key combining authority ID, the admin's effective date, and user ID, with fields for title and scopes stored as JSON.

The TS model omits adminEffectiveAt entirely—it relies on the structural relationship of being nested within an Admin object to establish that connection, but the schema explicitly requires it as part of the primary key.

For the User table, I'm seeing it has an ID as the primary key, name, and optional image reference, with constraints that users must be linked to either a keyholder or officer role, have at least one associated key, and can't be deleted. The TS model mirrors the basic fields but I need to check how it handles those relationship and constraint requirements.

The UserKey table uses a composite primary key of user ID and public key, stores the key type and expiration date, and only allows inserts—no updates or deletes. The TS model denormalizes this by embedding active keys directly into the User object rather than keeping it as a separate table reference.

For AdminSigning, the schema defines a nonce-based signing session with authority, scope, and signature details, while the TS model abstracts this into a signing engine that returns whether a threshold has been reached. There's a mismatch between how the schema structures the signing data and what the TS interface exposes.

OfficerSignature and AdminSignature follow a similar pattern — the schema has concrete tables for individual officer signatures and the final admin signature, but the TS layer only provides partial modeling through the signing engine's result. InviteSlot ties these together by referencing the signing nonce, though the TS Invite type appears to be cut off.

Looking at the Invite type more closely, it includes fields like expiration, inviteKey, and inviteSignature, but notably omits the content hash, name, and signing nonce that exist in the schema. The private key is intentionally kept client-side only, and there's a digest field that doesn't have a clear schema counterpart. InviteResult seems to track acceptance status and digest information tied back to the slot.

Now examining the Proposal entities — the schema defines separate tables for ProposedNetwork, ProposedAuthority, ProposedAdmin, ProposedOfficer, and ProposedOfficerUser, but the TypeScript model consolidates these into a generic Proposal type with a proposed field and signature.

I'm noticing a significant gap: the election domain is fully modeled in TypeScript with ElectionCore, ElectionRevision, Ballot, Question, Option, and ElectionEvent, along with Keyholder concepts and timeline tracking, but there's no corresponding SQL schema for any of this. The database only covers network governance, authority management, signing workflows, and invites — the entire election system exists in code but has no persistence layer defined.

Tasks are another partially-defined concept: the TS models include Task, SignatureTask, and ReleaseKeyTask, and the SQL schema even references them in commented-out constraints, but they're not actually schema-defined yet. Similarly, Keyholder is referenced in a SQL constraint checking that users exist as keyholders, yet there's no Keyholder table in the schema and no Keyholder type in the TS models — only KeyholderInvite and SentKeyholderInvite exist, with 'k' as an InviteType value.

I'm also spotting a validation bug in the AdminSignature constraint: the inner query references an AuthoritySignature table that doesn't exist in the schema, when it should be referencing AdminSigning instead. And there's another bug in the User InsertValid constraint that appears to be cut off mid-query.

Looking at the ProposedOfficerUser.SignatureValid constraint, it's trying to reference fields like AdminRevision, UserId, SignerKey, and Signature on the ProposedOfficer table, but those columns don't actually exist there — it uses AdminEffectiveAt instead. Similarly, InviteSlot.InviteSignatureValid is referencing a Type column in its digest calculation, but InviteSlot has no Type column defined. And InviteResult.SigningValid appears to have another incomplete reference that's cut off.

There's also a mismatch where AdminSignature is trying to reference an AuthoritySignature table that doesn't exist — it should be AdminSigning instead. Plus, the TypeScript schema includes an 'rnp' scope that isn't defined anywhere in the SQL schema or its scope descriptions, which is a clear inconsistency between the two.



