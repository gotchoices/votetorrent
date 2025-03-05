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
