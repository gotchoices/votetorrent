# Voter registration system

The VoteTorrent voter registration system fundamentally provides the rules governing which voters are legitimate.  Transaction nodes on the Voter Network must assess whether a given voter is legitimate enough to include in a given voting block, and depend on this system to accomplish that.  Here are the elements:
* A Registrant table identifies who the legitimate voters are.  This can either be on a per-election basis, or remain effective for multiple elections.
* An Association table established the link between the a given registrant and a device they are authorized to vote with.  Note that this could be equipment operated by the 
* When an election is published, which is done by the Election Authority, it will contain the rules designating the signing key(s) who are authorized to sign Registrants and Associations.
* A potential voter will send one of the following requests to the authority:
  * **Register** - this includes furnishing whatever required public and private information needed, and performing whatever verification steps are required by the authority.  In some cases, this may not be handled by our system, and instead registrant data will be synced with an existing registration system, or there might be a hybrid of the two.  The resulting public Registrant record is signed by the authority, and if it hasn't already been added to the Election Network, can be added by the requester.
  * **Associate** - this includes performing a device attestation, where a challenge is sent from authority, processed with the device's operating system, and a result sent to the authority.  The resulting public Association record is signed by the authority, and can be added onto the Network by the requester.
* The authority will have a presence as one or more peers on the Election Network, and the list of its peers will be published and ammended in AuthorityPeers.  These peers are reached in a clustered manner, with an authority protocol, to affect the above.
* We will provide a reference implementation that can be implemented in app, or a dedicated service.  There will be a basic filesystem based implementation, and a web-hook/REST based implementation for bridging with another system.
* We will encourage transparency, by giving transparency statistics and a rating.

### Public Election Network schema

Registrant
* Id * - Randomly generated unique registrant identifier, specific to the person
* PrivateCID - Identifier and hashcode of the registrant's private registration data
* PublicCID - Identifier and hashcode of the registrant's public registration data
* Expiration
* Signor - A key of the signor - this must have been authorized by the authority
* Signature - The signature of this record, from the signor

RegistrantPublic
* CID * - Identifier and hashcode of this record
* RegistrantId
* [Last Name]
* [First Name]
* [District]
* ...

ElectionRegistrant
* ElectionId *
* RegistrantId *

Association
* RegistrantId *
* DeviceKey - the public key that will be used by this voter.  The private key should be in biometrically secured TPM hardware on the device.
* DeviceHash - a sha256 hashcode of the device's ID
* Expiration
* Signor - A key of the signor - this must have been authorized by the authority
* Signature - The signature of this record, from the signor

AuthorityPeer (normalized — one row per peer; primary key: AuthorityId + PeerId)
* AuthorityId *
* PeerId * - a single peer node identifier

Peers are added/removed via Administrator-signed inserts/deletes carrying the "Configure Authority Peers" scope — there is no inline per-record signature; the admin signature on the mutation is the authorization.

### Private, Authority-held schema

Registrant detail is split across **three content-addressed tiers**, each referenced by a hash on the `Registrant` record and all bound by the authority's `Registrant` signature (so none can be altered without detection):

| Tier | Record | Registrant ref | Disclosure |
|------|--------|----------------|-----------|
| Public | `RegistrantPublic` | `PublicCid` | Always public on the Election Network |
| Selective | `RegistrantSelective` | `SelectiveCid` | Disclosed to a permitted audience per election policy |
| Private | `RegistrantPrivate` | `PrivateCid` | Authority-held; never disclosed |

RegistrantPrivate — authority-held, not replicated to the public Election Network.
* CID * - Identifier and hashcode of this record
* RegistrantId
* Expiration
* PrivateDetails - registrant detail attributes that are never disclosed (e.g. SSN, DOB, phone)

RegistrantSelective — authority-held, committed separately from RegistrantPrivate (own CID, referenced by Registrant.SelectiveCid).
* CID * - Identifier and hashcode of this record
* RegistrantId
* Expiration
* SelectiveDetails - registrant detail attributes the authority may disclose, per election policy (e.g. to same-district neighbors, or to everyone)

`PrivateDetails` and `SelectiveDetails` are JSON arrays of attribute triples `{ name, value, hint? }`, where `value` is either a scalar (a top-level field) or a nested array of the same triples (an object), and `hint` is optional validation metadata for that scalar or whole object.

#### Selective disclosure (spec)

The **selective** tier lets an authority reveal *some* registrant detail to *some* audience without exposing the never-disclosed private fields.

- **Cardinality — one bucket per registrant (0..1).** Each registrant has at most **one** `RegistrantSelective` record, referenced by the single `Registrant.SelectiveCid` (null if none) — *not* a `RegistrantSelective` row per disclosure configuration. The "many" lives **within** the one bucket: `SelectiveDetails` holds many fields, and `ElectionDisclosurePolicy(ElectionId, FieldName, Audience)` maps each field name to an audience **per election**. So the 1:N is *bucket-fields → per-election audience policy*, not multiple buckets per registrant.
- **Commitment — separate `SelectiveCid`.** `RegistrantSelective` has its own `CID = Digest(RegistrantId, Expiration, SelectiveDetails)`, distinct from `PrivateCid`. `Registrant.SelectiveCid` references it, and the authority's `Registrant.Signature` commits to it (the signed digest binds `PrivateCid`, `PublicCid`, `SelectiveCid`, `Status`, `Expiration`). A recipient given the selective set can recompute the CID and check it against the signed `Registrant.SelectiveCid` — verifying authenticity **without** any access to `PrivateDetails`.
- **Granularity — whole-set, all-or-nothing.** The entire `SelectiveDetails` set is revealed to the permitted audience as a unit. Per-attribute selective reveal (e.g. disclose `District` but not `Address`) is **not** supported by this scheme and there is **no** per-attribute `visibility` flag; that would require per-attribute salted commitments + a Merkle root (a future option if the need arises).
- **Audience semantics — policy-driven.** *Which* selective fields are disclosed and *to whom* is configured per election in **`ElectionDisclosurePolicy(ElectionId, FieldName, Audience)`** (admin-signed under the *Manage Elections* scope), where `Audience` is a `DisclosureAudience` code — currently `district` (same-district neighbors) or `everyone`. The policy maps each selective field name to its audience; it is **not** encoded per-attribute in the registrant record.
- **Transport — off-schema.** Actually delivering/filtering the policy-selected fields to recipients is handled by the **engine/app** at query time; there is **no** on-network disclosure record. Because the selective set is committed as a whole (one `SelectiveCid`), a disclosed subset is **authority-vouched**, not independently verifiable against `SelectiveCid` (an auditor holding the full set can still cross-check consistency).
- **Verification flow.** Recipient: (1) obtain the `Registrant` record + the `SelectiveDetails` payload; (2) recompute `Digest(RegistrantId, Expiration, SelectiveDetails)` and assert it equals `Registrant.SelectiveCid`; (3) verify `Registrant.Signature` over the `Registrant` record against an authorized signor key. Tampering or substitution fails step 2 or 3.

AssociationPrivate
* RegistrationId *
* DeviceId
* Attestation
* Expiration


## In Person Voting

In-person voting using a tablet furnished by the authority, avoids disenfranchising voters with a voting system that exclusively requires every person to have a reasonably recent phone and know how to install and operate an app.  Here is the the configuration:
* The voter is put before a tablet at the polling location.  This tablet is configured to only allow the VT app.  That app is also in polling mode, which doesn't allow switching networks, and resets users after each use.
* In polling mode, the app forces re-association, so even if the user has previously associated with a device, the user begins with the association flow before starting the voting flow.  So the user looks up their registration, and scans their biometric, and, per usual, this sends the vault public key and device attestation to the authority for signing.
* The authority ignores the fact that it's a duplicate device ID, because the device ID is in a "white-list" of approved devices.
* Optionally, a hashcode of the device ID in the public device association table.  This allows the uniqueness of devices to be publicly disclosed, without disclosing the actual device ID.  That's good for transparency, but can be turned off since it can also be used to infer a person's location as a certain time.  (In the schema this is a nullable `Association.DeviceHash` — `null` means the device-uniqueness hash is not published.)

### Exclusively In-Person

VoteTorrent can be used entirely as an in-person voting system via the above.  As such a system, it still provides advantages over historically monolithic systems.  The community is provided transparency, can contribute server infrastructure, and would not be subject to various forms of mistakes and corruption at the hands of poll-workers and administrators.



## Minimal Reference Implementation workflow

Registration Workflow (from App User's Perspective)
  
  1. Open app, select network — User launches VoteTorrent, picks the election network they want to register with.
  2. Register — User taps "Register", provides required private and public identity info (name, district, etc.). The app bundles this into a registration request sent to the authority's peer cluster. The authority verifies the info (potentially out-of-band — ID check, existing voter roll lookup), then signs a Registrant record. The signed record is returned to the user and published to the Election Network.
  3. Associate device — User completes a biometric unlock (FaceID/fingerprint) to prove TPM access. The app generates a device attestation (challenge-response with the authority), and the authority signs an Association record binding the registrant to the device's public key. This record is also published to the network.
  4. Election enrollment — When an election is published, the authority (or the user, if permitted) creates an ElectionRegistrant entry linking the registrant to that election. The user sees the election appear in their ballot list.
  5. Vote — The user's device signs their ballot with the TPM-backed private key from the Association. Network nodes verify the Association and ElectionRegistrant records to confirm legitimacy.

  In-person variant (step 3 differs): At a polling location, the voter uses a whitelisted tablet (PollingDevice). The app forces re-association — the voter looks up their registration, scans biometrics, and gets a fresh Association for that tablet's key. The authority accepts duplicate device hashes for whitelisted devices.
