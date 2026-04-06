# VoteTorrent Authority Application — Functional Specification

> **Reverse-engineered from:** `votetorrent.qsql`, `vote-core/src`, `doc/administration.md`, `doc/election.md`, `doc/registration.md`, `doc/invitations.md`, and tutorial documents.

---

## 1. Overview

The Authority App is the **administrative client** used by election officials (Officers/Administrators) to govern a VoteTorrent network. It connects to both the **Directory Network** (global, long-lived) and per-election **Election Networks** (scoped, time-bounded).

### 1.1 Actor Roles (from schema `Scope` enum)

| Scope Code | Role Name | Can Perform |
|---|---|---|
| `rn` | Network Reviser | Update network-level settings |
| `rad` | Administration Reviser | Create/replace Admin epochs, manage Officers |
| `vrg` | Registration Validator | Approve/reject voter registrations |
| `iad` | Authority Inviter | Invite new peer Authorities to join the network |
| `uai` | Authority Info Updater | Update the authority's own name/domain/image |
| `ceb` | Ballot Editor | Create and edit ballot templates |
| `mel` | Election Manager | Create, revise, and manage election lifecycle |
| `cap` | Peer Configurator | Configure authority peer nodes |

An Officer may hold any subset of these scopes. The `Admin.ThresholdPolicies` determines how many co-signatures are required per scope operation.

---

## 2. System Workflow: Network Setup → Results (End-to-End)

### Phase 0 — Network Genesis (One-time Bootstrap)

This is the exceptional first-time path where no invite or signing is required.

```
[Officer] Opens Authority App → "Create Network"
  ↓
Provides: NetworkInit
  - Primary Authority name, domain, image
  - Network name, relays, election type, TSA config
  - First Admin: officers with scopes, threshold policies
  - First Officer: title, scopes (must include 'rad' per OfficerRequired constraint)
  - First User: name, image, initial UserKey (biometric-backed TPM key)
  ↓
App generates:
  - Network.Id (32-byte random), Network.Hash = H16(Id)
  - Authority.Id (random), Authority record
  - Admin record (AuthorityId, EffectiveAt = now)
  - Officer record (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
  - User record, UserKey record
  ↓
Records published to Directory Network DHT
  ↓
Network is live; primary authority's SID encoded into protocol
```

**Schema constraint satisfied:** `Authority.InsertValid` genesis path (no invite, no signing, no prior authorities), `Admin.MutationValid` genesis, `Officer.InsertValid` genesis, `User.InsertValid` genesis.

---

### Phase 1 — Authority Administration Setup

#### 1A. Inviting a New Officer to the Current Authority

Prerequisites: Current Officer with scope `rad`.

```
[Officer A] → Authority App → "Invite Officer"
  ↓
Provides OfficerInit: { name, title, scopes }
  ↓
App generates InviteSlot:
  - Generates ephemeral Ed25519 invite key pair
  - Creates InviteSlot: { Cid, Name, Expiration, InviteKey, InviteSignature, SigningNonce }
  - InviteSignature = Sign(Digest(Cid, Name, Expiration), invitePrivateKey)
  - Initiates AdminSigning session (scope='rad', digest over all proposed Admin+Officers)
  ↓
[Other Officers with 'rad' scope] receive SignatureTask
  → Open task → Review content → Sign with their UserKey
  → OfficerSignature rows created
  ↓
When OfficerSignature count ≥ ThresholdPolicies['rad']:
  → AdminSignature row created (proof of approval)
  ↓
InviteSlot published (batch assertion InviteSlotSigningValid must pass)
  ↓
PrivateInviteKey delivered to invitee out-of-band (QR / deep link / email)
  ↓
[Invitee] receives invite → generates own key pair → creates InviteResult:
  { SlotCid, IsAccepted=true, Digest=H(new officer+user data), InviteSignature }
  ↓
[Network] validates InviteResult.SignatureValid against InviteSlot.InviteKey
  ↓
New Officer, User, and UserKey records created (invite-backed insert path)
  ↓
Admin epoch updated to include new Officer
```

#### 1B. Inviting a New Authority

Prerequisites: Officer with scope `iad` in the primary authority.

```
[Officer] → "Invite Authority"
  ↓
Provides: { name, suggestedDomain }
  ↓
AdminSigning session (scope='iad') → multi-sig collection → AdminSignature
  ↓
InviteSlot of type 'au' published
  ↓
PrivateInviteKey delivered to new authority's founding officer out-of-band
  ↓
[Invitee] forms new Authority:
  - Creates AuthorityAcceptance with Authority + Admin + Officer records
  - Digest covers: Authority.Id, Authority.Name, DomainName, ImageRef,
      DigestAll(Admin epochs), DigestAll(Officers)
  - Signs with own key + invitePrivateKey
  ↓
InviteResult { IsAccepted=true, Digest=..., InvokedId=newAuthorityId } created
  ↓
New Authority, Admin, Officer records inserted (invite-backed path in Admin.MutationValid)
```

#### 1C. Renewing an Administration Epoch

```
[Officer with 'rad'] → "Propose New Administration"
  ↓
Provides ProposedAdmin: { AuthorityId, EffectiveAt (future), ThresholdPolicies }
  + ProposedOfficers: list of { AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes }
  ↓
UserValid constraint: proposer is current officer, has 'rad' scope,
  key is non-expired, signature = SignatureValid(Digest(Tid, AuthorityId, EffectiveAt, ThresholdPolicies))
  ↓
Once all ProposedOfficerUser records filled (each invited officer accepts):
  → AdminSigning session (scope='rad') initiated with rollup digest
  → Co-signatures collected → AdminSignature proof
  ↓
New Admin + Officer rows committed (signing-backed insert path)
```

---

### Phase 2 — Election Creation and Lifecycle

#### 2A. Creating an Election

Prerequisites: Officer with scope `mel`.

```
[Officer] → "Create Election"
  ↓
Provides ElectionCoreInit (IMMUTABLE after creation):
  - id: random unique ID
  - authorityId
  - title: election title
  - type: 'o' (Official) or 'a' (Adhoc)
  - date: Unix timestamp of election date
  - revisionDeadline: last date/time revisions are allowed
  - ballotDeadline: last date/time ballot templates can be changed
  ↓
Provides ElectionRevisionInit (REVISABLE):
  - revision: 1 (first revision)
  - tags: ["general"], ["primary"], etc.
  - instructions: Markdown text for voters
  - keyholders: [] (filled later via invitations)
  - timeline: {
      registrationEnds, ballotsFinal, votingStarts,
      tallyingStarts, validation, certificationStarts, closed
    }
  - keyholderThreshold: minimum keyholders required to decrypt
  ↓
ElectionInit signed by officer (scope='mel')
  ↓
Multi-sig collected if threshold > 1
  ↓
Published to Election Network DHT via pub-sub topic
```

**Note:** `ElectionCore` is truly immutable — any structural change requires abandoning and replacing the election. `ElectionRevision` supports incremental numbered updates, each bearing TSA timestamps proving they precede the `revisionDeadline`.

#### 2B. Creating Ballot Templates

Prerequisites: Officer with scope `ceb`.

```
[Officer] → "Create Ballot Template"
  ↓
Provides Ballot:
  - id, electionId, authorityId (the ballot authority's district)
  - description: human-readable description
  - districts: string[] of district/group codes
  - questions: Question[]
    Each Question:
      - code, title, instructions (Markdown)
      - type: 'select' | 'rank' | 'score' | 'text'
      - options: Option[] (code, title, details, infoURL, image?, video?)
      - optionRange?: { min, max }  // number of selections
      - scoreRange?: { min, max, step }
      - dependsOn?: { code, valuesExpression }  // conditional questions
      - required?: boolean
  ↓
Ballot signed by officer(s) (scope='ceb')
  ↓
Published to Election Network
```

#### 2C. Inviting Keyholders

Prerequisites: Officer with scope `mel`. Keyholders are trusted neutral parties who hold a share of the election decryption key.

```
[Officer] → "Invite Keyholders"
  ↓
For each keyholder:
  Creates InviteSlot of type 'k':
  - Generates ephemeral invite key pair per slot
  - InviteSlot: { Cid, Name, Expiration, InviteKey, InviteSignature, SigningNonce }
  ↓
Batch signed: DigestAll(Cid ORDER BY Cid) = AdminSigning.Digest
  → AdminSignature proof
  ↓
Invite deep-links / QR codes sent out-of-band to keyholder candidates
  ↓
[Keyholder accepts via Authority App]:
  - Generates an election-specific key pair
    (Note: private key must be releasable later, so may not use HSM)
  - Encrypts election private key with own biometric-backed registration key
  - Stores encrypted private key on device
  - Signs keyholder acceptance record with registration private key
  - Creates InviteResult { IsAccepted=true, Digest=H(keyholder record), InviteSignature }
  - Publishes keyholder record to Election Network
```

#### 2D. Revising the Election (Adding Accepted Keyholders)

```
After keyholder acceptance period ends:
  ↓
[Officer with 'mel'] → "Revise Election"
  Constructs ElectionRevisionInit (revision N+1):
  - Same fields as initial revision
  - keyholders[] now includes accepted keyholder records from InviteResults
  - revisionTimestamp[]: TSA timestamps proving revision predates revisionDeadline
  ↓
Revision signed by officer(s) → multi-sig collected
  ↓
Published via pub-sub to Election Network
```

---

### Phase 3 — Voter Registration (Authority Side)

#### 3A. Registration Approval

```
[Voter submits registration request (see Voter App spec)]
  ↓
Registration arrives at Authority peer node
  ↓
[Officer with 'vrg'] → "Pending Registrations" list
  ↓
For each pending registration:
  - View submitted public data (Name, District, etc.)
  - Optionally review private data CID via Private Registration DB (REST)
  - Optional: video interview review
  ↓
Approve → Sign Registrant record:
  { Id, PrivateCID, PublicCID, Expiration, Signor=officerKey, Signature }
  ↓
Signed Registrant record published to Election Network
  ↓
Optional: ElectionRegistrant record created linking Election + Registrant
```

#### 3B. Device Association Approval

```
[Voter submits device association request]
  → DeviceKey (public), DeviceHash (SHA-256 of device ID), attestation challenge result
  ↓
[Authority peer or Officer with 'vrg'] → validates:
  - Device attestation result is valid
  - Device not already associated (unless in-person polling mode whitelist)
  ↓
Signs Association record:
  { RegistrantId, DeviceKey, DeviceHash, Expiration, Signor, Signature }
  ↓
Published to Election Network
  ↓
Voter can now cast a vote signed with DeviceKey
```

---

### Phase 4 — Voting Period (Authority Monitoring)

During the voting period, the authority:
- Monitors Election Network peer health
- Runs probe transaction nodes to verify notifications are received
- Watches for block submission activity
- Does NOT see vote contents (encrypted with compound keyholder keys)

---

### Phase 5 — Key Release

```
[Election timeline reaches 'tallyingStarts' event]
  ↓
[Each Keyholder] → Authority App → "Release Election Key"
  ↓
App uses biometrics to unlock the encrypted election private key from device storage
  ↓
Requests TSA timestamp(s) from configured Timestamp Authorities
  ↓
Publishes:
  { electionId, publicKey, privateKey, timestamps: TSA[] }
  signed with keyholder's registration key
  ↓
Published to Election Network
  ↓
[Validation note]: If any key is released BEFORE 'tallyingStarts',
  a validation anomaly record is created capturing the premature key + TSA timestamp
```

**Critical:** If `keyholderThreshold` keys are not released, the election cannot be tallied and must be re-run.

---

### Phase 6 — Tallying and Validation

```
With all (or threshold) keyholder private keys released:
  ↓
Network nodes use combined keys to decrypt all vote blocks
  ↓
Nodes coordinate to build Tally Tree (Merkle tree with histograms at each node):
  - Each node contains: histogram of answers, hash of children
  - Each tally node signed by constructing nodes, timestamped by TSAs
  ↓
Root tally entry = raw election outcome, published to Election Network
  ↓
Validation phase (parallel):
  - Voters perform slice validation (own vote present and unaltered)
  - Authority validators perform comprehensive validation:
    * Count(voters) == Count(votes) per block
    * All voter signatures valid
    * All votes valid and decryptable
    * All tally/Merkle nodes consistent
  ↓
Validation report built and stored on Election Network:
  - Includes success/failure records with proof
  - Suggests error margin
  - Statistical information (participation rate, anomalies)
```

**Runoff triggers:**
- Disputed votes exceed spread between top candidates
- Reported voter accessibility issues exceed configured threshold
- Margin of victory within configured threshold (e.g. ≤1%)

---

### Phase 7 — Certification

```
[Officer with 'mel'] → "Certify Election Results"
  ↓
Reviews: tally outcome + validation report
  ↓
Issues positive or negative Certification record:
  - References election, final result hash
  - Positive: certifies outcome as valid
  - Negative: certifies anomaly/dispute requiring runoff or further action
  ↓
Signed by required officer(s) (scope='mel')
  ↓
Published via pub-sub to Election Network
```

---

## 3. Authority Application — Screen-by-Screen Specification

### 3.0 Onboarding

#### Screen: Welcome / Network Selection
- **State: no network joined**
- Options:
  - **Create Network** — starts the genesis flow (see §2, Phase 0)
  - **Join Network** — scan QR / enter network hash to join existing network
- Warnings: "Creating a network makes you the primary authority. Do not create a new network for routine operations."

#### Screen: Create Network Wizard
**Step 1 — Primary Authority Info**
- Fields: Authority Name*, Domain Name*, Image (URL or upload)

**Step 2 — Network Policies**
- Fields: Network Name*, Election Type (Official/Adhoc)*, Relay endpoints* (multiaddresses), TSA URLs, Minimum Required TSAs

**Step 3 — First Administrator**
- Fields: Officer Title*, Scopes* (checklist), Threshold Policies (scope → min-signature count)

**Step 4 — Your Account**
- Fields: Your Name*, Profile Image
- Action: Generate key pair via biometric (hardware TPM/Secure Enclave)
- Displays: public key QR, optionally printable for backup

**Step 5 — Review & Create**
- Shows summary; submits genesis transaction

---

### 3.1 Network Management

#### Screen: Network Overview
- Displays: Network name, hash, primary authority, election type, relay list, TSA list
- Actions:
  - **Propose Revision** → opens ProposedNetwork form (requires scope `rn`)
  - **Copy Network Hash** — for sharing
  - **View Network Verification Code** — compressed hash for out-of-band verification

#### Screen: Propose Network Revision
- Form mirrors `NetworkRevision`: name, imageRef, relays[], policies (electionType, numberRequiredTSAs, timestampAuthorities[])
- On submit: creates `ProposedNetwork` — requires officer in CurrentAdmin with scope `rn`, non-expired key, and valid signature
- Pending proposal displays signers progress bar vs. threshold

---

### 3.2 Authority Management

#### Screen: Authority Details
- Displays: Authority name, domain, image, ID
- Actions:
  - **Propose Authority Update** (scope `uai`) → form for name/domain/image change
  - **View Pending Proposal** if a `ProposedAuthority` exists

#### Screen: Invite New Authority (scope `iad`)
- Form: Suggested name for new authority, expiration date
- Triggers AdminSigning session (scope=`iad`) → multi-sig collection → InviteSlot creation
- Shows: invite QR code + deep link for sharing out-of-band
- Tracks: InviteStatus showing whether invite was accepted or rejected

#### Screen: Pinned Authorities
- List of known/pinned authorities with name, domain, status
- Actions: pin, unpin, open authority

---

### 3.3 Administration Management

#### Screen: Current Administration
- Displays: EffectiveAt, ThresholdPolicies table (scope → threshold), Officers list
- Each officer shows: UserId, Title, Scopes[]
- Actions:
  - **Propose New Admin Epoch** (scope `rad`) → opens Propose Admin wizard
  - **Invite New Officer** (scope `rad`)

#### Screen: Propose Admin Wizard
**Step 1 — New Epoch Date**
- EffectiveAt picker (must be ISO 8601 UTC)
- ThresholdPolicies editor: table of scope → threshold integer

**Step 2 — Officers**
- List of proposed officers (from `ProposedOfficer`):
  - For each: ProposedName, Title, Scopes checkboxes
  - Per-officer status: "Awaiting invite acceptance" / "Accepted (UserId linked)"
- Add officer: fill OfficerInit → generates OfficerInvite → sends invite

**Step 3 — Review & Propose**
- Computes DigestAll rollup
- Submits ProposedAdmin + ProposedOfficers (scope `rad`)

**Step 4 — Signing Collection**
- Shows progress: X of Y required signatures received
- Lists signing officers with status

#### Screen: Invite Officer
- Form: Suggested name, Title, Scopes (checkboxes from scope list)
- On submit: creates InviteSlot (type='of') → shows QR + deep link to share

---

### 3.4 Signing Workflow

#### Screen: Pending Signing Tasks (task type: `signature`)
- Tabs: Network | Authority | Admin | Election | Ballot
- Each task card shows:
  - **Type**: what is being signed (e.g. "Network Revision", "Admin Epoch Change")
  - **Digest**: content hash to verify
  - **Proposed By**: initiating officer name
  - **Signatures**: X of Y threshold collected
  - **Your status**: Pending / Signed / Rejected

#### Screen: Sign Task
- Displays: full content diff (current vs. proposed)
- Key info: Scope, Digest
- Action: **Sign** → `ISigningEngine.sign(nonce, signature)` where `signature = { signature, signerKey, signerUserId }`
  - Returns `thresholdReached: boolean`
  - If true: AdminSignature created, downstream mutation can proceed
- Action: **Reject** (with optional comment)

---

### 3.5 Invitation Management

#### Screen: Sent Invites
- Tabs: Authority Invites | Officer Invites | Keyholder Invites | Registrant Invites
- Each invite shows: InviteSlot.Name, Expiration, Status (Pending/Accepted/Rejected/Expired)
- For each accepted invite: InvokedId (ID of created entity)
- Actions: Resend, Revoke (if not yet accepted)

#### Screen: Respond to Received Invite
- Only relevant when this authority's officer is being invited to join another authority's administration
- Shows: invite source authority, proposed scopes, expiration
- Actions: **Accept** (provide user info + sign with own key + invite private key) / **Reject**

---

### 3.6 Election Management

#### Screen: Elections List
- Tabs: Active | Upcoming | Past
- Each card: title, authority, type (Official/Adhoc), date, status
- Actions: Open, Create New

#### Screen: Create Election
**Step 1 — Immutable Core** (cannot be changed after creation)
- Fields: Title*, Election Date*, Revision Deadline*, Ballot Deadline*, Election Type*
- Warning: "These fields cannot be changed once the election is created"

**Step 2 — Initial Revision**
- Fields: Tags[], Instructions (Markdown), Election Timeline:
  - Registration Ends, Ballots Final, Voting Starts, Tallying Starts, Validation, Certification Starts, Closed
- Keyholder Threshold
- Keyholders: empty initially, filled via invitations

**Step 3 — Sign & Publish** (scope `mel`)

#### Screen: Election Details
- Tabs: Overview | Ballots | Keyholders | Registration | Timeline | Results

**Overview tab:**
- Core info, revision history, current revision's instructions and tags

**Ballots tab:**
- List of Ballot templates for this election
- Actions: Create Ballot (scope `ceb`), Edit Ballot (scope `ceb`)

**Keyholders tab:**
- List of InviteStatus<SentKeyholderInvite> with acceptance status
- Action: **Invite Keyholder** → generates InviteSlot (type='k')
- Action: **Release My Key** (if this officer is a keyholder and timeline is at tallyingStarts)

**Registration tab:**
- Pending registrations list with approve/reject (scope `vrg`)
- Pending device associations

**Timeline tab:**
- Visual timeline with all ElectionEvent timestamps
- Current position indicator
- Status per milestone: upcoming / reached / overdue

**Results tab:**
- Tally tree display (per question, per district)
- Validation report summary (error margin, anomaly count)
- Certification status
- Action: **Certify** (scope `mel`) → positive/negative certification

#### Screen: Revise Election
- Available up to `revisionDeadline`
- Form shows current revision fields, all editable (except ElectionCore fields)
- Must attach TSA timestamps proving revision predates deadline
- Revision number auto-incremented
- Signing flow required (scope `mel`)

---

### 3.7 Ballot Template Management

#### Screen: Ballot Editor
- Form fields: Description, Districts[], then Questions builder
- **Question Builder:**
  - Add question: Code*, Title*, Instructions, Type (select/rank/score/text), Required toggle
  - For select/rank: Options builder (Code, Title, Details, InfoURL, Image, Video)
  - optionRange: min/max selections
  - scoreRange: min/max/step (for score type)
  - Conditional: dependsOn (question code + valuesExpression)
  - Sequence within group

---

### 3.8 Peer Configuration (scope `cap`)

#### Screen: Authority Peers
- List of configured peer node IDs for this authority
- These peers auto-sign operations like device association approvals
- Actions: Add Peer, Remove Peer
- Generates signed AuthorityPeers record with current officer signatures

---

### 3.9 Registration Management (scope `vrg`)

#### Screen: Pending Registrations
- Queue of registration requests from voters
- Each item: Registrant public data, submission timestamp
- Actions: **Approve** → signs Registrant record / **Reject** → with reason
- Optional: link to Private Registration DB for private data verification

#### Screen: Registrant List
- Searchable list of all registered voters (public data only)
- Shows: Id, Name, District, Expiration, Association status
- Filters: District, Association status

---

### 3.10 User Profile & Key Management

#### Screen: My Profile
- Displays: Name, Image, UserId, active keys (type, expiration)
- Actions:
  - **Add Key** → `IUserEngine.addKey(key)` — generates new key pair via biometric
  - **Revoke Key** → `IUserEngine.revokeKey(key)` — requires another valid non-expired key
  - **Revise Info** → update Name/Image → creates `ReviseUserHistory` signed record
- Constraint: Cannot revoke last key; deletion requires proving ownership of another key

#### Screen: User History
- Chronological log: create event, key additions, key revocations, info revisions
- Each entry: event type, timestamp, signature

---

### 3.11 Task Inbox

#### Screen: Tasks
- Unified inbox for all pending officer duties:
  - **`SignatureTask`** — sign a pending change (admin/authority/network/election/ballot)
  - **`ReleaseKeyTask`** — release keyholder key for a completed election

- Each task: network reference, type, signatureType, description
- Sorted by urgency (deadline proximity)
- Clicking opens the relevant screen with context pre-loaded

---

## 4. Data Model Mapping (Schema → Authority App)

| Schema Entity | Authority App Representation |
|---|---|
| `Network` | Network Overview screen; `NetworkRevision` proposal |
| `Authority` | Authority Details screen; `ProposedAuthority` proposal |
| `Admin` | Current Administration screen |
| `Officer` | Officer list within Admin; individual officer cards |
| `AdminSigning` | Pending Signing Tasks (initiated via `ISigningEngine.startSigningSession`) |
| `OfficerSignature` | Co-sign action on a task (`ISigningEngine.sign`) |
| `AdminSignature` | Auto-created when threshold met; unlocks downstream mutation |
| `InviteSlot` | Sent Invites; QR/deep-link generation |
| `InviteResult` | Invite acceptance status tracking |
| `ProposedNetwork` | "Propose Network Revision" form |
| `ProposedAuthority` | "Propose Authority Update" form |
| `ProposedAdmin` | "Propose New Admin Epoch" wizard |
| `ProposedOfficer` | Officer list in Propose Admin wizard |
| `ProposedOfficerUser` | Officer invite acceptance (links UserId to ProposedOfficer) |
| `User` / `UserKey` | My Profile screen |
| `ElectionCore` | Create Election Step 1 |
| `ElectionRevision` | Create Election Step 2; Revise Election screen |
| `Ballot` / `Question` / `Option` | Ballot Template editor |
| `Task` | Task Inbox |
| `Registrant` / `Association` | Registration Management screens |

---

## 5. Key Security and UX Constraints

### 5.1 Cryptographic Requirements
- All private keys **must** be generated and stored in hardware TPM / Secure Enclave
- Biometric authentication required before any signing action
- Signatures use Ed25519 or equivalent; digest always includes `Tid` (transaction ID) to prevent replay
- Keyholder election keys are encrypted at rest using the keyholder's hardware-backed key

### 5.2 Multi-Signature UX
- When an action requires multiple signatures (`ThresholdPolicies[scope] > 1`):
  - Initiating officer sees "Waiting for co-signatures" state with progress indicator
  - Other officers receive push notification / in-app task
  - Signing session has a timeout; if not completed, action must be restarted
  - `AdminSignature` (proof of completion) is only created when threshold met

### 5.3 Immutability Rules Enforced in UI
- Network fields `Id`, `Hash`, `PrimaryAuthorityId`: not editable after creation
- `Authority.Id`: never editable
- `ElectionCore` fields: displayed as read-only after election creation; app warns "requires re-creation to change"
- Insert-only records (Officer, AdminSigning, OfficerSignature, AdminSignature, InviteSlot, InviteResult): app never offers delete for these

### 5.4 Context Parameters
Several operations pass `context` parameters validated server-side but not stored:
- `SigningNonce`: proves this mutation is authorized by a completed signing session
- `InviteSlotCid` + `InviteSignature`: proves invite-backed creation
- `UserId`, `UserKey`, `Signature`: prove proposer identity
- `Tid` (Transaction ID): replay protection, always injected by the system

### 5.5 Pending Proposals
- `Proposed*` entities represent pre-commit staged changes visible to officers
- Each proposal shows: current value vs. proposed value, list of signers, threshold progress
- A proposal is "activated" only when the full multi-sig flow completes and the underlying entity is mutated

---

## 6. Open Items & Known Gaps (from schema analysis)

- **`Keyholder` table undefined**: `User.UserValid` references a `Keyholder` table that has no schema definition. The Keyholder domain is present in `election/models.ts` via `KeyholderInvite`/`SentKeyholderInvite`, and `InviteType='k'` exists, but no persistence model is defined. The authority app must treat a Keyholder as a `User` who has accepted an invite of type `'k'` and holds an encrypted election key on their device.

- **Election/Ballot tables not in SQL schema**: The entire election domain (`ElectionCore`, `ElectionRevision`, `Ballot`, `Question`) exists only in TypeScript types. The SQL schema needs these tables defined before the authority app can persist elections.

- **`Task` / `NetworkSignatureTaskExtension` not in SQL schema**: Commented-out `ProposedNetwork` constraints reference these tables. They need to be defined.

- **`'rnp'` scope**: Present in the TypeScript `Scope` type but absent from the SQL schema `Scope` view and `scopeDescriptions`. Clarify intent before implementing scope-gating UI for it.

- **`AdminSignature.SignatureValid` bug**: References `AuthoritySignature` (does not exist); should be `AdminSigning`. Must be fixed before the finalization proof mechanism works.

- **`User.InsertValid` count bug**: Genesis check uses `= 1` instead of `= 0`. Must be corrected.
