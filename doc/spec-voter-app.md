# VoteTorrent Voter Application — Functional Specification

> **Reverse-engineered from:** `votetorrent.qsql`, `vote-core/src`, `doc/election.md`, `doc/registration.md`, `doc/invitations.md`, `doc/matchmaking.md`, `doc/optimystic.md`, `user-faq.md`, and schema analysis.

---

## 1. Overview

The Voter App is the **citizen-facing mobile client** used by registered voters to:
1. Discover and verify an Election Network
2. Register as a voter
3. Cast ballots anonymously via peer-to-peer block formation
4. Verify their vote was counted
5. Participate in optional post-election validation

The app connects to:
- **Directory Network** (Kademlia DHT, global): for discovering authorities and election networks by location
- **Election Network** (Kademlia DHT, per election): for registration, ballot retrieval, voting, and verification

Private keys **never leave the device**. The biometric subsystem (TPM/Secure Enclave) is used for all signing operations.

---

## 2. System Workflow: Voter's Journey (End-to-End)

```
[Phase A] Discover & verify Election Network
        ↓
[Phase B] Generate key pair (biometric-backed)
        ↓
[Phase C] Register (public + private data)
        ↓
[Phase D] Device association (link key to registrant)
        ↓
[Phase E] Fetch election + ballot templates
        ↓
[Phase F] Cast vote → block negotiation (P2P)
        ↓
[Phase G] Receive vote receipt (nonce)
        ↓
[Phase H] Optional: verify own vote inclusion
        ↓
[Phase I] Optional: participate in validation
        ↓
[Phase J] View results after key release
```

---

## 3. Phase-by-Phase Detail

### Phase A — Discover and Verify the Election Network

The voter must first find and confirm they are on the correct Election Network.

#### A1. Discovery (two paths)

**Path 1 — Receive (out-of-band delivery)**
- Voter receives a QR code, NFC tag, or deep link from a trusted source (election office, authority website, mailed card)
- Scanning it pre-populates the Election Network ID

**Path 2 — Find (location-based search)**
1. App requests device location permission
2. Encodes location as a multi-level **geohash**
3. Queries **Directory Network** with simultaneous geohash searches at each precision level
4. Fetches Authority records from the Directory:
   - Each Authority record contains precise GeoJSON geometry for its district
   - Only authorities whose geometry contains the voter's location are retained
5. Authority records are verified against CA certificates
6. Voter selects the appropriate election from the list

#### A2. Network Verification (out-of-band confirmation — REQUIRED)

**Critical security step — prevents fake network impersonation.**

```
App computes a short "verification code":
  = compressed representation of Election Network ID hash (H16)

User is prompted:
  "Verify this code: [XXXX-XXXX]
   Check this code at [authority website] or confirm in person.
   Do NOT proceed if the codes do not match."

Voter enters the code they independently verified.
App compares: if match → proceed; if mismatch → reject with warning.
```

- The code **cannot** be embedded in the QR/deep link — it must always be verified through an independent channel
- This cryptographically binds the voter's participation to the legitimate authority

---

### Phase B — Generate Key Pair

```
First-time setup for this authority/election network:
  ↓
App prompts: "Set up your voting identity"
  ↓
Biometrics used to generate key pair inside device TPM / Secure Enclave:
  - Private key: never leaves hardware; protected by biometric
  - Public key: displayed as QR for optional printing/backup
  ↓
Voter may optionally add entropy (randomness) to the generation
  ↓
UserInit created: { name?, imageRef? }
  + UserKey: { key=publicKey, type='M' (Mobile) or 'Y' (Yubico), expiration }
  ↓
User and UserKey records pending submission (submitted during registration)
```

**Note:** Key type `'M'` = mobile biometric-backed key. `'Y'` = hardware security key (YubiKey). In-person polling also creates a fresh key per session and forces re-association.

---

### Phase C — Registration

Registration establishes the voter as a legitimate participant.

#### C1. Public Registration Submission

```
Voter fills in required public information:
  Fields (defined by election authority policy):
    - Last Name, First Name
    - District
    - [other authority-defined fields]
  ↓
Voter uses Matchmaking (topic='registration') to find transactor peers
  → Transactor squad forms (critical number of workers)
  ↓
Each transactor peer validates:
  - Signature verification (voter signed the registration, or authority if policy requires)
  - Structure and content validation (required fields present)
  - Optional checks (not blacklisted, valid district, etc.)
  ↓
If authority policy requires authority signature:
  → Registration request sent to authority peer node
  → Authority Officer (scope='vrg') approves → signs Registrant record
  ↓
Signed Registrant record created:
  { Id, PrivateCID?, PublicCID, Expiration, Signor, Signature }
  ↓
Published to Election Network registration Merkle tree (CRDT G-Set)
  ↓
Notification on 'registration' pub-sub topic (authority nodes pin the CID)
```

#### C2. Private Registration Submission (optional, authority-held)

```
Voter submits private information directly to authority:
  Fields (stored in RegistrantPrivate, never on public network):
    - SSN, Phone, DOB, [other sensitive fields]
  ↓
Authority stores in its Private Registration DB (REST API)
  ↓
Authority computes PrivateCID = hash(RegistrantPrivate record)
  ↓
Authority returns:
  - PrivateCID (voter can independently verify)
  - Signature over PrivateCID
  ↓
PrivateCID embedded in public Registrant record for verifiability without disclosure
```

**Privacy guarantee:** Private data never touches the public Election Network. Tampering with private data changes the CID, which is detectable.

#### C3. Video Interview (optional)

- Authority policy may require a live video interview with document presentation
- Authority officer reviews and then signs the registration
- Handled out-of-band; registration remains pending until officer approves

---

### Phase D — Device Association

Device association cryptographically binds the voter's device key to their registrant record.

```
Association flow:
  ↓
Authority peer sends a challenge to the voter's device
  ↓
Device processes challenge via OS biometric/TPM subsystem → produces attestation result
  ↓
Voter submits to authority:
  { RegistrantId, DeviceKey=pubKey, DeviceHash=SHA256(deviceId), attestationResult }
  ↓
Authority validates:
  - Attestation result is valid (device-native verification)
  - Device not already associated (unless in-person polling whitelist device)
  ↓
Authority signs Association record:
  { RegistrantId, DeviceKey, DeviceHash, Expiration, Signor, Signature }
  ↓
Association published to Election Network
  ↓
Voter can now cast a ballot signed with DeviceKey
```

**In-person polling mode:** Authority device whitelist overrides duplicate-device check, allowing polling tablets to be reused per voter session.

---

### Phase E — Fetch Election and Ballot

```
App checks for active elections associated with voter's registration:
  ↓
Fetches from Election Network:
  - ElectionCore: id, title, date, type, deadlines
  - Latest ElectionRevision: instructions, keyholders, timeline, tags
  - All Ballot records for this voter's district(s)
  ↓
Constructs combined ballot view:
  - Merges district-level Ballot templates
  - Questions with optionRange, scoreRange, dependencies
  ↓
App checks: has voter already submitted a vote for this election?
  - If YES: app has lost state or key was compromised
    → Load existing voter record if nonce is available
    → Warn voter; offer recovery (manual nonce entry)
  - If NO: proceed to voting
```

---

### Phase F — Vote Casting and Block Negotiation

#### F1. Ballot Interaction

```
App presents combined ballot (per-district Ballot templates merged):
  ↓
Voter makes selections:
  - select: pick N options (bounded by optionRange.min/max)
  - rank: order options
  - score: assign score within scoreRange
  - text: free-text answer
  ↓
Conditional questions appear/disappear based on dependsOn expressions
  ↓
Review screen:
  - Full summary of all selections
  - Vote nonces displayed (one per district ballot):
    * Auto-generated random nonce
    * Voter may add entropy to each nonce
    * Voter encouraged to copy/save nonces privately
  ↓
Voter confirms and submits
```

**Vote nonce:** The voter's secret receipt. After key release, the voter uses this nonce to locate their vote in the published tally and verify it is present and unaltered.

#### F2. Vote Entry Generation

```
Per district ballot, app generates:

VoteEntry:
  { answers: [{ questionCode, selectedOptions, score?, rank?, text? }], voteNonce }

VoterEntry:
  {
    registrantPublicKey,
    publicRegistrantCID,
    privateRegistrantCID,
    optional: { location, deviceId, deviceAttestation },
    signature: Sign(Digest(voterEntry, ballotTemplateCID), registrantPrivateKey)
  }
```

Both entries are **encrypted** using the compound election public key (combination of all keyholder public keys). The order of voters and votes within a block is **scrambled** so no observer can match voter to vote.

#### F3. P2P Block Negotiation (Vote Block Formation)

Votes are submitted in **batches (blocks)** negotiated peer-to-peer for anonymity. A block contains multiple scrambled voter+vote pairs.

```
App joins Election Network DHT as active node
  ↓
Uses Matchmaking (rendezvous key derived from ballotTemplateCID + 'pooling' token):
  ↓
As pool coordinator:
  - Subscribe to pub-sub topic: (templateCID + 'pooling' + hash(pool))
  - Publish 'present' message with current pool size + multiaddress
  ↓
Pool merging:
  - 'greet' message with reciprocal size → 'merge' message
  - All pool members 'informed' of new size and coordinator address
  - Any non-acknowledging node → merge reverted → follow-up inform with offender ID
  ↓
Pool formation:
  When pool reaches capacity OR voting period is ending:
  - Coordinator sends 'form' message to all contributors
  - Message includes CID = hash of block records portion
  - All peers verify:
    * CID is correct
    * Their own vote+voter records are present and unaltered
    * Equal number of voter and vote records
    * (Optionally) voter uniqueness check
  ↓
Block submission via Optimystic:
  1. pend(): send block transforms to all involved blocks (with TTL)
  2. commit(): append to Election Network vote collection tail block
  3. propagate(): update all affected block revisions
  4. checkpoint(): finalize

Block published to Election Network DHT
  ↓
App receives commit promise signatures from cluster peers
```

**Failure handling:**
- If a peer misbehaves (duplicate voter, invalid record), block reform triggered excluding bad actor
- Bad actor's peer info whispered to other peers → eventual blacklisting
- If voter is the last remaining and all blocks failed: voter may submit a **singular block** (reveals vote to authority — last resort)
- All block negotiation failures are logged for validation phase

#### F4. Vote Receipt

```
On successful block commit:
  ↓
App stores locally (private, never published):
  { voteNonce, blockCID, electionId, districtId, answers, voterEntry, timestamp }
  ↓
Receipt screen shows:
  - "Your vote was submitted"
  - Vote nonces (one per district)
  - Copy/export buttons for safekeeping
  ↓
App remains active on Election Network during active period
  (maintains DHT node presence for block integrity)
```

---

### Phase G — Post-Submission: Verification Wait

```
App monitors Election Network timeline:
  ↓
[Registration Ends] → [Ballots Final] → [Voting Ends] → [Accruing Period]
  ↓
During accruing period (brief, after voting closes):
  - No new votes accepted
  - Transactions settle
  ↓
[Tallying Starts]:
  - Keyholders release private election keys (Authority App)
  - App polls Election Network for key release
  ↓
Once all (or threshold) keys released:
  → Election data becomes decryptable
  → Tally tree construction begins on the network
```

---

### Phase H — Vote Verification

```
Verification screen available after key release:
  ↓
Voter enters or retrieves their vote nonce(s)
  ↓
App queries Election Network:
  - Finds the block containing a vote entry with matching nonce
  - Retrieves full block
  ↓
Slice validation (voter performs for own vote):
  ✓ Vote entry with my nonce is present in a block
  ✓ My voter entry is in the SAME block, signature valid
  ✓ Block hash matches (unaltered)
  ✓ Block is included in the Tally Tree Merkle path to root
  ✓ Each branch node's histogram and hash are consistent
  ↓
Displays result:
  "Your vote is confirmed present in the election results"
  + shows their recorded answers
  ↓
If vote NOT found:
  - Flags as missing vote anomaly
  - Voter may submit a validation report with nonce as evidence
```

---

### Phase I — Validation Participation (Optional)

Voters can optionally contribute to the broader election integrity validation.

```
[Validation] tab in app after key release:
  ↓
Slice-level (every voter should do):
  - As above in Phase H

Report network issues:
  - Log any connectivity problems encountered during voting
  - Even transient issues reported for statistical purposes

Comprehensive validation (for nodes with capacity):
  - Download and verify every block:
    * Count(voters) == Count(votes)
    * All voter signatures valid
    * All votes decryptable and answers valid
  - Verify every Tally + Merkle tree node
  - Verify all authority records are properly signed and timed
  ↓
Results submitted to Validation Report (built on Election Network):
  - Success records: block CID, validation type, status
  - Failure records: block CID, failure type, cryptographic proof
  ↓
Validation report aggregated across all validators:
  - Suggests error margin
  - Statistical info: participation rate, anomalies, network issues
```

---

### Phase J — Results Display

```
After tally completion:
  ↓
Results screen shows (per election + per district):
  - Final vote counts per question option
  - Visual charts (bar chart, pie chart)
  - Voter turnout statistics
  ↓
Certification status:
  - Shows positive/negative certification from ballot authority
  - Timestamp and signing officer
  ↓
Runoff indicator:
  If runoff triggered (discrepancy margin, accessibility issues, close result):
  → Shows runoff election link / notification
  ↓
Validation report summary:
  - Error margin percentage
  - Number of anomalies
  - Confidence rating
```

---

## 4. Voter Application — Screen-by-Screen Specification

### 4.0 Onboarding

#### Screen: Welcome
- Options:
  - **Find My Election** — location-based authority discovery
  - **Scan QR Code / Tap NFC** — receive election deep link
  - **Enter Network Code** — manual entry for accessibility

#### Screen: Election Network Discovery (location-based)
- Requests location permission
- Shows loading indicator while searching Directory Network
- Displays list of found authorities with name, district type, jurisdiction name
- "Can't find your authority?" — link to manual entry or support

#### Screen: Network Verification ⚠️
- Displays verification code prominently (e.g. `HAWK-7283`)
- Instructions: "Check this code at [authority domain] or at the polling location before proceeding"
- Field: "Enter the code you verified" with confirm button
- Clear warning: "Never proceed without verifying this code. A fake network could steal your vote."
- On mismatch: red error, option to report suspicious network

---

### 4.1 Identity Setup

#### Screen: Your Voting Identity
- State: first time for this election network
- Action: **Generate Secure Key Pair**
  - Triggers biometric prompt (Face ID / fingerprint)
  - Generates Ed25519 key pair in device TPM
  - Shows public key as QR code
  - Option: "Print or save this QR for key recovery"
- Optional fields: Your name (for your own reference, not required on-network)
- Shows: key expiration date

#### Screen: Key Backup (optional)
- Displays public key as QR + hex string
- Option to export / share securely
- Security warning: "Your private key never leaves this device. Keep your device safe."

---

### 4.2 Registration

#### Screen: Registration Form
- Explained: "Register to confirm your eligibility to vote"
- Fields defined by authority policy — typically:
  - Legal first name, last name
  - District / address (auto-populated from geolocation or manual)
  - Any authority-required public fields
- Optional: Profile photo upload
- Privacy toggle: "I have private information to submit" — if on, shows private flow after

#### Screen: Private Information (optional)
- Explained: "This information goes only to the election authority, never to the public network"
- Fields: authority-defined (e.g., DOB, last 4 of SSN)
- After submission: displays `PrivateCID` (hash) voter can independently verify
- "Your private data is identified by this hash: [PrivateCID]. You can verify the authority holds it correctly."

#### Screen: Registration Status
- States:
  - **Submitting** — sending to transactor peers
  - **Pending Authority Approval** — if authority signature required
  - **Approved** — signed Registrant record confirmed on network
  - **Rejected** — with reason, option to appeal / resubmit
  - **Expired** — expiration date reached; re-registration needed
- Shows `RegistrantId` (never personally identifying; random)
- Shows `PublicCID` of published record

#### Screen: Device Association
- State: after registration approved
- Explained: "Link this device to your registration for secure voting"
- Action: **Associate This Device**
  - Triggers device attestation challenge from authority
  - Device processes challenge via OS TPM
  - Result sent to authority for validation
  - Authority returns signed Association record
- Status: **Associated** / **Pending** / **Failed**
- Shows: DeviceKey (public key), expiration, device hash

---

### 4.3 Election & Ballot

#### Screen: Elections
- List of elections voter is eligible for
- Each card: title, authority, date, status (Upcoming/Active/Voting Closed/Results Available)
- Badge: "You are registered" / "Registration pending" / "Not registered"
- Tap → Election Details

#### Screen: Election Details
- **Overview tab:**
  - Title, type (Official/Adhoc), date/time
  - Authority name + domain
  - Instructions (Markdown rendered)
  - Tags
  - Timeline: visual progress through phases
  - Keyholders: list of accepted keyholder names (no keys shown)
- **Ballot tab:**
  - List of ballot templates for voter's districts
  - Each ballot: authority, district description, question count
  - Action: **View Ballot Preview** (before voting) / **Vote** (during voting window)
- **Results tab** (after key release):
  - Per-question results, charts, validation summary, certification

#### Screen: Ballot Preview
- Read-only view of all questions and options
- Shows dependencies: "Question 3 appears only if you answered 'Yes' to Question 2"
- Option range and score range explanations
- No answers can be entered in preview mode

---

### 4.4 Voting

#### Screen: Cast Your Vote

**Step 1 — Introduction**
- "Election voting is now open"
- Explains vote nonces: "You'll receive a secret code for each district ballot. Save it to verify your vote later."
- Legal disclaimer if applicable
- **Begin Voting** button (requires biometric confirmation)

**Step 2 — Ballots (per district)**
For each district ballot:
- Question list with full instructions
- Input per question type:
  - **select**: checkboxes or radio buttons with optionRange enforcement
  - **rank**: drag-and-drop ranking of options
  - **score**: slider within scoreRange
  - **text**: free-text area
- Conditional questions: appear/disappear dynamically
- Progress indicator: "District 2 of 3"
- **Next/Back** navigation; answers preserved across navigation

**Step 3 — Review**
- Full summary of all selections per district
- Edit buttons per section
- **Vote Nonces** displayed prominently:
  - One per district ballot, randomly generated
  - Voter can add custom entropy: tap to edit, add seed characters
  - "Copy All Nonces" button, "Screenshot" option
  - **WARNING:** "These codes prove your vote is included. Save them NOW before submitting."
- Estimated submission time

**Step 4 — Submit**
- Final confirmation: "Submit your votes? This cannot be undone."
- Biometric re-authentication required
- Block negotiation begins:
  - Progress per district: "Finding voting peers..." → "Forming block..." → "Submitting..." → "Confirmed"
  - Spinner with status text
  - If block formation fails: "Retrying with new peers..." (auto-retry)
  - Last resort warning: "Block formation timed out. Submit solo? (Your vote may be identifiable to the authority.)"

**Step 5 — Receipt**
- "Your votes have been submitted"
- Confirmation per district with ✓
- **Nonces displayed again** with copy/export/share
- "Save your receipt" PDF export option
- "Verify your vote later" link to verification screen

---

### 4.5 Vote Receipt & Verification

#### Screen: My Receipts
- List of past vote submissions
- Each: election name, date, districts voted, status (Submitted / Verified / Failed)
- Storage: local only (private), never synced to network

#### Screen: Verify My Vote
- Available after key release (election timeline reaches results phase)
- Shows: election name, voter's district ballots
- For each ballot:
  - Displays saved nonce or prompts to enter manually
  - Action: **Verify**
    - Queries Election Network for vote entry with matching nonce
    - Verifies: inclusion in block, block hash integrity, Merkle path to root
  - Result states:
    - ✅ **Verified** — "Your vote for [district] is present and unaltered"
    - ❌ **Not Found** — "Your vote nonce was not found. This may indicate an issue."
    - ⚠️ **Block Excluded** — "Your block was excluded from the final tally. File a dispute?"

#### Screen: File Validation Report
- If verification fails, voter can submit an anomaly report:
  - Type: Missing vote, Block excluded, Accessibility issue, Key leaked
  - Evidence: nonce (auto-attached), timestamps, optional description
  - Report submitted as validation anomaly to Election Network
  - "Your report will be included in the collective validation summary for this election"

---

### 4.6 Results

#### Screen: Election Results
- Available after tallying complete + keys released
- Header: election name, final status (Certified / Certification Pending / Disputed / Runoff)
- Per ballot template (by district):
  - Per question:
    - Bar chart of option vote counts
    - Percentages and total votes
    - Ranked results if applicable
- Turnout stats: registered voters, votes cast, participation rate
- **Validation Report card:**
  - Error margin (e.g. ±0.3%)
  - Anomaly count
  - Comprehensive validation coverage %
  - Link to full validation report

#### Screen: Certification Status
- List of ballot authorities + their certification:
  - ✅ Positive: "Results certified by [Authority] on [date]"
  - ❌ Negative: "Results disputed by [Authority] — [reason]"
  - ⏳ Pending: "Certification not yet issued"

#### Screen: Runoff Notice
- "A runoff election has been triggered for [ballot name]"
- Reason: margin too close / accessibility issues / disputed votes
- Runoff date, schedule
- "You are automatically eligible to participate" (same registration applies)
- Action: **Register for Runoff Notifications**

---

### 4.7 Settings & Profile

#### Screen: My Profile
- Displays: UserKey (public key QR, type, expiration)
- Networks joined: list of election networks
- Actions:
  - **Add a New Key** — biometric prompt → new key generated → `IUserEngine.addKey(key)`
  - **Revoke a Key** — only if another valid key exists → `IUserEngine.revokeKey(key)`
  - **Export Keys** — export public key for backup/printing
  - **Revise Info** — update name/image → creates signed history event

#### Screen: Privacy Settings
- Toggle: Share location for authority discovery
- Toggle: Include device attestation in voter entry
- Toggle: Participate in comprehensive validation (background)
- Toggle: Automatic vote receipt export

#### Screen: Security
- Biometric authentication: enabled/disabled
- Key expiration reminders
- Network verification log (past verifications with results)

---

## 5. In-Person Polling Mode

A special configuration for polling locations providing tablets.

```
Authority pre-configures device in "Polling Mode":
  - Network locked: cannot change Election Network
  - Single-use sessions: app resets after each voter completes their session
  - No network switching
  ↓
Voter approaches tablet → app in reset state → begins association flow:
  1. Voter looks up registration (by name or ID)
  2. Voter scans biometric on tablet
  3. Device attestation sent to authority
  4. Authority checks device ID against whitelist (polling tablets)
  5. Association approved (duplicate device ID ignored for whitelisted devices)
  ↓
Voter completes full voting flow on tablet
  ↓
App resets (clears user session, keys, receipts)
  ↓
Optionally: DeviceHash published for transparency (proves unique device used)
    without revealing actual device ID
```

---

## 6. Data Model Mapping (Schema → Voter App)

| Schema / TS Entity | Voter App Representation |
|---|---|
| `Network` | Network discovery, verification screen |
| `Authority` | Authority card in discovery list, election authority header |
| `User` / `UserKey` | Identity Setup screen, My Profile |
| `UserKeyType` | Key type selector ('M' mobile / 'Y' YubiKey) |
| `Registrant` (registration.md) | Registration Form + Status screen |
| `RegistrantPublic` | Public fields in registration form |
| `RegistrantPrivate` (authority-held) | Private Information screen |
| `Association` | Device Association screen |
| `ElectionCore` | Election card header, immutable fields |
| `ElectionRevision` | Election details: instructions, timeline, keyholders |
| `Ballot` | District ballot in combined ballot view |
| `Question` | Individual question UI (select/rank/score/text) |
| `Option` | Answer choices per question |
| `VoteEntry` (in-block) | Generated per district ballot during vote submission |
| `VoterEntry` (in-block) | Generated during vote submission from registration |
| `Block` (vote block) | P2P block negotiation progress UI |
| `InviteResult` | Invite acceptance during registration if invite-based |
| `ElectionEvent` | Timeline visualization |
| Vote nonce | Displayed on receipt screen; used for verification |
| Validation report | Validation tab, file anomaly report screen |
| Certification | Results screen certification status card |
| `Runoff` | Runoff notice screen |

---

## 7. Privacy and Security Model (Voter Perspective)

### 7.1 What the Voter Controls
- **Private key**: never leaves device hardware
- **Vote content**: encrypted with compound keyholder key; nobody can read until key release
- **Vote nonce**: only the voter knows their nonce; used for self-verification
- **Private registration data**: goes only to authority, never on network

### 7.2 What Is Visible On-Network (Public)
- `VoterEntry` within a block: registrant public key, public CID — links voter to "having voted" but NOT to their specific vote
- Block order scrambled: even within a block, voter-to-vote linkage is cryptographically obscured
- After key release: all vote entries decryptable, but voter-to-vote mapping is statistically limited to block size

### 7.3 What Authority Can See
- Public registration data (submitted on-network)
- Private registration data (held in authority's private DB)
- Whether voter submitted a block (via `VoterEntry.registrantPublicKey`)
- If voter was forced to submit a solo block (last resort): authority can identify the vote

### 7.4 What Peers Can See
- Only: that you are participating in block formation (your temporary pool coordinator role)
- Not: your vote content, your vote direction, your answers

### 7.5 Anonymity Guarantees
| Observer | Can See | Cannot See |
|---|---|---|
| Other peers | Block pool activity | Which voter made which vote |
| Authority | Who voted (voter entry) | How they voted (until key release + only statistically after) |
| Anyone after key release | All scrambled vote entries | Definitive voter-to-vote mapping (only probabilistic per block) |
| Solo block exception | Authority can match voter + vote | — (only when forced by block formation failure) |

---

## 8. Connectivity and Resilience

### 8.1 Background DHT Participation
- App joins DHT networks in the background during the active election period
- Remains as an active node to support block integrity and validation
- Uses short-term TTLs for active matcher roles (block formation)
- Uses longer-term TTLs for worker/storage roles

### 8.2 Network Issues During Voting
- Block formation auto-retries with new peers if any peer misbehaves
- Bad peer behavior whispered between peers → eventual blacklisting
- App logs all connectivity issues for validation reporting
- If unable to reach any peers: app stores vote locally and retries
- If voting window is about to close: voter warned to consider solo submission

### 8.3 Matchmaking Adaptation
```
Block formation uses adaptive rendezvous keys:
  - Derived from: local Kademlia address bits + hash(ballotTemplateCID + 'pooling')
  - If too few peers found → decrease local bits, increase topic bits (broaden search)
  - If too many peers found → increase local bits, decrease topic bits (narrow search)
  - Very sparse network → use entire topic hash (single rendezvous point)
  - Very dense network → use more local bits (local rendezvous)
```

---

## 9. Open Items and Known Gaps

- **`Keyholder` table undefined in schema**: Voter app currently treats keyholder-associated users as ordinary Users with a special invite type `'k'`. When the `Keyholder` schema table is defined, the app should track keyholder status and election key custody explicitly.

- **Election/Ballot SQL schema absent**: `ElectionCore`, `ElectionRevision`, `Ballot`, `Question`, `Option` are only TypeScript types. Persistence to the DHT is via Optimystic collections, but the schema needs to be defined for the constraint enforcement and validation logic.

- **Vote block vs. database block naming conflict**: `doc/election.md` notes a TODO to rename vote blocks to avoid confusion with Optimystic database blocks. The voter app should use "Vote Pool" for the forming state and "Vote Block" for the committed state.

- **Tally tree coordination**: How the distributed tally tree is constructed and coordinated is noted as an open question in `doc/election.md`. The voter's verification flow assumes the tally tree is available, but its construction protocol is not yet specified.

- **Nonce storage in backup**: `doc/todo.md` notes "Allow local storage of nonces for instance to be located in backup storage" — the receipt/nonce export feature covers this for now, but an encrypted cloud backup option should be specified.

- **Runoff specification**: `ElectionRevision` contains a `runoff` field per the TypeScript models, but the exact data structure and triggering algorithm are not yet fully specified in the schema. The voter app's runoff detection relies on the validation report anomaly counts.
