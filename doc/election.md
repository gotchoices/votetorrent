# Election Logic

## Election Processes

### Voters register
  * Voter receives or finds Election Network
    * Receives - could come from a QR, NFC, deep-link, or:
    * Finds - global Directory Network facilitates finding authorities and Election Networks:
      * The user's location is retrieved from the device
      * Authorities are enumerated from the Directory
        * The user's location is encoded as a [geohash](https://en.wikipedia.org/wiki/Geohash) in order to search for relevant authorities
          * A simultaneous search is done for the geohash at each level of precision
        * The list of content addresses is retrieved from the Directory, deduplicated (taking newest), and authority records are read from Authority Collection
        * The authority data in each document contains precise GeoJson geometry for each district; only those containing the user's location are kept
      * Authority records are verified based on their CA certificates
  * Voter verifies Election Network
    * An Election Network has an ID, which is included in the protocol, so every participant knows and acknowledges it.  This ID is a hash, or includes a hash, of the primary authority for that network.
    * Voter is prompted to confirm the Election Network's "code" from an external source
    * This code cannot be included in the link or QR, and must be verified out of band via a website the user must find, or in-person
    * Voter enters the code, which is a compressed hashcode of the Election Network's ID.
    * The app proceeds if there is a match.
  * Voter generates key pair:
    * Biometrics used to generate key pair in hardware vault
    * Private key never leaves device
    * Can be shown QR visualization of public key - can optionally print for easier recovery
    * Voter may be allowed to add entropy to randomness
  * Voter submits required public information - TODO: update this:  See [Registration](registration.md) for now
    * Option: submitted to authority for signature; alternative is only self-signature
    * Voter uses Matchmaking to ask for workers to transact the registration onto the Election Network
      * Matchmaking of `registration` topic is used to form a transactor squad, consisting of a critical number of workers
      * Each worker validates the registration record:
        * Signature Verification: Ensures the record was signed by the peer claiming to register, or if authority's policy dictates, by the authority itself
        * Structure and Content Validation: Checks that all required fields are present and correctly formatted
        * Optional Checks: Additional validations like checking against a blacklist or verifying resource availability
        * CRDT G-Set (Grow-only Set) is used to ensure that each worker's copy of the registration list is updated with the new registration
    * Registration is published to public registration on IPFS and transacted onto the registration Merkle tree
      * Q: How is this Merkle tree construction coordinated
    * A notification is made on a `registration` topic, which all parties who care about long-term persistence of registration (e.g. the authority) listen on
      * Any such party can pin those CIDs in IPFS to ensure long-term persistence
    * Optional: video interview including questions and presentation of documents
  * Voter submits required private information
    * Goes to authority only, who signs it and gives the voter a signature and CID (voter can also independently verify CID hash)
  * Authority could should operate at least one bootstrap / peer processing server

### Authority creates an election
  * Records created in Authority App
    * Immutable part includes revision cut-off date, timestamp authorities, core date, and title
    * Revisable part includes keyholders, timeline, and instructions
  * Signed by authority's administrators
  * Election is published:
    * Authority publishes a pub-sub topic for announcing new and modified elections
    * Election is published to the DHT
      * Q: IPFS or just a published topic on the Election Network?

### Authority invites keyholders
  * Invitation includes election record and fellow invitees, as well as an expiration date
  * Announced via pub-sub topic on Election Network, and deep-link can be sent via traditional channels (e.g. email)
  * Typically, a keyholder will not use a personal device for this duty, but rather will use a dedicated device which is then stored in a secure location
  * Using the Authority App, the keyholder accepts by:
    * Generating an election specific key pair (private key may not be held in hardware vault because it must be releasable)
    * Election private key is encrypted using biometric-backed, in-hardware registration private key - unencrypted key not persisted
    * The encrypted private key is stored on the device
    * Keyholder record is signed using the registrant's private key
    * Keyholder record is published to the Election Network

### The election is revised
  * At the end of the keyholder acceptance period, there is a keyholder revision period, during which the election is revised to include the accepted keyholder records.
  * Additional revisions may be made up to the statically stated deadline
  * Using the authority app, an administrator constructs a revision record
    * Revisions must bear independent timestamps from TSAs declared in the immutable election record - this proves that the revision occurred before the deadline
    * Creator signs it, and sends to other administrators for signature.
      * Q: How is this communicated and stored?
    * Election revision is signed by other authority's administrator(s)
  * Once fully signed, revision is published to the Election Network via a pub-sub topic, and is updated in the Election Network

### Voter votes
  * Election app checks that a vote hasn't already been submitted by the user's registrationKey
    * If it has, the app has lost it's state or the voter's private key has been compromised.  The app should load the voter record and update (and persist) it's local state.  Without the nonce, the vote record cannot be retrieved - perhaps the user is allowed to manually enter their nonce for retrieval.
  * App shows an election level combined ballot, made from district-level ballot templates
  * For each district-level ballot, app randomly generates a _vote nonce_
  * User inputs selections, with dependent questions appearing or disappearing based on user's selections
  * Review
    * User reviews their selections and can revise them before submitting
    * The user is shown the vote nonces and are allowed to copy them and add entropy to them
  * User submits vote:
    * Answers are split on a per-district basis - match ballot templates
    * The vote and voter records (including nonces) are persisted locally and held privately by voter.  Nonce allows voter to verify presence of vote in election results
    * The app displays progress (per-district)
    * App generates a _vote entry_, consisting of:
      * Answers (vote proper)
      * Vote nonce
    * App generates a _voter entry_ consisting of:
      * Public registrant key
      * Public and private registrant CIDs
      * Optional information:
        * Location
        * Device ID
        * Device attestation
      * Registrant's signature of the entry and the template's CID
    * Block negotiation begins - see Block Negotiation below

### Vote hashing
  * Immediately following voting, there is a brief accruing period during which votes may no longer be submitted, the time is allowed for transactions to settle
  * After the accruing period, the votes are hashed into a Merkle tree, which forms a single, deterministic accounting of all blocks
  * Q: How is this coordinated?
  * Q: Where is this stored and cached?

### Election unlocked
  * If any private keys held by a keyholder are released prior to the Releasing Keys portion of the election, a validation record is created by that party, capturing the private key and the timestamp, and is submitted as part of election validation
  * During the Releasing Keys portion of the election, each of the keyholders must publish his or her private election key
    * Using the Authority App, the keyholder uses biometrics to unlock the private key they hold
    * The private key is then published to the Election Network along with timestamp(s) from TSA(s)

### Election tallied
  * With all keyholders private keys released, the vote and voter records within each block are all decryptable by anyone, using the combination private keys
  * Nodes coordinate to create a tally tree, corresponding to the Merkle tree of hashes of the blocks, but including a histogram of results at each level
  * Each node of the built tree should be signed by the nodes that created it, and be timestamped by TSAs
  * Q: How is this coordinated?
  * Q: Where is this stored and cached?
  * The root entry of the Tally tree is published as the raw outcome for the election
  * Q: What happens if there are a very large number of different answers (e.g. text answers, write-ins with variations)
  * Q: How does the completion of tree formation get turned reliably into a single pub-sub notification?

### Validation
  * Each voter should, but is not required to, participate in slice level verification
  * A subset of nodes (e.g. media and election authorities) should do more comprehensive validation
  * Slice level validation includes:
    * My vote entry is in an included block and is unaltered
    * My voter entry is in the same included block, and the signature valid
    * The block is unaltered (hash matches)
    * The block is included in branches through the root of the Tally tree, and each such node is consistent
    * Problems getting connected or participating in the Election Network - even transient connection problems should be reported for statistical purposes
    * Q: Any other validation checks without more global data?
  * Comprehensive validation includes:
    * Validate every block:
      * Count of voters matches count of votes
      * Voter signatures are valid
      * Votes are valid: can be unencrypted and answers valid
    * Validate every Tally and Merkle tree node: histograms and hashes are correct
    * All records from authorities are properly signed and timed appropriately
  * Both successful and failed validations are added to a build report that is built and stored on the Election Network.  Any failed validation should include whatever proof can be given
  * The built report should suggest an error margin for the election, as well as provide other statistical information
  * Q: How is this built and stored?

### Certification
  * Based on the validation report and tally results, each ballot authority publishes a certification of the election outcome
  * Using the Authority App, a positive or negative certification record is generated and signed by the administrator(s)
  * The certification is pushed via pubsub and stored on the Election Network
  * Q: How specifically is this built and stored?

...

## Vote Block Negotiation

TODO: rename vote blocks to avoid confusion with database blocks

The apps should join the DHT networks in the background, and remain as an active node during the active election period.

Blocks are negotiated as follows, from the perspective of a given node:

### Pool Merging
* As pool coordinator, we subscribe to an election network pub-sub topic based on the template CID, a 'pooling' token, and the hash of the pool
* Similar to pairing, we start with a more specific token of the pool hash and move to a more general one, announce our presence, and try to find other pool coordinators
* `present` messages in this topic include the current pool size, and the pool coordinator's multiaddress
* `greet` messages include reciprocal size information, followed by a `merge` message
* At completion of each merge, all contributing peers are `inform`ed of the new pool size and the pool coordinator's multiaddress
  * Any nodes not acknowledging cause the merge to be reverted, with follow up `inform` messages going to all members - including information about which peer(s) did not acknowledge
  * Q: Perhaps nodes should track pool and seed revisions, and potentially drop repeat offenders.  Should this also be whispered?  Announced via pubsub?
* If pool size reaches a capacity margin, or the period is ending, the pool coordinator sends a `form` message to all contributors to announce block formation
  * This message includes a CID, representing the hash of the records portion of the block
  * All peers should check that:
    * The CID is correct
    * The records include their unaltered vote and voter records
    * There are an equal number of voter and vote records
    * Q: Should peers check for voter uniqueness, or should this be left solely to transaction validation when incorporating blocks


## Validation Process

* Note that a late block should only constitute a validation failure if it was submitted with sufficient time to complete.
* Validation anomaly records may include a premature disclosure of an election private key, signed with a TSA to prove early release.
* Election revisions match
* Keys were released, and in time
* Authorities may wish to host a number of probe transaction nodes to ensure that their notification duties (e.g. revisions, and signature release) are properly received.

## Runoff Elections

Runoff elections are a crucial mechanism to ensure fair and accurate results in cases where the initial election outcome is uncertain or contested. The following describes the generation of runoffs and the rules governing them:

1. Runoff Trigger Conditions:
   a. Discrepancy Margin: If the number of disputed votes (peers with receipt but voter and/or voter not included in the final tally) exceeds the spread between the top candidates, a runoff is assumed.
   b. Voter Accessibility Issues: If a significant portion (defined as a ratio) of voters report inability to access the voting system, a runoff is assumed. This is determined by the rules configured in the ElectionRevision record, which define a threshold of accessibility issues.  Any claim of unreachability should be verified by subsequent validators, and can be negated with evidence (presentation of voter record)
   c. Close Results: If the margin of victory is within a predefined threshold (e.g., 1% of total votes), a runoff may be automatically triggered.

2. Runoff Rules:
   a. Timing: Runoffs are scheduled at a predefined interval after the initial election, as specified in the ElectionRevision interface.
   b. Participants: Only the top two candidates from the initial election participate in the runoff, unless the election rules specify otherwise.
   c. Voter Eligibility: All voters eligible in the initial election are eligible to participate in the runoff.

3. Validation Chain:
   a. Result Hash: The validation chain must include a hash of the election results. All participants and validators must report relative to this hash to ensure consistency.
   b. Block Inclusion: The authority must provide cryptographic proof of inclusion for all received blocks in the final tally.
   c. Timestamping: External timestamping of received blocks is required to prevent retroactive exclusion.

4. Dispute Resolution:
   a. Objective Disputes: Disagreements on voter signatures, voter-to-registrant matching, or vote counts can be resolved objectively by referring to the hashed result.
   b. Subjective Issues: Voter-reported accessibility problems are tracked and, if exceeding a threshold, may trigger a runoff.

5. Anti-Manipulation Measures:
   a. Peer Validation: A diverse set of peers must validate the results to prevent coordinated false reporting.
   b. Escalation Process: Disputes that cannot be resolved through peer validation are escalated to a predefined arbitration process.

6. Transparency Requirements:
   a. Public Auditing: The authority must provide a public, auditable log of all received blocks and their inclusion in the final tally.
   b. Multiple Result Prevention: The authority is required to commit to a single result hash, preventing the publication of multiple, disagreeing results.

These rules aim to balance the need for definitive results with the importance of addressing legitimate concerns about election integrity. They provide a structured approach to handling disputes and ensuring that runoffs are triggered only when necessary to maintain the fairness and accuracy of the election process.

## Attack Vectors & Limits

* There is no way for peers to verify the claim of a missing vote record by another peer.  Even if the peer discloses their vote nonce, there is not way for other peers, without the authority's private key and without being in that voter's block pool, to verify the claim.
* Invalid voter (someone not registered) tries to participate.  May be included in blocks causing them to be rejected.
    * Mitigation: Subset of peers can consult registration list before agreeing to block - could be downloaded with election, stored on a blockchain or accessed via API
    * Mitigation: If peers receive block failure for unregistered voter that they bother to verify, could add the physical (IP address) information about such parties to the exception list in the validation phase.
* Attacker manages to negotiate into multiple blocks.  E.g. None of the original peers are around later.  Block is rejected with “duplicate voter”.
    * Mitigation: Peers can renegotiate new blocks.  This occurs during resolution phase, so there should be plenty of peers
* Melicious apps/devices
* One or more voter’s private keys are sold or stolen
* Voter may be only one remaining, may have to submit own block - the authority will know who’s vote it was.
* If time is running out on resolution and multiple block negotiations have failed, voter may have to submit singular block - this reveals their vote to the authority


## Assumptions

* Authority is responsible to ensure that only authorized voters are registered
    * In-person registration
    * Mailed cards
* Authority is responsible to ensure that the correct party holds the private key associated with voting record
