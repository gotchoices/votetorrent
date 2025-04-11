# Administrator Invitations

## Overview
Vote Torrent uses a simple, robust cryptographic method for invitations issued by an Authority via an Administrator in a decentralized system, satisfying the following requirements:

- The invitation flows securely from Authority to Invitee via an Administrator, privately and out-of-band.
- The Invitee publicly proves possession of the Authority-issued invitation without enabling interception or reuse by attackers.
- The Invitee's public identity is intrinsically bound to the invitation.

## Cryptographic Approach

### Core Idea
The Authority generates a unique public/private key pair for each invitation "slot". The public key is published openly, and the private key is securely transmitted out-of-band to the Invitee. The Invitee publicly demonstrates possession by signing a claim with:

- Their own private key.
- The invitation's private key.

Observers validate the claim using the published public key from the invitation slot, thus intrinsically tying the Invitee’s identity to the invitation.

## Step-by-Step Procedure

### Step 1: Authority Issues Invitation
- Authority generates an invitation-specific key pair:
```typescript
import { generateKeyPair } from '@libp2p/crypto/keys'

const inviteKeyPair = await generateKeyPair('Ed25519');
const publicKeyBytes = inviteKeyPair.public.bytes;
const privateKeyBytes = inviteKeyPair.private.bytes;
```

- Authority publicly publishes `publicKeyBytes` in an "invitation slot" on a public registry:
```typescript
const inviteSlot = {
  slotId: 'invite-slot-123',
  publicKey: publicKeyBytes,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 86400000 // valid for 24 hours
};
// publish inviteSlot publicly
```

- Authority privately sends `privateKeyBytes` securely (email, QR, etc.) to the Invitee.

### Step 2: Invitee Generates Identity and Claims Invitation
- Invitee generates their cryptographic identity if not already available:
```typescript
const inviteeKeyPair = await generateKeyPair('Ed25519');
```

- Invitee creates a public claim, signing with both their identity key and the invitation's private key:
```typescript
const claimPayload = {
  inviteSlotId: 'invite-slot-123',
  inviteePublicKey: inviteeKeyPair.public.bytes,
  timestamp: Date.now()
};

// Sign with Invitee's own key
const inviteeSignature = await inviteeKeyPair.private.sign(new TextEncoder().encode(JSON.stringify(claimPayload)));

// Sign with Invitation's private key
const invitationPrivateKey = await importPrivateKey(privateKeyBytes);
const invitationSignature = await invitationPrivateKey.sign(new TextEncoder().encode(JSON.stringify(claimPayload)));

const publicClaim = {
  claimPayload,
  inviteeSignature,
  invitationSignature
};

// Publish publicly
```

### Step 3: Observers Validate Public Claim
- Observers retrieve the invitation slot’s public key from the public registry and validate:
```typescript
// Retrieve publicKeyBytes from invite slot
const invitationPublicKey = await importPublicKey(publicKeyBytes);

// Verify Invitation Signature
const isInviteValid = await invitationPublicKey.verify(
  new TextEncoder().encode(JSON.stringify(publicClaim.claimPayload)),
  publicClaim.invitationSignature
);

// Verify Invitee Signature
const inviteePublicKey = await importPublicKey(publicClaim.claimPayload.inviteePublicKey);
const isInviteeValid = await inviteePublicKey.verify(
  new TextEncoder().encode(JSON.stringify(publicClaim.claimPayload)),
  publicClaim.inviteeSignature
);

if (isInviteValid && isInviteeValid) {
  // Invite is legitimate and bound to the invitee
} else {
  // Reject claim
}
```

### Step 4: Prevent Reuse
- Once the public claim is validated and recorded, any subsequent claims using the same invitation public key are invalidated.
