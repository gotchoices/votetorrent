#VoteTorrent
Crowd voting protocol and reference application.

## Glossary of Terms:

* Authority - the entity or system attempting to solicit a vote
* Solicitation - declaration of a pending voting event, containing the roles to be filled and deadlines
* Election - a declaration of a voting event, including the candidacy, cut-off times, and associated rules
* Registration - list of eligible voters, compiled by the authority and made available to stakeholders
* Stakeholders - the authority, usually the voters, and any other parties who are privy to the voter registration and vote outcome
* Outcome - the result of a given election
* DHT/Kademlia - Distributed Hash Table used to communicate and transact on a peer-to-peer basis


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
* Authority issues solicitation:
    * Includes public key, authority signature, description, slot list, deadlines, rules
* Authority issues election: 
    * Includes public key, solicitation signature, candidate list, URL(s), time frames, and voter roll (including public keys for each voter) if registration is fixed
    * Authority signs election digest
        * Pushes onto the DHT; or
        * Makes available in API
        * …sends in notification
* Voter votes:
    * Voter randomly generates a _vote identifier_, which is held privately by voter to verify presence of vote in solicitation results
    * Voter generates a _vote entry_, consisting of (before encryption using solicitation’s public key):
        * Selection choice (vote proper)
        * Vote identifier
    * Voter generates a _voter entry_ consisting of (before encryption using solicitation’s public key):
        * Public registration identity (including public key)
        * Signed solicitation, signed again using voter’s public key
        * Additional information:
            * Location
            * Biometric key
            * Device ID
            * App Identifier
    * Block negotiation - nature of a Kademlia DHT is that neighbors depend on timing; peers congregate naturally with other similarly timed voters; neighborhood contracts to scale to heavy volumes:
        * Using CID this voter joins the DHT
        * Voter negotiates with a pool of peers to form a vote block, containing:
            * Randomly ordered list of voter entries
            * Randomly ordered list of vote entries
        * Peers whisper about who has already been negotiated into a block - prevents peer from being included in multiple blocks
        * Negotiation scrambles the order of vote and voter lists as it is built, to minimize peers who know which vote entry goes with which voter entry
* Polling resolution opens:
    * Pools (block participants) send vote blocks to authority
        * Any and all pool members can send to the authority (with randomized time delay)
        * Authority responds with a receipt, which is distributed back to pool members
        * If block contains any voters who have already voted, the entire block is rejected and members should retry with a fresh set of peers (with duplicate whispered to peers)
    * Authority unencrypts the voter and vote lists from each block and appends them to the final tally in further scrambled order
* Polling closes:
    * Final solicitation result contains: list of voters (public info + signature of solicitation); list of votes (votes and identifiers)
    * Voters and votes are sorted by voter ID and vote identifier respectively
    * Within closing time frame, authority signs the solicitation result digest
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
    * Blockchain containing validations/exceptions generated for the solicitation
    * If this phase is used, validation can be used to bring the spread within the error margin


## Attack Vectors & Limits

* Invalid voter (someone not registered) tries to participate.  May be included in blocks causing them to be rejected.
    * Mitigation: Subset of peers can consult registration list before agreeing to block - could be downloaded with solicitation, stored on a blockchain or accessed via API
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
    * Administer solicitation
    * Solicitations
        * Status - current and archive
            * Phase - registration - registrations
            * Phase - voting - registrations
            * Phase - resolution - tally and registrations
            * Phase - validation - stats and exceptions
* Authority Backend - Nodejs serverless
    * APIs - each returning time information:
        * Post registrant
        * Get registrant - public
        * Post solicitation
        * Get solicitation(s)
        * Get solicitation status
        * Get solicitation results
        * Post block
    * Database
* Device Frontend - React native?
    * Entry
        * Registration deep link
        * Solicitation deep link
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
        * Show solicitations from authority
    * Solicitation
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
    * Update solicitations (& check time sync)
    * Get solicitation
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
    * Get solicitation results
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