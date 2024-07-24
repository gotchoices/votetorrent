#VoteTorrent
Crowd voting protocol and reference application.

See [End-user Frequently Asked Questions](doc/user-faq.md)

## Glossary of Terms:

* Authority - the entity or system attempting to solicit a vote
* Election - declaration of a pending voting event, containing the roles to be filled, cut-off times, and associated rules
* Confirmed Election - a declaration of a ready election, including the specific candidacies.  This is candidacy definition added to the election.
* Registration - list of eligible voters, compiled by the authority and made available to stakeholders
* Stakeholders - the authority, usually the voters, and any other parties who are privy to the voter registration and vote outcome
* Outcome - the result of a given election
* DHT/Kademlia - Distributed Hash Table used to communicate and transact on a peer-to-peer basis
* Block - batch of voters and votes, with scrambled ordering so votes aren't related to voters
* Pool - set of participants who are attempting to form a block


## Requirements:

* The authority solicits the vote, candidates, and the timeframe
* The list of eligible voters could be fixed at start of election, or grow until closing
* Authority may have private information on voters, but always discloses hash of private information in public information
* The stakeholders have voter list, but only public information
* Voter can vote without the authority or public knowing for which candidate
* Voter can verify presence and correctness of vote
* Stakeholders can verify that only eligible voters voted
* Stakeholders can verify the final tally
* Within the closing time frame, the authority signs the vote in a tamper resistant manner
* Stakeholders can tell which voters voted, but not what the individual vote was
* No party should be able to vote on behalf of the voter - there may be restrictions on how far this is possible
* Results should not be visible to the authority or stakeholders until resolution opens at the end of the voting period


## Design

* Voters register with authority:
    * Voter provides a public key (private kept safe in key vault) - voter may be allowed to add entropy to randomness
        * Show visualization of physical key based on number
    * Voter submits required public and private information
    * Voter receives or otherwise knows public key of authority (authority’s ID)
    * Authority gives access information for DHT
        * These could be sought out independently (e.g. well known voting network); or
        * Authority could operate at least one relay server
        * Could be a meta-DHT that facilitates finding authorities and vote specific DHTs
    * CID (hash) on DHT is based on voter’s public key
    * Voter may join DHT to receive updates from authority, or may participate from notifications
* Authority issues election:
    * Includes public key, authority signature, description, question list, deadlines, rules
* Authority issues election: 
    * Includes public key, election signature, candidate list, URL(s), time frames, and voter roll (including public keys for each voter) if registration is fixed
    * Authority signs election digest
        * Pushes onto the DHT; or
        * Makes available in API
        * …sends in notification
* Voter votes:
    * Voter randomly generates a _vote nonce_, which is held privately by voter to verify presence of vote in election results
    * Voter generates a _vote entry_, consisting of (before encryption using election’s public key):
        * Answers (vote proper)
        * Vote nonce
    * Voter generates some small number of dummy vote entries, containing no answers and a blank nonce
    * Voter generates a _voter entry_ consisting of (before encryption using election's public key):
        * Public registration identity (including public key)
        * Signed election, signed again using voter’s public key
        * Additional information:
            * Location
            * Biometric key
            * Device ID
            * App Identifier
    * Block negotiation - nature of a Kademlia DHT is that neighbors depend on timing; peers congregate naturally with other similarly timed voters; neighborhood contracts to scale to heavy volumes:
        * Using CID this voter joins the DHT
        * Voter negotiates with a pool of peers to form a vote block, through a block coordinator (see Block Negotiation), containing:
            * Randomly ordered list of voter entries
            * Randomly ordered list of vote entries
        * The coordinator scrambles the order of vote and voter lists as it is built, to minimize peers who know which vote entry goes with which voter entry
* Polling resolution opens:
    * Block members send vote blocks to authority
        * Any and all block members can send to the authority (with randomized time delay)
        * Authority responds with a receipt, which is distributed back to block members
        * If block contains any voters who have already voted:
          * Entire block is rejected (failure receipt)
          * Authority receipt includes list of duplicates - these are whispered to peers
          * Members retry with same coordinator (if not excluded) and peers (excluding duplicating peer(s))
        * If block contains an unequal number of voters and real votes:
          * Entire block is rejected (failure receipt)
          * Authority receipt includes list of real vote indexes - coordinator whispers the offending (inclusion of other than 1 vote / voter) peer to peers
          * Members retry with a fresh set of peers (excluding culprits)
    * Authority unencrypts the voter and vote lists from each block and appends them to the final tally in further scrambled order
* Polling closes:
    * Final election result contains: list of voters (public info + signature of election); list of votes (votes and identifiers)
    * Voters and votes are sorted by voter key and vote nonce respectively
    * Within closing time frame, authority signs the election result digest
    * Authority get's one or more time authority signatures
* Peer validation process: 
    * Signed results sent out to DHT; participating peers verify:
        * Results were published in time
        * My vote was included
        * My voter was included and the signature valid
        * Count of voters matches count of votes
    * Failed verifications could add
        * Receipt given
        * Evidence of other peers not succeeding
    * Validation request broadcast peer-to-peer
    * Blockchain containing validations/exceptions generated for the election
    * If this phase is used, validation can be used to bring the spread within the error margin

## Block Negotiation

The voting app should join the DHT in the background, and remain as an active node while the user is voting or otherwise utilizing the app.  This improves the ratio of DHT participants who are officiating independently in block formation and makes the DHT more stable.

Blocks are negotiated as follows, from the perspective of a given node:

* When the node is ready to vote, it sends a `Pool Inquiry` message to nearby peers containing:
  * Voter CID
  * Election ID
  * Expiration? - if included, this should be treated as relative and time sync should be tracked to peers
* The node waits for at least a few peers to respond for up to a certain timeout period (adding some randomization).
* The peers will either:
  * Note your inquiry and return no knowledge of a pool forming; or,
  * Return information on known pools
* Peer responses should include a blacklist of CIDs with mis/mal behavior - a single-source shouldn't be considered definitive for blacklisting
* If known pools are returned:
  * Potential pools are filtered based on the blacklist, matching election, and other requirements, then prioritized based on a score derived from:
    * Expiration
    * Member count vs. capacity
    * Proximity
  * Starting from the highest priority, the node attempts to join a pool:
    * A `Join Pool` request message is sent to the pool coordinator.
    * If a `Confirm Join` response is received back, including a nonce, an updated descriptor of the pool, and a time-sync:
      * Update and validate descriptor - doesn't exceed acceptable number members or expiration (accounting for time-sync)
      * Update internal record of pending pool
      * Respond with a `Confirmed` message if validation passes, or `Cancel` message otherwise
    * If a `Failed` response is received, or a timeout is reached, advances to the next step
  * If all joins failed or were filtered out:
    * If significant time has elapsed, go back to `Pool Inquiry` and try again
    * If little time has elapsed, behave as though no pools were returned
* If no known pools are returned, initiate a pool:
  * Generate a pool header, including:
    * ID
    * Expiration
    * Max capacity
    * Node's address as coordinator
  * Advertise the node's forming pool:
    * Send `Pool Forming` to N~n~ (number of peers in the negative direction), N~p~ (number in positive direction) peers
    * At sub-intervals of the total expiration period, increase N~n~ and N~p~ and message to the delta peers
    * If a peer replies that one or more other pools are already forming:
      * Stop expanding in that direction
      * If nearing expiration and small number in pool:
        * Send a `Pool Inquiry` message to competing pool coordinators for updated pool status to see if merging makes sense
        * Merge into another pool if:
          * There is time remaining in both pools for this node's pool members to switch over
          * Combined member count from both pools is well below other pools limit
          * Other pool has significantly more members
        * If merging:
          *  Send a `Pool Redirect` message to this node's pool members, indicating that this pool is closed and the rank ordered other pools to try
          *  Send a `Pool Redirect` message to all peers who were previously notified of this pool's formation
          *  Attempt to join other pool, starting with highest ranked
  * While within the capacity limit and expiration period:
    * If a `Join Pool` request is received:
      * If valid (CID not on black-list):
        * Respond with `Confirming` message containing a nonce; this confirms that the joining member can actually be reached at the advertised address
        * If `Confirmed` message received within timeout period:
          * CID and physical address added to pool
          * Updated pool whispered to peers
        * If timeout or `Cancel` received, whisper warning message to peers about the CID - too many warnings, CID goes on blacklist
      * Otherwise, if invalid:
        * Respond with `Reject`
        * Whisper a warning - too many warnings, CID goes on blacklist
  * If capacity or expiration reached
    * If no nodes have joined, go back to `Pool Inquiry` and retry, or if the resolution phase is nearly elapsed, self-complete the block and submit it
    * If other nodes have joined:
      * Form a Proposed Block:
        * ID (carry forward the pool ID)
        * Member CIDs [include ?]
        * Expiration
      * Populate the block:
        * Send `Block Populate` message to each member
        * Receive `Block Entry` response messages from members, including vote and voter entries
        * At expiration, or receipt of all responses, sign the block:
          * Scramble vote and voter entries independently
          * Form a Signing Block:
            * ID (carried forward)
            * Included Member CIDs - members from whom we received entries
            * Scrambled aggregate vote and voter entries
            * Expiration (new)
          * Send `Block Sign` message to each member (including those we didn't receive entries from)
          * Receive `Block Signature` responses messages from included members, containing independent signatures on the Signing Block's digest
          * If all signatures are received in time:
            * Send `Block Complete` message to each member (included or not)
            * Whisper `Block Complete` to peers
            * Attempt to post block is scheduled for randomized time early in resolution phase
        * Expired and no entries received:
          * Send and whisper `Block Abandon` to members and peers
          * Go back to `Pool Inquiry` state and retry

## Attack Vectors & Limits

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


## Components

* Authority Frontend - Web application
    * Home page & static content
    * Registrations list - self serve
    * Administer registration
    * Administer election
    * Administer confirmed election
    * Elections
        * Status - current and archive
            * Phase - registration - registrations
            * Phase - voting - registrations
            * Phase - resolution - tally and registrations
            * Phase - validation - stats and exceptions
* Authority Backend - Nodejs serverless
    * APIs - each returning time information:
        * Post registrant
        * Get registrant - public
        * Post election
        * Get elections(s)
        * Promote election to confirmed
        * Get confirmed status
        * Get confirmed results
        * Post block
    * Database
* Device Frontend - React native?
    * Entry
        * Registration deep link
        * Election deep link
        * General introduction
    * Register
        * Enter required demographics
        * Optional: Capture picture
        * Generate key
            * Optional: Enter entropy
            * Stored in OS vault
        * Submit registration
            * Failure: report
            * Success: Store information from authority
    * Authorities
        * Get from local list
    * Authority
        * Show elections from authority
    * Election
        * Display terms, timetables, etc.
        * Show whether signature is valid
        * Vote:
            * Show voting content markdown
            * Embed candidates / questions
            * Ability to pull up details on each, pulled from embedded content or from authority
        * Submit to peers:
            * Show status - connecting, negotiating, block ready
        * See results
            * Show my validation
            * Show community validation
    * Background service
* Device Backend - Ecmascript module
    * Local database
    * Add registration (authority)
    * Update elections (& check time sync)
    * Get election
        * Validate
    * Prepare vote and voter entries
    * Voting state machine - DHT
        * Connecting
        * Finding peers
        * Negotiating
        * Block ready
        * Submitting
        * Submitted
        * Validating
        * Validated
        * Failed
    * Get election results
    * Get validation info


## Architecture Notes:

* Standard JSON format for all major objects
* Validations are Javascript snippets, scoped to relevant object
* Markdown for content embeddings


## Notes:

* App should not use complex UX idioms.  Most should read as left to right text


## Future work:

* Allow authority to be a separate blockchain
* Separate voter roles from authority
