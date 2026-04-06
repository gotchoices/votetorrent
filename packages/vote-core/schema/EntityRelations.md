# Entity Explanations

## Governance / Trust Layer

- **[Network](votetorrent/packages/vote-core/src/network/models.ts:4:0-25:2)** (singleton) — the root data container. Stores relay endpoints, TSA config, and election type policy. Its `Id`+`Hash` are permanently encoded into the protocol — they define which DHT you're on. `PrimaryAuthorityId` is immutable and anchors all trust.

- **[Authority](votetorrent/packages/vote-core/src/authority/models.ts:5:0-17:2)** — an organization (election board, district, etc.) with a name, domain, and image. Multiple authorities can coexist on a network; the primary authority bootstraps legitimacy and resolves administrative lapses.

- **[Admin](votetorrent/packages/vote-core/src/authority/models.ts:52:0-67:2)** — a versioned administration epoch for an authority, keyed by `(AuthorityId, EffectiveAt)`. Each epoch has `ThresholdPolicies` — a JSON map of `{ scope, threshold }` specifying how many officer co-signatures are required per operation type. The `CurrentAdmin` view selects the epoch with the most recent `EffectiveAt ≤ now`.

- **[Officer](votetorrent/packages/vote-core/src/authority/models.ts:89:0-101:2)** — a person (User) acting within an Admin epoch, with a `Title` and a set of `Scopes`. Officers are **insert-only** (never deleted) — they go out of effect when a new Admin epoch supersedes theirs.

- **[User](votetorrent/packages/vote-core/src/user/models.ts:7:0-12:2)** — a human identity. Must always have at least one non-expired [UserKey](votetorrent/packages/vote-core/src/user/models.ts:14:0-18:2), and must be associated with either an Officer role or a Keyholder role.

- **[UserKey](votetorrent/packages/vote-core/src/user/models.ts:14:0-18:2)** — a public key belonging to a User (`'M'` = mobile biometric-backed, `'Y'` = hardware YubiKey). Insert+delete only, never updated. Deletion requires proving ownership of another valid key.

## Multi-Party Signing Layer

- **`AdminSigning`** — a signing session: one officer initiates it with a [Scope](votetorrent/packages/vote-core/src/authority/models.ts:133:0-142:9), `Digest` (hash of the intended mutation), and their own signature. This is the "proposal" to authorize a change.

- **`OfficerSignature`** — each co-signing officer adds a row proving they signed the same `Digest`. These accumulate toward the threshold.

- **`AdminSignature`** — exists **only** when `count(OfficerSignatures) ≥ ThresholdPolicies[scope]`. Acts as the proof of approval referenced by all downstream mutations. Without this, nothing can be changed.

## Invitation Layer

- **`InviteSlot`** — a one-time invitation token. The authority generates an ephemeral Ed25519 key pair; the public key is published here, the private key is sent out-of-band to the invitee. CID is content-addressed over all fields.

- **[InviteResult](votetorrent/packages/vote-core/src/invite/models.ts:27:0-40:2)** — the invitee's public response: accepted/rejected, a `Digest` of what they intend to create, and a signature proving they possess the invite private key. This signature-based proof cryptographically binds the invitee's identity to the invitation without exposing the private key.

- **`AcceptedInvite`** (view) — joins InviteResult → InviteSlot → AdminSigning to surface the scope of what was authorized.

## Proposal / Staged Change Layer

- **`ProposedNetwork`, `ProposedAuthority`, `ProposedAdmin`, `ProposedOfficer`, `ProposedOfficerUser`** — pre-commit staged changes. Each requires the proposer to be a current Officer with the correct scope, a non-expired key, and a valid signature over a deterministic `Digest(Tid, ...fields)`. The `Tid` (transaction ID) prevents replays.

## Election Layer *(TypeScript only — SQL schema not yet defined)*

- **[ElectionCore](votetorrent/packages/vote-core/src/election/models.ts:4:0-25:2)** — the immutable part: `id`, `authorityId`, `title`, `date`, `revisionDeadline`, `ballotDeadline`, `type`. Cannot be changed after creation.

- **[ElectionRevision](votetorrent/packages/vote-core/src/election/models.ts:27:0-51:1)** — the revisable part: `revision` number, `keyholders[]`, `timeline` (7 phase timestamps), `instructions`, `tags`, `runoff` config. Each revision must bear TSA timestamps proving it precedes the deadline.

- **[Ballot](votetorrent/packages/vote-core/src/election/models.ts:161:0-179:2)** → **[Question](votetorrent/packages/vote-core/src/election/models.ts:220:0-261:2)** → **[Option](votetorrent/packages/vote-core/src/election/models.ts:200:0-218:2)** — district-level ballot templates. Questions support `select`, `rank`, `score`, and `text` types, with conditional display (`dependsOn`) and range constraints.

- **`Keyholder`** — *(referenced in schema but undefined)* — a trusted neutral party who holds an encrypted share of the election decryption key. They accept a type-`'k'` invite, generate an election-specific key pair, and must release the private key during the tallying phase.

---

# Step-by-Step System Workflow

## Phase 0 — Network Genesis (one time)
```
Authority admin creates the network in Authority App
  → Network record (Id, Hash, PrimaryAuthorityId, policies)
  → Primary Authority record
  → First Admin epoch (EffectiveAt = now, ThresholdPolicies)
  → First Officer (title, scopes)
  → First User + UserKey (biometric key pair generated in device TPM)
All records committed to Directory Network DHT
The Network Hash is encoded into the protocol — this IS the network's identity
```

## Phase 1 — Authority Administration Setup
```
Officer invites other Officers via InviteSlot (type='of')
  → AdminSigning session (scope='rad') → multi-sig → AdminSignature proof
  → InviteSlot published; private key sent out-of-band
  → Invitee generates their key pair → submits InviteResult
  → New Officer + User + UserKey inserted
  
Primary Authority can invite other Authorities (scope='iad')
  → InviteSlot (type='au') published
  → Invitee forms new Authority + Admin + Officers via InviteResult
```

## Phase 2 — Election Creation
```
Officer (scope='mel') creates election in Authority App
  → ElectionCore (immutable: title, dates, deadlines)
  → ElectionRevision #1 (instructions, timeline, empty keyholders[])
  → Signed by officer(s); multi-sig if threshold > 1
  → Published to Election Network DHT via pub-sub

Officer (scope='ceb') creates Ballot templates
  → Ballot + Questions + Options per district
  → Signed and published to Election Network

Officer invites Keyholders (scope='mel')
  → InviteSlot batch (type='k') → AdminSigning → AdminSignature
  → Private keys sent out-of-band to neutral parties
  → Each keyholder accepts via Authority App:
      generates election key pair → encrypts private key with own biometric key
      signs keyholder record → publishes to Election Network

After acceptance period: Election Revision #2 published
  → Includes accepted keyholder records
  → TSA timestamps proving revision predates revisionDeadline
```

## Phase 3 — Voter Registration
```
Voter App:
  1. Discovers network (location geohash search on Directory DHT, or QR/NFC)
  2. VERIFIES network out-of-band: app shows code, voter confirms independently
  3. Generates key pair in device TPM (biometric-backed)
  4. Fills registration form (public info: name, district, etc.)
  5. Transactor peers validate → Registrant record published to Election Network
  6. Optional: submits private data directly to authority (stored in private DB only)
  7. Device Association: authority issues attestation challenge →
      device signs with TPM → authority validates → signs Association record

Authority App (scope='vrg'):
  Reviews pending registrations → approves → signs Registrant record
  Reviews pending device associations → approves → signs Association record
```

## Phase 4 — Voting
```
Voter App:
  1. Fetches ElectionRevision + Ballot templates for voter's district(s)
  2. Voter makes selections per question (select/rank/score/text)
  3. App generates per-district vote nonce (random, voter may add entropy)
  4. Voter reviews all answers and saves nonces
  5. Per district:
     - VoteEntry: { answers, voteNonce } — encrypted with compound keyholder public key
     - VoterEntry: { registrantKey, publicCID, privateCID, signature } — also encrypted
     - Voter+Vote scrambled together with peers' entries
  6. P2P Block Formation (Matchmaking):
     - App finds peers via rendezvous key (templateCID + 'pooling' + pool hash)
     - Pool merges until capacity → coordinator sends 'form' message with block CID
     - All peers verify: CID correct, own records present, equal voter/vote counts
  7. Block submission via Optimystic (pend → commit → propagate → checkpoint)
  8. Receipt: app stores nonces + block CID locally

Authority monitors: does NOT see vote contents (everything encrypted)
```

## Phase 5 — Key Release
```
Timeline reaches 'tallyingStarts'

Each Keyholder → Authority App → "Release Key":
  Uses biometrics to decrypt the election private key from device storage
  Requests TSA timestamps (proves release time)
  Publishes: { electionId, publicKey, privateKey, TSA timestamps }

If any key released EARLY: validation anomaly record created as evidence
If threshold keys not released: election cannot be tallied → must re-run
```

## Phase 6 — Tallying
```
With all (or threshold) keyholder private keys released:

Network nodes combine keys to decrypt all vote blocks
  → VoteEntry and VoterEntry in every block become readable

Nodes coordinate to build Tally Tree (Merkle tree with vote histograms):
  Each node: { histogram of answers, hash of children }
  Signed by constructing nodes + TSA timestamped

Root of Tally Tree = raw election outcome, published to Election Network
```

## Phase 7 — Validation
```
Every voter (optional but encouraged):
  Slice validation: find own block by nonce → verify block hash → verify Merkle path to root

Authority validators + media (comprehensive):
  Validate every block: count(voters)==count(votes), signatures valid
  Validate every Tally/Merkle node: histograms and hashes correct
  Validate authority records: properly signed and timed

Validation report aggregated on Election Network:
  Success/failure records, error margin, anomaly statistics

RUNOFF triggers if:
  - disputed votes > spread between top candidates
  - accessibility failures > configured threshold
  - victory margin < configured threshold (e.g. ≤1%)
```

## Phase 8 — Certification and Publication
```
Officer (scope='mel') → Authority App → "Certify Election Results"
  Reviews: tally outcome + validation report
  Issues Certification record (positive or negative)
  Signed by required officer(s) → published to Election Network

Voters → Voter App → Results screen:
  Per-question charts, turnout stats, validation report card
  Runoff notice if triggered
  "Verify my vote" using saved nonce → confirms presence in tally tree
```

---

# Spec Files

`spec-authority-app.md` covers:
- All 11 Authority App modules (Network, Authority, Administration, Signing, Invitations, Elections, Ballots, Registration, Peer Config, Key Management, Task Inbox)
- Screen-by-screen specifications with fields, actions, and state transitions
- Complete data model mapping from SQL schema → UI
- Security constraints (immutability rules, multi-sig UX, context parameters)
- Known gaps and open items from schema analysis

`spec-voter-app.md` covers:
- Full voter journey (Discovery → Verify → Register → Associate → Vote → Block Formation → Receipt → Verification → Validation → Results)
- Screen-by-screen specifications
- In-person polling mode
- Privacy model table (what each observer can/cannot see)
- P2P matchmaking and block negotiation details
- Connectivity and resilience behavior
- Known gaps
