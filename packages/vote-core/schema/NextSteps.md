
# VoteTorrent Domain Model

## Enumerations

| Enum | Codes | Used By |
|---|---|---|
| **ElectionType** | `o` = Official, `a` = Adhoc | `Network.ElectionType`, `ElectionCore.type` |
| **Scope** | `rn`, `rad`, `vrg`, `iad`, `uai`, `ceb`, `mel`, `cap` | `Officer.Scopes`, [AdminSigning.Scope](votetorrent/packages/vote-core/src/authority/models.ts:133:0-142:9), `ThresholdPolicy.policy` |
| **UserKeyType** | `M` = Mobile, `Y` = Yubico | `UserKey.Type` |

---

## Core Entities

### [Network](votetorrent/packages/vote-core/src/network/models.ts:4:0-25:2) (singleton — empty PK)

| Attribute | Type | Constraints |
|---|---|---|
| `Id` | text | **Immutable** after creation |
| `Hash` | text | `= H16(Id)`, immutable |
| `PrimaryAuthorityId` | text | FK → `Authority.Id`, **immutable** |
| `Name` | text | — |
| [ImageRef](votetorrent/packages/vote-core/src/common/image-ref.ts:0:0-3:1) | text? | JSON `{ url?, cid? }` |
| `Relays` | text | JSON `string[]` |
| `TimestampAuthorities` | text | JSON `{ url: string }[]` |
| `NumberRequiredTSAs` | integer | `>= 0`, default `0` |
| `ElectionType` | text | Must be in `ElectionType` enum |

**Constraints**: `CantDelete`, `IdImmutable`, `HashImmutable`, `PrimaryAuthorityIdImmutable`, `PrimaryAuthorityIdValid`. Updates require a valid `AdminSigning` with scope `rn` and a matching digest over all fields.

---

### [Authority](votetorrent/packages/vote-core/src/authority/models.ts:5:0-17:2)

| Attribute | Type | Constraints |
|---|---|---|
| `Id` | text PK | Immutable |
| `Name` | text | — |
| `DomainName` | text? | Nullable |
| [ImageRef](votetorrent/packages/vote-core/src/common/image-ref.ts:0:0-3:1) | text? | JSON |

**Insert paths**:
- **Genesis** (first ever): no invite, no signing.
- **Otherwise**: valid [InviteResult](votetorrent/packages/vote-core/src/invite/models.ts:27:0-40:2) (accepted, digest matches new content).

**Update**: Requires `AdminSigning` with scope `uai`.

---

### [Admin](votetorrent/packages/vote-core/src/authority/models.ts:52:0-67:2) (versioned administration epochs per authority)

| Attribute | Type | Constraints |
|---|---|---|
| `AuthorityId` | text | FK → [Authority](votetorrent/packages/vote-core/src/authority/models.ts:5:0-17:2), composite PK |
| `EffectiveAt` | datetime | PK; ISO 8601 ending `'Z'` |
| `ThresholdPolicies` | text | JSON `{ scope, threshold }[]`, default `'[]'` |

**Insert paths** (3-way):
1. **Genesis**: first authority, no invite, no signing.
2. **New authority via invite**: signed [InviteResult](votetorrent/packages/vote-core/src/invite/models.ts:27:0-40:2) with digest rollup over [Admin](votetorrent/packages/vote-core/src/authority/models.ts:52:0-67:2) + all `Officers`.
3. **Existing authority re-admin**: `AdminSigning` session with matching digest rollup.

**View**: `CurrentAdmin` = `max(EffectiveAt) WHERE EffectiveAt <= now`, per authority.

---

### [Officer](votetorrent/packages/vote-core/src/authority/models.ts:89:0-101:2) (per admin epoch, insert-only)

| Attribute | Type | Constraints |
|---|---|---|
| `AuthorityId` | text | Composite PK |
| `AdminEffectiveAt` | datetime | Composite PK; FK → [Admin](votetorrent/packages/vote-core/src/authority/models.ts:52:0-67:2) |
| `UserId` | text | Composite PK; FK → [User](votetorrent/packages/vote-core/src/user/models.ts:7:0-12:2) |
| `Title` | text | — |
| `Scopes` | text | JSON [Scope[]](votetorrent/packages/vote-core/src/authority/models.ts:133:0-142:9), must be valid scope codes |

**`OnlyInsert`**: no updates or deletes. Same 3-way insert auth as [Admin](votetorrent/packages/vote-core/src/authority/models.ts:52:0-67:2). Indexed by `UserId`.

---

### [User](votetorrent/packages/vote-core/src/user/models.ts:7:0-12:2)

| Attribute | Type | Constraints |
|---|---|---|
| `Id` | text PK | Immutable |
| `Name` | text | — |
| [ImageRef](votetorrent/packages/vote-core/src/common/image-ref.ts:0:0-3:1) | text? | JSON |

**Constraints**: `CantDelete`, `ValidModification` (Id unchangeable). Must be associated to a `Keyholder` **or** an [Officer](votetorrent/packages/vote-core/src/authority/models.ts:89:0-101:2). Must have at least one [UserKey](votetorrent/packages/vote-core/src/user/models.ts:14:0-18:2).

---

### [UserKey](votetorrent/packages/vote-core/src/user/models.ts:14:0-18:2)

| Attribute | Type | Constraints |
|---|---|---|
| `UserId` | text | Composite PK; FK → [User](votetorrent/packages/vote-core/src/user/models.ts:7:0-12:2) |
| `PubKey` | text | Composite PK |
| `Type` | text | FK → `UserKeyType` |
| `Expiration` | datetime | Must be in future at insert |

**Rules**: `NoUpdate` (insert + delete only). Delete requires proving ownership of another non-expired key (can't delete last key). Cryptographic `SignatureValid` on add/delete unless it's the user's very first key.

---

## Signing Subsystem (Multi-party Authorization)

### `AdminSigning` (insert-only, the signing session)

| Attribute | Purpose |
|---|---|
| `Nonce` PK | Random session ID |
| `AuthorityId` | Which authority |
| `AdminEffectiveAt` | Which admin epoch |
| [Scope](votetorrent/packages/vote-core/src/authority/models.ts:133:0-142:9) | FK → [Scope](votetorrent/packages/vote-core/src/authority/models.ts:133:0-142:9) (what action is being authorized) |
| `Digest` | Content hash of the mutation to be authorized |
| `UserId` | Initiating officer |
| `SignerKey` | Initiator's public key |
| [Signature](votetorrent/packages/vote-core/src/common/signature.ts:0:0-4:2) | Proves initiator holds the private key |

### `OfficerSignature` (insert-only, co-signatures)

PK: `(SigningNonce, UserId)`. Each co-signing officer adds a row proving they signed the same `Digest` from the parent `AdminSigning`.

### `AdminSignature` (insert-only, finalization proof)

PK: `SigningNonce`. Exists **only** when `count(OfficerSignature for nonce) >= threshold` from `Admin.ThresholdPolicies[scope]`. All downstream constraints reference this as proof of approval.

**Flow**:
```
Officer initiates → AdminSigning
Others co-sign   → OfficerSignature (1..N)
Threshold met    → AdminSignature (proof of approval)
↓
Network update / Authority insert / Admin mutation / InviteSlot creation
```

---

## Invitation Subsystem

### `InviteSlot` (insert-only)

| Attribute | Purpose |
|---|---|
| `Cid` PK | Content-addressed hash = `Digest(Name, Expiration, InviteKey, InviteSignature, SigningNonce)` |
| `Name` | Informational name of invitee |
| `Expiration` | Must be future |
| `InviteKey` | Temp public key of invite pair |
| `InviteSignature` | Proves inviter owns the corresponding private key |
| `SigningNonce` | FK → `AdminSigning` (proves admin approved this invite) |

Batch assertion `InviteSlotSigningValid`: the combined `DigestAll(Cid ORDER BY Cid)` over the batch must match the `AdminSigning.Digest`.

### [InviteResult](votetorrent/packages/vote-core/src/invite/models.ts:27:0-40:2) (insert-only)

| Attribute | Purpose |
|---|---|
| `SlotCid` PK | FK → `InviteSlot` |
| `IsAccepted` | boolean |
| `Digest` | Hash of what the invitee intends to create (null if rejected) |
| `InviteSignature` | Verified against `InviteSlot.InviteKey` |
| `InvokedId` | Reserved ID for the entity being created |

**View**: `AcceptedInvite` joins `InviteResult → InviteSlot → AdminSigning` to surface scope.

---

## Proposal Layer (Staged Changes)

All `Proposed*` tables require the proposer to be an [Officer](votetorrent/packages/vote-core/src/authority/models.ts:89:0-101:2) in the `CurrentAdmin`, hold the required scope, have a non-expired [UserKey](votetorrent/packages/vote-core/src/user/models.ts:14:0-18:2), and provide a `SignatureValid(Digest(Tid, ...fields...), sig, userKey)`.

| Entity | Mirrors | Required Scope |
|---|---|---|
| `ProposedNetwork` | Network fields | `rn` |
| `ProposedAuthority` | Authority fields | `uai` |
| `ProposedAdmin` | Admin fields | `rad` |
| `ProposedOfficer` | Officer fields | `rad` |
| `ProposedOfficerUser` | Officer ↔ User link | user self-sign |

---

## Entity Relationships

```
Network ─── 1:1 ──▶ Authority (PrimaryAuthorityId, immutable)
Authority ── 1:N ──▶ Admin (versioned by EffectiveAt)
Admin ─────1:N ──▶ Officer (per epoch)
Officer ───N:1 ──▶ User
User ──────1:N ──▶ UserKey

AdminSigning ──1:N──▶ OfficerSignature
AdminSigning ──0:1──▶ AdminSignature (threshold met)
InviteSlot ───0:1──▶ InviteResult
InviteResult ─────── referenced by Authority/Admin/Officer insert validation

Proposed* ─ references ─▶ CurrentAdmin/Officer for authorization
```

---

# Discrepancies & Incomplete Implementations

## 🔴 Schema-Level Bugs

**1. `AdminSignature.SignatureValid` references non-existent table**

```@/Users/risavkarna/Documents/digithought/votetorrent/votetorrent/packages/vote-core/schema/votetorrent.qsql:267
join AuthoritySignature ATS on ATS.AuthorityId = A.AuthorityId and ATS.AdminEffectiveAt = A.EffectiveAt
```
`AuthoritySignature` does not exist. Should be `AdminSigning`.

**2. `User.InsertValid` first-user count bug**

```@/Users/risavkarna/Documents/digithought/votetorrent/votetorrent/packages/vote-core/schema/votetorrent.qsql:552
(SigningNonce is null and InviteSlotCid is null and InviteSignature is null and (select count(*) from User) = 1)
```
`= 1` should be `= 0` — confirmed in Findings.md. The check fires only after the first user already exists.

**3. `ProposedOfficerUser.SignatureValid` references ghost fields**

```@/Users/risavkarna/Documents/digithought/votetorrent/votetorrent/packages/vote-core/schema/votetorrent.qsql:455
where PA.AuthorityId = new.AuthorityId and PA.AdminRevision = new.AdminRevision and PA.ProposedName = new.ProposedName and PA.UserId = new.UserId and PA.SignerKey = new.SignerKey and PA.Signature = new.Signature
```
`ProposedOfficer` has neither `AdminRevision` (uses `AdminEffectiveAt`), `UserId`, `SignerKey`, nor [Signature](votetorrent/packages/vote-core/src/common/signature.ts:0:0-4:2) columns.

**4. `InviteSlot.InviteSignatureValid` references `Type` column that doesn't exist**

```@/Users/risavkarna/Documents/digithought/votetorrent/votetorrent/packages/vote-core/schema/votetorrent.qsql:475
constraint InviteSignatureValid check (SignatureValid(Digest(Cid, Type, Name, Expiration), InviteSignature, InviteKey)),
```
`InviteSlot` has no `Type` column.

---

## 🔴 Missing Domain: `Keyholder`

The SQL schema references `Keyholder` in `User.UserValid`:
```@/Users/risavkarna/Documents/digithought/votetorrent/votetorrent/packages/vote-core/schema/votetorrent.qsql:539
exists (select 1 from Keyholder K where K.UserId = new.UserId)
```
But:
- No `Keyholder` table is defined anywhere in the schema.
- No `Keyholder` TypeScript type exists in [src/](cci:9:votetorrent/packages/vote-core/src:0:0-0:0).
- [InviteType](votetorrent/packages/vote-core/src/invite/models.ts:67:0-67:49) includes `'k'` (keyholder) and [KeyholderInvite](votetorrent/packages/vote-core/src/election/models.ts:153:0-155:2) exists in [election/models.ts](cci:7:votetorrent/packages/vote-core/src/election/models.ts:0:0-0:0), but the entity itself is absent from both schema and models.

---

## 🟡 Underschema'd: Election Domain

The [election/models.ts](cci:7:votetorrent/packages/vote-core/src/election/models.ts:0:0-0:0) is fully implemented in TypeScript with rich types ([ElectionCore](votetorrent/packages/vote-core/src/election/models.ts:4:0-25:2), [ElectionRevision](votetorrent/packages/vote-core/src/election/models.ts:27:0-51:1), [Ballot](votetorrent/packages/vote-core/src/election/models.ts:161:0-179:2), [Question](votetorrent/packages/vote-core/src/election/models.ts:220:0-261:2), [Option](votetorrent/packages/vote-core/src/election/models.ts:200:0-218:2), `ElectionEvent`, [ElectionCoreInit](votetorrent/packages/vote-core/src/election/models.ts:53:0-74:2), etc.) — **but the SQL schema has zero election/ballot tables**. The schema only stores the network-level `ElectionType` policy enum.

Correspondingly, commented-out constraints in `ProposedNetwork` reference [Task](votetorrent/packages/vote-core/src/tasks/models.ts:5:0-7:2) and `NetworkSignatureTaskExtension` tables:
```@/Users/risavkarna/Documents/digithought/votetorrent/votetorrent/packages/vote-core/schema/votetorrent.qsql:333-340
select 1 from Task T
    join NetworkSignatureTaskExtension NX on NX.TaskId = T.Id
    where T.UserId = O.UserId
        and T.Type = 'signature'
        ...
```
[Task](votetorrent/packages/vote-core/src/tasks/models.ts:5:0-7:2) exists in TS ([tasks/models.ts](cci:7:votetorrent/packages/vote-core/src/tasks/models.ts:0:0-0:0)) but has no schema definition.

---

## 🟡 TypeScript Model Discrepancies

**1. `Admin.id` — spurious field**

```@/Users/risavkarna/Documents/digithought/votetorrent/votetorrent/packages/vote-core/src/authority/models.ts:55
id: string;
```
Schema uses composite PK `(AuthorityId, EffectiveAt)`. There is no single `id` column. The TS model adds a surrogate not backed by the schema.

**2. `Admin.officers` — officers denormalized into Admin**

```@/Users/risavkarna/Documents/digithought/votetorrent/votetorrent/packages/vote-core/src/authority/models.ts:64
officers: Officer[];
```
In the schema, [Officer](votetorrent/packages/vote-core/src/authority/models.ts:89:0-101:2) is a separate table referencing [Admin](votetorrent/packages/vote-core/src/authority/models.ts:52:0-67:2) via FK. Embedding them in [Admin](votetorrent/packages/vote-core/src/authority/models.ts:52:0-67:2) in TS diverges from the relational model.

**3. [Officer](votetorrent/packages/vote-core/src/authority/models.ts:89:0-101:2) missing `adminEffectiveAt`**

```@/Users/risavkarna/Documents/digithought/votetorrent/votetorrent/packages/vote-core/src/authority/models.ts:90-102
export type Officer = {
    userId: string;
    authorityId: string;
    title: string;
    scopes: Scope[];
};
```
The schema's [Officer](votetorrent/packages/vote-core/src/authority/models.ts:89:0-101:2) PK requires `AdminEffectiveAt` to identify which epoch this officer belongs to, but the TS type omits it entirely.

**4. `Authority.domainName` not nullable**

```@/Users/risavkarna/Documents/digithought/votetorrent/votetorrent/packages/vote-core/src/authority/models.ts:14
domainName: string;
```
Schema has `DomainName text null`. The TS type makes it a required `string`, stricter than the schema allows.

**5. Undocumented `'rnp'` scope in TS**

```@/Users/risavkarna/Documents/digithought/votetorrent/votetorrent/packages/vote-core/src/authority/models.ts:139
| 'rnp'
```
`'rnp'` is in the TS [Scope](votetorrent/packages/vote-core/src/authority/models.ts:133:0-142:9) union but is **not** in the SQL schema's [Scope](votetorrent/packages/vote-core/src/authority/models.ts:133:0-142:9) view. It also has no entry in `scopeDescriptions`. Unknown/undocumented intent.

**6. `InviteResult.digest` missing in TS**

Schema [InviteResult](votetorrent/packages/vote-core/src/invite/models.ts:27:0-40:2) requires `Digest text null` (the hash of what the invitee will create):
```@/Users/risavkarna/Documents/digithought/votetorrent/votetorrent/packages/vote-core/src/invite/models.ts:28-41
export type InviteResult = {
    isAccepted: boolean;
    invitationSignature: string;
    invokedId?: string;
};
```
`digest` is entirely absent. Also the field is named `invitationSignature` vs `InviteSignature` in schema.

**7. Signing subsystem has no TS entity types**

`AdminSigning`, `OfficerSignature`, and `AdminSignature` have no corresponding TypeScript types — only the interface methods [startSigningSession](cci:1:votetorrent/packages/vote-core/src/signing/types.ts:5:62-11:26) and [sign](cci:1:votetorrent/packages/vote-core/src/signing/types.ts:5:1-5:60) exist. The full signing session data is opaque to the TS type system.

---

## Summary Table

| Category | Issue | Severity |
|---|---|---|
| Schema bug | `AuthoritySignature` → should be `AdminSigning` in `AdminSignature.SignatureValid` | 🔴 Blocking |
| Schema bug | `User.InsertValid` count `= 1` should be `= 0` | 🔴 Bug |
| Schema bug | `ProposedOfficerUser` references ghost fields on `ProposedOfficer` | 🔴 Bug |
| Schema bug | `InviteSlot.InviteSignatureValid` uses undefined `Type` column | 🔴 Bug |
| Missing entity | `Keyholder` table undefined in schema and TS | 🔴 Gap |
| Missing schema | All election/ballot/task tables absent from SQL | 🟡 Incomplete |
| TS model | `Admin.id` surrogate not in schema | 🟡 Divergence |
| TS model | [Officer](votetorrent/packages/vote-core/src/authority/models.ts:89:0-101:2) missing `adminEffectiveAt` | 🟡 Divergence |
| TS model | `Authority.domainName` required vs nullable in schema | 🟡 Strictness mismatch |
| TS model | `'rnp'` scope undocumented and not in schema | 🟡 Unknown intent |
| TS model | [InviteResult](votetorrent/packages/vote-core/src/invite/models.ts:27:0-40:2) missing `digest` field | 🟡 Incomplete |
| TS model | No entity types for signing workflow (`AdminSigning`, `OfficerSignature`, `AdminSignature`) | 🟡 Incomplete |
| TODO constraints | JSON validation for [ImageRef](votetorrent/packages/vote-core/src/common/image-ref.ts:0:0-3:1), `Relays`, `TimestampAuthorities`, `ThresholdPolicies` | 🟢 Deferred |
| TODO constraints | `UserIdValid`, `SignerKeyValid`, `OfficerValid` in `AdminSigning`/`OfficerSignature` are commented out | 🟢 Deferred |
