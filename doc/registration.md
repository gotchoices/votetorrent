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

AuthorityPeers
* AuthorityId *
* PeerIds - list of PeerIds
* Signature - Signature from the authority's ID administration

### Private, Authority-held schema

RegistrantPrivate
* CID * - Identifier and hashcode of this record
* RegistrantId
* Expiration
* [SSN]
* [Phone]
* [DOB]
* ...

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
* Optionally, a hashcode of the device ID in the public device association table.  This allows the uniqueness of devices to be publicly disclosed, without disclosing the actual device ID.  That's good for transparency, but can be turned off since it can also be used to infer a person's location as a certain time.

### Exclusively In-Person

VoteTorrent can be used entirely as an in-person voting system via the above.  As such a system, it still provides advantages over historically monolithic systems.  The community is provided transparency, can contribute server infrastructure, and would not be subject to various forms of mistakes and corruption at the hands of poll-workers and administrators.
