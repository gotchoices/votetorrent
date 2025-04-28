# Voting Administration Subsystem

This document outlines the administration subsystem for the VoteTorrent platform, including key structures, relationships, and operational workflows.

## Core Structures

### Authority
The Authority represents an organization that can create and manage elections.

| Field | Description |
|-------|-------------|
| SID | Content ID (CID) of the initial administration. This serves as the unique identifier for the Authority. |
| Name | Human-readable name of the Authority. |
| ImageURL/CID | URL or Content ID pointing to the Authority's logo or image. |
| Domain Name | The domain associated with the Authority. |
| Signatures | Array of Signature objects validating the Authority. |

### Administration
The Administration represents the current administrative state of an Authority.

| Field | Description |
|-------|-------------|
| CID | Content ID (hash) that uniquely identifies this Administration. |
| AuthoritySID | Reference to the Authority this Administration belongs to (same as CID for initial administration). |
| Administrators[] | Array of Administrator objects who have administrative privileges. |
| Expiration | Timestamp when this Administration expires and must be renewed. |
| Signatures | Array of Signature objects validating this Administration. |

### Administrator
Administrators are individuals with specific privileges within an Administration.

| Field | Description |
|-------|-------------|
| CID | Content ID uniquely identifying this Administrator. |
| Key | Public key used to verify the Administrator's signatures. |
| Name | Human-readable name of the Administrator. |
| Title | Official title or role of the Administrator. |
| Scopes[] | Array of privilege scopes granted to this Administrator. |
| ImageUrl/CID | URL or Content ID pointing to the Administrator's photo or avatar. |
| Signatures | Array of Signature objects validating this Administrator. |
| InvitationCID | CID of the invitation that led to this Administrator's creation (if applicable). |

### AuthorityPeer
Represents peer nodes that can act on behalf of an Authority for certain automated operations.

| Field | Description |
|-------|-------------|
| AuthoritySID | Reference to the Authority this peer belongs to. |
| PeersIDs | List of peer node identifiers that can act for this Authority. |
| Signatures | Array of Signature objects validating this peer relationship. |

### Signature
Represents a cryptographic signature validating a record.

| Field | Description |
|-------|-------------|
| AdministratorCID | CID of the Administrator who created this signature. |
| Timestamp | When the signature was created. |
| Value | The cryptographic signature value. |

### Invitation
Represents a public record of an invitation for a new Administrator or Authority.

| Field | Description |
|-------|-------------|
| CID | Content ID uniquely identifying this Invitation. |
| Type | "Administrator" or "Authority" - indicates the type of invitation. |
| AuthoritySID | SID of the Authority issuing the invitation. |
| TargetPublicKeyHash | Optional hash of the target's public key if known in advance. |
| InvitationNonce | Random value used to prevent correlation of invitations with their acceptances. |
| PublicInviteToken | Public verification token used to validate the invitation acceptance. |
| ProposedScopes[] | Array of privilege scopes proposed for the new Administrator or Authority. |
| ProposedName | Suggested name for the new Administrator or Authority. |
| ProposedDomain | For Authority invitations: suggested domain for the new Authority. |
| Expiration | Timestamp when this invitation expires. |
| Signatures | Array of Signature objects from Administrators with appropriate invitation scopes. |
| UsedBy | CID of the entity that used this invitation (only populated after use). |

### AdministratorAcceptance
Represents an Administrator's acceptance of an invitation.

| Field | Description |
|-------|-------------|
| CID | Content ID uniquely identifying this acceptance. |
| InvitationCID | CID of the invitation being accepted. |
| AdministratorKey | Public key of the new Administrator. |
| AdministratorName | Name of the new Administrator. |
| AdministratorTitle | Title of the new Administrator. |
| AcceptedScopes[] | Array of scopes the Administrator is accepting. |
| ImageUrl/CID | URL or Content ID pointing to the Administrator's photo or avatar. |
| ProofOfPossession | Cryptographic proof that the acceptor possessed the private invitation token. |
| Signature | Signature from the new Administrator's private key, confirming acceptance of the scopes and role. |

### AuthorityAcceptance
Represents the acceptance of an invitation to form a new Authority.

| Field | Description |
|-------|-------------|
| CID | Content ID uniquely identifying this acceptance. |
| InvitationCID | CID of the invitation being accepted. |
| AuthorityName | Name of the new Authority. |
| DomainName | Domain name of the new Authority. |
| InitialAdministratorKey | Public key of the initial Administrator. |
| InitialAdministratorName | Name of the initial Administrator. |
| InitialAdministratorTitle | Title of the initial Administrator. |
| InitialAdministratorScopes[] | Array of scopes for the initial Administrator. |
| ProofOfPossession | Cryptographic proof that the acceptor possessed the private invitation token. |
| Signature | Signature from the initial Administrator's private key. |

## Operational Model

### Network Foundation
- The voting network uses a P2P Kademlia distributed hash table (DHT) architecture.
- The primary Authority's SID (the CID of its initial administration) is encoded directly into the protocol.
- This establishes the root of trust for the entire network.

### Administrative Actions
- All actions performed by an Administration require signatures from the relevant Administrators.
- Each Administrator has a set of scopes (claims), representing individual privileges.
- Network or Authority policy establishes how many applicable Administrator signatures are required for each scope.
- Signatures are compound structures, composed of the appropriate claims and the required number of signatures.

### Authority Relationships
- The primary Authority invites other Authorities to join the network.
- This creates a hierarchical trust model while maintaining decentralized operations.

### Administrative Powers
With signatures from Administrators possessing the appropriate scopes, an Administration can:
- Revise or replace the Administration
- Validate registrations
- Invite other Authorities
- Revise network policies
- Update Authority information
- Create/edit ballot templates
- Manage Elections
- Configure Authority Peers
- And other administrative functions

### Administration Lifecycle
- Administrators must hand off or revise the Administration before it expires.
- If not updated before expiration, the primary Authority must replace the Administration.
- If the primary Authority fails to replace its Administration before expiration, the network loses legitimacy and a new network must be formed.

### Security Model
- All related records have signatures to legitimize them, from the appropriate Administrators.
- Administrators are always people, and their signatures come from hardware security modules (HSMs) or secure enclaves in their devices.
- Some operations, such as approving device Associations for Registrants, may be automated.
- Automated operations can be signed by one of the Authority's peers (using the private key associated with the PeerID's public key).

## Invitation Workflows

The invitation system enables secure onboarding of new Administrators and Authorities while maintaining the chain of trust throughout the network.

### Public vs. Private Data

The VoteTorrent system maintains a clear separation between:

1. **Public Network Data**: Structures stored on the public voting network that can be validated cryptographically by any participant.
2. **Private Authority Data**: Information held privately by Authorities and never published to the network.
3. **Out-of-Band Communication**: Information transmitted directly to invitees through secure channels.

All validation is performed cryptographically using the public structures, without requiring access to private data.

### Administrator Invitation Workflow

This workflow is used to add a new Administrator to an existing Administration.

1. **Invitation Creation**:
   - Administrators with the "InviteAdministrator" scope authorize the creation of an invitation.
   - A `PublicInviteToken` and corresponding `PrivateInviteToken` are generated.
   - An `Invitation` record with Type="Administrator" is created and published to the network.
   - The `PrivateInviteToken` is delivered to the invitee through a secure out-of-band channel.

2. **Invitation Acceptance**:
   - The invitee receives the `PrivateInviteToken` through the out-of-band channel.
   - The invitee generates a new key pair in their hardware security module.
   - The invitee creates an `AdministratorAcceptance` record containing:
     - Their public key
     - Personal information (name, title, etc.)
     - The scopes they are accepting
     - A reference to the `Invitation` CID
     - A cryptographic proof derived from the `PrivateInviteToken`
     - Their signature confirming acceptance of the role and scopes

3. **Record Validation**:
   - Network validators verify:
     - The `Invitation` exists and hasn't expired
     - The invitation has valid signatures from Administrators with the "InviteAdministrator" scope
     - The cryptographic proof is valid against the `PublicInviteToken`
     - The invitee's signature is valid
     - The accepted scopes are a subset of the proposed scopes

4. **Administration Update**:
   - The Authority's Administration is updated to include the new Administrator.
   - This update requires signatures from Administrators with the "UpdateAdministration" scope.
   - The `Invitation` record is updated with the `UsedBy` field pointing to the new Administrator's CID.

### Authority Invitation Workflow

This workflow is used by the primary Authority to invite the formation of a new Authority.

1. **Invitation Creation**:
   - Administrators from the primary Authority with the "InviteAuthority" scope authorize the creation of an invitation.
   - A `PublicInviteToken` and corresponding `PrivateInviteToken` are generated.
   - An `Invitation` record with Type="Authority" is created and published to the network.
   - The `PrivateInviteToken` is delivered to the invitee through a secure out-of-band channel.

2. **Authority Formation**:
   - The invitee receives the `PrivateInviteToken` through the out-of-band channel.
   - The invitee generates a new key pair for the initial Administrator.
   - The invitee creates an `AuthorityAcceptance` record containing:
     - Authority information (name, domain)
     - Initial Administrator information (key, name, title, scopes)
     - A reference to the `Invitation` CID
     - A cryptographic proof derived from the `PrivateInviteToken`
     - The initial Administrator's signature

3. **Record Validation**:
   - Network validators verify:
     - The `Invitation` exists and hasn't expired
     - The invitation has valid signatures from Administrators with the "InviteAuthority" scope
     - The cryptographic proof is valid against the `PublicInviteToken`
     - The initial Administrator's signature is valid

4. **Authority Creation**:
   - Upon validation, the following records are created:
     - A new `Authority` record
     - An initial `Administration` record
     - The initial `Administrator` record
   - The `Invitation` record is updated with the `UsedBy` field pointing to the new Authority's SID.

5. **Authority Bootstrapping**:
   - The new Authority can now create its own `Invitation` records to build out its Administration.
   - The new Authority inherits network privileges based on the primary Authority's policies.

### Administration Renewal Workflow

This workflow is used to renew an Administration before it expires.

1. **New Administration Creation**:
   - Administrators with the "UpdateAdministration" scope create a new `Administration` record.
   - This record may include changes to the Administrator list or their scopes.
   - The record includes signatures from the required number of Administrators.

2. **Record Validation**:
   - Network validators verify:
     - The signatures are from valid Administrators with the "UpdateAdministration" scope
     - The required threshold of signatures is met
     - The previous Administration has not expired

3. **Administration Transition**:
   - The new Administration becomes the active one for the Authority.
   - All future actions will require signatures from Administrators in the new Administration.

### Cryptographic Relationships

```
// Relationship between tokens
PublicInviteToken = Hash(PrivateInviteToken + Salt)

// Proof of possession (simplified)
ProofOfPossession = Sign(Hash(PrivateInviteToken + InvitationCID), AcceptorPrivateKey)

// Administrator acceptance signature (simplified)
AcceptanceSignature = Sign(Hash(AcceptanceRecord), AcceptorPrivateKey)

// Signature structure (simplified)
Signature = {
  AdministratorCID: "CID of signing Administrator",
  Timestamp: 1634567890,
  Value: Sign(RecordHash, AdministratorPrivateKey)
}
```

All validation is performed using public network structures, with private data never exposed on the network.

