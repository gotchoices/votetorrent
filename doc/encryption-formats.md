# VoteTorrent encryption wire formats

Phase 62 Plan 04 (D-03, D-04, D-13, D-18, D-25). This is the normative
specification for `packages/vote-engine/src/crypto/`: the per-officer
multi-recipient envelope (`vt-env-1`), the DKG-joint-key block-content
cipher (`vt-block-1`), and the `IKeyVault` storage contract. The
implementation in `src/crypto/*.ts` must match this document exactly; a
mismatch discovered during the Plan 04 Task 3 security review is a bug and
is fixed in whichever side is wrong (code or spec), never silently
reconciled by relaxing a test.

Every construction here is built only from `@noble/curves`, `@noble/hashes`
and `@noble/ciphers` 2.2.0 (D-25) — no hand-rolled curve, KDF or cipher math.

## 1. Conventions

These apply to every format below.

- **Public keys** are 66-character lowercase hex: a compressed secp256k1
  point, prefix `02` or `03`, per [SEC 1 v2.0] section 2.3.3 ("Elliptic
  Curve Point to Octet String Conversion") and [SEC 2 v2.0]'s curve
  parameters.
- **Secret keys** are raw 32-byte `Uint8Array`. A secret key is never a
  string on any path in this module.
- **Nonces, tags and ciphertexts** are unpadded base64url (RFC 4648 section
  5, no `=` padding).
- **AAD and other multi-field byte strings** use a length-prefixed
  encoding: for each field, in order, a 4-byte big-endian uint32 byte
  length, then the field's UTF-8 bytes. The first field is always the
  domain label (`vt-env-1/content`, `vt-env-1/wrap`, or `vt-block-1/content`
  below) — this is what makes a content AAD structurally unable to collide
  with a wrap AAD, independent of what any later field happens to contain.
- **ECDH input keying material (IKM)** is the 32-byte x-coordinate of the
  shared point: [SEC 1 v2.0] section 3.3.1 ("Elliptic Curve Diffie-Hellman
  Primitive"). `getSharedSecret(sk, pub, true)` returns 33 compressed
  bytes; byte 0 is the y-parity prefix, bytes 1..32 are the x-coordinate.
  This deliberately differs from a raw 33-byte shared-secret convention
  sometimes seen in research notes — it is what matches OpenSSL's
  `createECDH('secp256k1').computeSecret(pub)` and the standard.

## 2. The `vt-env-1` multi-recipient envelope (D-03, D-04)

A staged registration or association payload (the `InitJson` column) is
sealed once under a random content key (CK), and CK is wrapped once per
current officer's secp256k1 encryption key (`UserEncryptionKey.Alg =
'secp256k1-ecdh-hkdf-sha256-aes256gcm'`). Every strand peer, including
non-officer voters, sees only ciphertext.

### 2.1 Seal

**Content:**

1. `CK` = 32 random bytes. `nonce` = 12 random bytes.
2. `(Kenc || kc) = HKDF-SHA256(IKM=CK, salt=zero-length, info=UTF-8
   "vt-env-1/content", L=64)`, per [RFC 5869]. `Kenc` is bytes 0..31; `kc`
   (the key-commitment tag) is bytes 32..63.
3. `ct = AES-256-GCM(Kenc, nonce, plaintext, AAD = lp["vt-env-1/content",
   requestId, digest])`, per [NIST SP 800-38D]. `lp[...]` is the
   length-prefixed encoding from section 1.

**Per recipient i** (for every `{userId, publicKey}` in the caller's
recipient list):

1. A fresh ephemeral scalar `e_i` and `E_i = compressed(G * e_i)`.
2. `Z_i = x(e_i * R_i)` where `R_i` is recipient i's public key point —
   the section 1 ECDH convention.
3. `KEK_i = HKDF-SHA256(IKM=Z_i, salt=E_i || R_i (66 raw bytes), info=UTF-8
   "vt-env-1/wrap", L=32)`.
4. `wrap_i = AES-256-GCM(KEK_i, nonce_i, CK, AAD = lp["vt-env-1/wrap",
   userId, pubHex, ephHex, requestId, digest])` — 48 bytes (32-byte
   plaintext + 16-byte GCM tag).

**Wire object** (`SealedEnvelope`), member order fixed:

```json
{
  "v": 1,
  "alg": "vt-env-1",
  "nonce": "<base64url, 12 bytes>",
  "kc": "<base64url, 32 bytes>",
  "ct": "<base64url, >= 16 bytes>",
  "recipients": [
    { "userId": "...", "pub": "<66-char hex>", "eph": "<66-char hex>", "nonce": "<base64url, 12 bytes>", "wrap": "<base64url, 48 bytes>" }
  ]
}
```

### 2.2 Open

`openEnvelope` never throws. The check order is normative:

1. **Local arguments** — `secretKey` a valid 32-byte scalar, `userId`
   non-empty, `binding.requestId`/`binding.digest` non-empty strings.
   Failure reason: `'invalid-argument'`.
2. **Structural validation** — parse a string input as JSON inside a
   `try`; check every top-level member's type, `recipients` length in
   1..64, no duplicate `userId` within the list, and every `pub`/`eph`
   decodes to a valid on-curve compressed point. Any failure:
   `'malformed-envelope'`.
3. **Version/alg check** — `v === 1 && alg === 'vt-env-1'`, run BEFORE any
   decryption is attempted. Otherwise: `'unsupported-version'`.
4. **Decode fixed-length top-level fields** — `nonce` (12 bytes), `kc` (32
   bytes), `ct` (>= 16 bytes). Any failure: `'malformed-envelope'`.
5. **Select the caller's entry** — the recipient whose `userId` equals the
   caller's AND whose `pub` equals `encryptionPublicKeyFromSecret(secretKey)`.
   If none matches: `'not-a-recipient'`. The recipient list is public (it
   is what everyone on the strand already sees), so this lookup is not an
   oracle.
6. **ECDH + KEK + unwrap** — `Z = x(secretKey * eph)`, `KEK = HKDF(...)` as
   in 2.1 step 3, `CK = AES-256-GCM-decrypt(KEK, wrapNonce, wrap, wrapAAD)`.
7. **Derive and compare `kc`** — `(Kenc || kc') = HKDF(CK, ...)` as in 2.1
   step 2; compare `kc'` to the envelope's `kc` with `equalBytes` (constant
   time).
8. **Decrypt content** — `plaintext = AES-256-GCM-decrypt(Kenc, nonce, ct,
   contentAAD)`.

Steps 6-8 run inside **one** `try`/`catch`. Every failure inside that block
— wrong key, tampered `wrap`, tampered `ct`, tampered `nonce`, a `kc`
mismatch, or a transplanted `requestId`/`digest` — collapses to the exact
same reason: `'authentication-failed'`. The caught error's message is
discarded. A `detail` string anywhere in this module names structure only
(a member name, an observed byte length) and never a byte of key,
ciphertext or plaintext.

### 2.3 Why key commitment (the `kc` tag)

Plain AES-GCM is not key-committing: [USENIX-ABUSE] ("How to Abuse and Fix
Authenticated Encryption Without Key Commitment", Albertini, Duong, Gueron,
Kölbl, Luykx, Schmieg, USENIX Security 2022) shows that for suitably crafted
inputs, a single ciphertext can decrypt to two *different* plaintexts under
two different keys, both producing a valid GCM tag. In this envelope's
threat model that means a malicious requester could, in principle, craft a
payload where officer A and officer B — each decrypting with their own
correct secret key via their own correct wrap — would read different
plaintexts, with neither able to detect the discrepancy from their own
decryption succeeding.

`kc` closes that gap: it is a tag derived from the *single* content key CK,
independent of any recipient's key material, and every recipient's open
path checks it before trusting the decrypted content. Because `kc` is
bound only to CK (not to any one recipient), all recipients either agree on
`kc` or none of them do — there is no way to craft an envelope whose `kc`
passes for one recipient and silently fails for another while both still
"successfully" decrypt.

### 2.4 Relationship to RFC 9180 (HPKE) — explicitly NOT a claim of conformance

[RFC 9180] sections 4 and 5 describe HPKE's KEM/KDF/AEAD composition
pattern, and this envelope's per-recipient ECDH-then-HKDF-then-AEAD shape
is structurally inspired by it. **This is NOT an HPKE ciphersuite.** RFC
9180 registers no secp256k1 KEM (its registered KEMs are the NIST P-curves
and X25519/X448; research Assumption A1), so there is no standard HPKE
ciphersuite identifier this construction could claim. Treat the RFC 9180
citation as "the shape of a well-reviewed design pattern," not as "this is
RFC 9180."

## 3. The `vt-block-1` block-content cipher (D-18)

Vote and voter records inside election blocks are encrypted under the
joint election public key `Y` (the DKG group public key — the 33-byte
`commitments[0]` from `secp256k1_FROST.trustedDealer`/DKG, hex-encoded by
the caller), and decrypt only with the matching joint secret `s`.

**Who produces blocks.** The vote pool, `packages/vote-engine/src/pool/`
(spike 102, committed at outer `fe520b46`). Voters form a block among
themselves: `formPoolBlock` in `pool-block.ts` builds it and
`commitPoolBlock` writes the `VoteBlock` and `VoteBlockVoter` rows. This
section is also the cipher API that 62-20 integrates with
`reconstructElectionKey`.

**Two layers, one cipher.** Layer 1: each vote entry is sealed to `Y` on
its own, on the voter's phone, by `encryptVoteEntry`, with the binding
`blockId = vote-entry/<ballotId>` (same `electionId` and `revision` as the
block). A block id is a base64url digest and never contains `/`, so a vote
ciphertext can never pass as a block ciphertext or the reverse. Layer 2:
the block payload is `{ v: 2, votes, voterRecords }`, where `votes` are the
serialized per-vote `BlockCiphertext` JSON strings and `voterRecords` are
the clear voter entries. `encryptPoolBlock` encrypts it with the binding
`blockId = VoteBlock.Id`. The wire object in 3.1 stays `v: 1`,
`alg: "vt-block-1"` for both layers: `v: 2` is the version of the
payload, not of the cipher.

**Canonical order.** Both arrays are sorted by their own canonical UTF-8
bytes (`sortByCanonicalBytes`; spike 102's canonical-order rule, its D-28),
so a position in the block never links a vote to its voter after
decryption.

**Ids.** `VoteBlock.Id = Digest('VoteBlockRecords', JSON.stringify({ v,
votes, voterRecords }))`, base64url (`poolBlockId`). `VoteBlock.Ciphertext`
is the serialized block `BlockCiphertext`. `VoteBlock.Cid =
cid(Digest(Ciphertext))`; `poolBlockCid` is the JS twin of that SQL.

**Disclosed randomness.** `encryptPoolBlock` draws a fresh CSPRNG `eph`
scalar and `nonce` and returns them. The former discloses them, and each
member re-derives the ciphertext with `reencryptElectionBlock` and checks
it byte for byte. Both functions refuse a `v: 1` payload (disclosing the
randomness of clear votes would hand every member every vote). Disclosure
reveals nothing new: a `v: 2` payload holds only per-vote ciphertexts that
are still sealed to `Y`, and voter entries the members already saw.

**Opening after the key release.** `openElectionBlock` opens the block,
then `openVoteEntries(secretKey, electionKey, ballotId, payload)` opens
each vote (it returns an empty list for `v: 1`). A `v: 1` payload (clear
votes, the original 62-20 `encryptElectionBlock` contract) still parses.

**Owed schema-comment fix.** The `VoteBlock.Ciphertext` column comment in
`packages/vote-core/schema/votetorrent.qsql` still describes the payload as
`ElectionBlockPayload { v: 1, votes, voterRecords }`; pool-formed blocks
carry `v: 2`. It is left unchanged on purpose: `computeSchemaHash` hashes
the whole schema text, comments included, so editing it would change the
schema hash of every existing network. Fixing it is owed to the
next intentional schema change.

### 3.1 Encrypt

1. A fresh ephemeral scalar `e` and `E = compressed(G * e)`.
2. `Z = x(e * Y)` — the section 1 ECDH convention, keyed on the joint
   public key.
3. `(K || kc) = HKDF-SHA256(IKM=Z, salt=E || Y (66 raw bytes), info=UTF-8
   "vt-block-1/key", L=64)`.
4. `ct = AES-256-GCM(K, nonce, plaintext, AAD = lp["vt-block-1/content",
   electionId, decimalString(revision), blockId])`, per [NIST SP 800-38D].

**Wire object** (`BlockCiphertext`), member order fixed:

```json
{
  "v": 1,
  "alg": "vt-block-1",
  "eph": "<66-char hex>",
  "nonce": "<base64url, 12 bytes>",
  "kc": "<base64url, 32 bytes>",
  "ct": "<base64url, >= 16 bytes>"
}
```

### 3.2 Decrypt

`decryptBlockContent` never throws. Check order:

1. **Local arguments** — `jointSecretKey` a valid 32-byte scalar; binding
   fields valid (non-empty `electionId`/`blockId`, `revision` a
   non-negative safe integer). Failure: `'invalid-argument'`.
2. **Structural validation** — parse, check member types, and that `eph`
   decodes to a valid on-curve compressed point. Failure:
   `'malformed-ciphertext'`.
3. **Version/alg check**, before any decryption. Failure:
   `'unsupported-version'`.
4. **Decode lengths** — `nonce` (12), `kc` (32), `ct` (>= 16). Failure:
   `'malformed-ciphertext'`.
5. **ECDH + derive + compare `kc` + decrypt**, inside one `try`. `Y` is
   recomputed as `getPublicKey(jointSecretKey)` — this module is never
   handed `Y` directly on the decrypt path. Every failure:
   `'authentication-failed'`.

**Caller obligation (62-20):** because this module recomputes `Y` from the
supplied `jointSecretKey` rather than being handed `Y` independently, it
cannot distinguish "wrong-but-otherwise-valid scalar" from "tampering" —
both simply fail the GCM tag check and both report
`'authentication-failed'`. The caller (62-20's `reconstructElectionKey`
integration) **must assert `getPublicKey(s) == Y`** against the
independently-known election joint public key before calling
`decryptBlockContent`, so a reconstruction bug is caught as a reconstruction
bug rather than silently reported as ciphertext tampering.

## 4. The `IKeyVault` contract (D-13 storage leg)

`src/crypto/vault.ts` declares the port; 62-21 implements it against the
Authority app's native hardware-backed storage. This section is the
normative contract the native adapter must honor — the software
`InMemoryTestKeyVault` in this package enforces the same contract today so
the port and at least one implementation are proven together.

- **Copy semantics.** `putSecret` must store a copy of the bytes it is
  given — mutating the caller's array after the call must never change
  what is stored. `getSecret` must return a fresh copy on every call —
  mutating a previously returned array must never change what is stored,
  and two calls must not share a backing buffer.
- **`'alias-exists'` refusal.** `putSecret` on an alias that already holds
  a secret rejects with `'alias-exists'` and does not overwrite. This
  exists because the only copy of a DKG share or an officer encryption key
  must never be silently clobbered by a second write; the caller must call
  `deleteSecret` first if replacement is actually intended.
- **`hasSecret` never prompts**, even for an alias whose policy requires
  user auth — it answers "is something stored here" without touching
  whatever gate protects reading it.
- **`null` for absent.** `getSecret` on an alias nothing was ever stored
  under (or that was since deleted) returns `null`, not a thrown error.
- **`deleteSecret` is idempotent** and returns whether it actually removed
  something.
- **Error codes:**
  - `'invalid-alias'` — the alias fails `KEY_VAULT_ALIAS_PATTERN =
    /^[A-Za-z0-9_.:-]{1,128}$/`. Every method rejects this uniformly.
  - `'invalid-secret'` — `putSecret` was given something that is not a
    non-empty `Uint8Array`.
  - `'alias-exists'` — see above.
  - `'auth-denied'` — the stored policy requires user auth and the user
    (or the test harness's `authorize` hook) refused.
  - `'unavailable'` — reserved for an adapter (62-21) whose native backend
    is missing or unreachable. The in-process test vault never returns
    this code.
- **No plaintext at rest in a real adapter.** `IKeyVault`'s JSDoc states
  that a production adapter stores only hardware-wrapped bytes (62-08's
  `wrapSecret`/`unwrapSecret`), never plaintext. `InMemoryTestKeyVault` is
  the one deliberate exception, and it is marked **TEST ONLY** and never
  re-exported from any barrel.

## 5. References

- **[SEC 1 v2.0]** — Standards for Efficient Cryptography Group, *SEC 1:
  Elliptic Curve Cryptography*, version 2.0, 2009. Sections 2.3.3 (point
  encoding) and 3.3.1 (ECDH primitive).
- **[SEC 2 v2.0]** — Standards for Efficient Cryptography Group, *SEC 2:
  Recommended Elliptic Curve Domain Parameters*, version 2.0, 2010. The
  secp256k1 curve parameters and generator point.
- **[RFC 5869]** — H. Krawczyk, P. Eronen, *HMAC-based Extract-and-Expand
  Key Derivation Function (HKDF)*, RFC 5869, May 2010.
- **[NIST SP 800-38D]** — NIST Special Publication 800-38D,
  *Recommendation for Block Cipher Modes of Operation: Galois/Counter Mode
  (GCM) and GMAC*, November 2007.
- **[GCM-TEST-VECTORS]** — D. McGrew, J. Viega, *The Galois/Counter Mode of
  Operation (GCM)*, submission to NIST, including the published AES-256-GCM
  test vectors (Test Case 16 is the one this module's KATs pin).
- **[RFC 5116]** — D. McGrew, *An Interface and Algorithms for Authenticated
  Encryption*, RFC 5116, January 2008. The general AEAD interface this
  module's AES-256-GCM usage conforms to.
- **[RFC 9180]** — R. Barnes, K. Bhargavan, B. Lipp, C. Wood, *Hybrid Public
  Key Encryption*, RFC 9180, February 2022. Cited as structural inspiration
  only — see section 2.4: this module is **not an HPKE ciphersuite**, since
  RFC 9180 registers no secp256k1 KEM.
- **[USENIX-ABUSE]** — A. Albertini, T. Duong, S. Gueron, S. Kölbl, A.
  Luykx, S. Schmieg, *How to Abuse and Fix Authenticated Encryption Without
  Key Commitment*, USENIX Security Symposium 2022. The rationale for this
  module's `kc` key-commitment tag — see section 2.3.

## 6. Non-claims

- **No forward secrecy** against a later compromise of a recipient's
  encryption secret key. Anyone who later obtains a recipient's secret key
  can decrypt every envelope ever wrapped to that recipient's public key.
- **Removed officers keep access to what was already wrapped to them**
  (D-04 + D-07: officer removal is forward-looking only). Conversely,
  **officers added later cannot read envelopes sealed before they were
  added**. This is a product rule, kept on purpose (D-51; user decision
  2026-10-07): officers added later, or who enable encrypted intake later,
  never receive access to envelopes sealed before they were added. No
  re-wrap or re-seal ceremony exists or is planned. An officer who was a
  recipient handles those records, and the app says so on the screens where
  it happens.
- **Not externally audited.** This is an in-repo, built-in review (D-25,
  Plan 04 Task 3) backed by published known-answer vectors and an
  independent `node:crypto` re-implementation — it is not a substitute for
  third-party cryptographic review.
- **Hermes device parity is unproven.** Every known-answer vector in this
  plan's test suite runs on Node only. The Metro/Hermes multi-copy `noble`
  bundling hazard (documented elsewhere in this project's spike findings)
  has not been re-checked against these specific vectors. 62-30 records
  this as proof debt; the FROZEN-ENV and FROZEN-BLOCK pins in
  `test/crypto-kat.spec.ts` / `test/block-cipher.spec.ts` are the exact
  vectors a future device-side KAT must reproduce byte-for-byte.
- **Officer encryption keys are stored without requiring user auth**
  (`OFFICER_ENCRYPTION_KEY_POLICY = { requireUserAuth: false }`), so that
  unattended intake processing can open envelopes without blocking on a
  biometric/PIN prompt per request (research Assumption A4). Keyholder DKG
  receiving keys and keyholder shares use `requireUserAuth: true`.
- **bigint arithmetic is not constant-time**, and the best-effort
  `.fill(0)` zeroization calls in `envelope.ts`/`block-cipher.ts` are
  exactly that — best effort. They are not a documented security property,
  and bigint/JIT copies of key material may still survive elsewhere in the
  process's memory after a call returns.

## 7. Committed-block computations: block tree, slice checks, validation, tally tree

This section specifies pure computations in
`packages/vote-engine/src/blocks/` over the committed `VoteBlock` and
`VoteBlockVoter` rows of one election revision. No schema change and no
new table come with it. Anyone holding the rows (and, after the key
release, the election secret) can recompute every value below. The
functions are exported from the package entry and the `./rn` entry. Only
the block tree is on the `./browser` entry, because the other
computations reach `@noble/curves/secp256k1.js`. Every function returns a
typed result and none reports failure by throwing.

### 7.1 Block Merkle tree

`buildBlockTree(rows, scope, authorization)` takes the committed
`VoteBlock` rows of one election (`scope.electionId`) and one revision
(`scope.electionRevision`), in any order. `authorization` is required:
`{ voterRows, registrants, associations, timeline, ballots }`, the
replicated `VoteBlockVoter` rows, the `Registrant` and `Association` rows,
the revision timeline (`votingStarts`, epoch ms) and the revision's ballot
templates. These are the same public inputs the comprehensive validation
(section 7.3) reads. Because the root depends on them only where several
rows name one `Cid`, every party that passes the same public rows gets the
same root. An authorization that cannot be read (a field that is not an
array, a `votingStarts` that is not a finite number, an unreadable ballot,
two ballots with one id) refuses the tree as `malformed-input`. A hostile
item inside one of its row lists authorizes nothing and never refuses.
`finalBlockTree(rows, scope, authorization, timeline, nowMs)` takes the same
input.

- **Row policy (tolerant).** One bad row never refuses the tree. The rows
  are selected by `selectBlockRows`, which the comprehensive validation
  (section 7.3) uses too, so both judge the same rows:
  - A row that is not shaped like a block is set aside as `malformed-row`.
  - Rows that share an `Id` but not a `Cid` are separate blocks, and each
    gets its own leaf. The validation judges each one on the consent rows
    that name its own `Cid`, so a forged row that reuses an honest `Id`
    fails its own checks and is excluded from the tally (section 7.4). The
    honest row keeps its leaf and its status.
  - Rows that share a `Cid`. The root is final at `hashingVotes`, before
    the key release, so which voter list the ciphertext really holds cannot
    be decided from the rows. Each row of a shared `Cid` is first checked
    for **authentication**. A row is authenticated when all of these hold:
    - its `Cid` is the digest of its own `Ciphertext` (`blockCidOf`, the
      `cid(Digest(Ciphertext))` check, which needs no key);
    - its `VoterRegistrantIds` is a JSON array of non-empty ids in strictly
      ascending order, as long as `EntryCount`;
    - its `TemplateDigest` is the template digest of its ballot;
    - every listed registrant has a `VoteBlockVoter` row naming this `Cid`
      that `judgeBlockVoters` accepts. For that row, the block columns
      agree, the consent signature verifies over `Digest('VoteBlockVoter',
      ElectionId, ElectionRevision, BallotId, Cid, Id, RegistrantId,
      DeviceKey)`, and the registrant and the device key pass the
      Registrant and Association rule of section 7.3.

    These are all of the validation's block checks that need no key,
    except the cross-block one. `judgeBlockVoters` is the same function the
    validation uses, so the two cannot disagree about which voter is
    authenticated. Then:
    - **Every** authenticated row is kept as a leaf of its own. An exact
      duplicate (equal leaf data) collapses to one. The validation decides
      after the release which leaf the ciphertext holds (section 7.3), and
      the ciphertext's entries are counted once (sections 7.3 and 7.4).
    - The rows that are not authenticated are set aside as
      `duplicate-block`, so junk cannot add leaves under an honest `Cid`.
    - When no row of the `Cid` is authenticated, one row is kept: a row
      whose `Cid` is the digest of its own `Ciphertext` first, then the
      lowest UTF-8 bytes of `canonicalJson([Cid, Id, BallotId,
      EntryCount, TemplateDigest, VoterRegistrantIds, Ciphertext])`. The
      validation finds it invalid anyway.

    Signatures are checked only for a `Cid` that more than one row names,
    so a tree with no collision costs no signature check. The consent
    digest and the P-256 check (`blockConsentDigest`,
    `verifyBlockConsent`) make the same calls as the pool's
    `consentDigest` and the schema's `verifySigP256`. Tests pin that
    parity, so the block tree stays on the `./browser` entry.
  - The tree is built over the kept rows. The set-aside rows are returned
    in `tree.rejected` as `{ cid, reason, detail }`, ascending by `cid`
    and carrying no input position, so the result does not depend on the
    input order.
  - Only a row of another election (`mixed-election`) or another revision
    (`mixed-revision`) refuses the whole tree: rows are selected per
    election revision, so such a row is a caller error. The scope is
    checked before the shape, so a foreign row refuses even when it is
    also malformed. A `rows` value that is not an array is
    `malformed-row`.

- **Leaf data.** The exact string
  `canonicalJson([ElectionId, ElectionRevision, BallotId, Id, Cid,
  EntryCount, TemplateDigest, voterListDigest])`, a JSON array in that
  order, with `ElectionRevision` and `EntryCount` as plain numbers (a
  database bigint is converted first) and `TemplateDigest` exactly as
  stored. `voterListDigest` is the lowercase hex of
  `SHA-256(UTF-8(VoterRegistrantIds))`, taken over the stored JSON text
  of the column (exported as `voterListDigest`). The root so commits to
  each block's frozen voter list and template column, which neither the
  `Cid` (it covers only the ciphertext) nor the `Id` covers. The list
  enters as a digest because the leaf data is published inside the tally
  tree (section 7.4) and must not carry registrant ids. `canonicalJson`
  is the sorted-key, no-whitespace JSON of `src/voting/canonical.ts`.
- **Leaf order.** Ascending by the UTF-8 bytes of `Cid`; a shorter string
  that is a prefix of a longer one sorts first. Leaves of one `Cid` are
  then ascending by the UTF-8 bytes of their leaf data, which differ
  because exact duplicates collapse, and which also give them different
  leaf hashes. A `Cid` must be a base32
  CIDv1 string, `b` followed by characters of `a-z` and `2-7` (the form
  `cid(Digest(Ciphertext))` produces; `isBase32Cid`), or the row is
  `malformed-row`. That keeps the order total: two distinct strings can
  never encode to the same bytes, as two different lone surrogates would.
- **Leaf hash.** `SHA-256(0x00 || UTF-8(leafData))`.
- **Node hash.** `SHA-256(0x01 || left || right)`, where `left` and
  `right` are the raw 32-byte child hashes (not their hex text).
- **Shape.** A range of width n greater than 1 splits at the largest
  power of two strictly below n; the left part is the first that many
  leaves. A lone node is carried up unchanged and is never duplicated.
- **Small sets.** One leaf is its own root. The empty set has no nodes and
  the root `SHA-256(UTF-8("vt-block-tree/1/empty"))`, which is
  `d4058a2d363e8f3901b46f30728fbbdbc7f17e30c7b7e4466804e2aaacfb6016`.
- **Inclusion proof.** `{ leafIndex, treeSize, path }`, where `path` lists
  sibling hashes from the leaf to the root, each with the side
  (`left` or `right`) the sibling sits on. `verifyInclusion(leafHash,
  proof, root)` first checks that `leafHash` and `root` are 64 lowercase
  hex characters, that `0 <= leafIndex < treeSize`, and that the path
  length and every side equal what `(leafIndex, treeSize)` dictate; any
  difference is `malformed-proof`. It then folds the path from the leaf
  hash with the node hash and compares the result with the root
  (`root-mismatch` when they differ). The caller recomputes `leafHash`
  from its own row, never from the proof. `tree.proofFor(cid, leafHash?)`
  returns a leaf's proof. When a `Cid` names several leaves it needs the
  leaf hash, and without one it returns `ambiguous-block`.
- **Final root.** The accruing period ends at the election timeline's
  `hashingVotes`. `finalBlockTree` and `blockTreeStatus` return a final
  tree only when `nowMs >= hashingVotes`. Before that they return
  `accruing-not-ended` with the time it ends and, from `finalBlockTree`,
  the provisional tree. `nowMs` is the caller's clock, so this is a
  computation gate and not a security boundary. A timeline with
  `hashingVotes` before `accruingVotes`, or a `nowMs` that is not a finite
  number, is refused.

Who stores, caches and publishes the root is open (section 7.5).

### 7.2 Voter slice checks

`sliceChecks(receipt, rows, voterRows, anchor?, release?, authorization?)` lets a voter
check its own slice of the committed blocks. The receipt holds the
election id and revision, the voter's plaintext vote entries with their
nonces (one per ballot), and the voter's signed voter entry. It holds no
ciphertext. `rows` and `voterRows` are the replicated `VoteBlock` and
`VoteBlockVoter` rows. `anchor` is a root and optionally a publisher's
inclusion proof. `release` is the election secret key and the joint
public key.

For each ballot of the receipt the report has four results, always in
the order of `SLICE_CHECK_IDS`:

- `my-vote`: after the release, the voter's canonical vote entry,
  nonce included, is found exactly once among the opened votes of the
  block recorded for the voter and ballot.
- `my-voter-entry`: the `VoteBlockVoter` row names a block with the same
  `Id`; the block's registrant list holds the voter once; the consent
  signature verifies; the row's device key is the receipt's; the voter
  entry's own signature verifies; and after the release the voter entry
  is in the payload exactly once and the block's list is the payload's
  list of voters (`voter-list-mismatch` otherwise).
- `block-hash`: the `Cid` is the digest of the ciphertext (needs no key);
  after the release the `Id` is the digest of the payload too.
- `under-root`: the leaf hash is recomputed from the voter's own block row
  and checked against the anchor's root, with the supplied proof or with
  a tree built from the supplied rows. Building that tree needs the block
  tree's authorization (section 7.1) besides `voterRows`. Without one,
  the tree is never built. A supplied proof is then checked by
  `verifyInclusion` alone, and with no proof `under-root` is
  `not-applicable` (`no-authorization`).

Several block rows may share the voter's `Cid`, because the block tree
keeps every authenticated row of a `Cid` (section 7.1). An example is the
honest block and a forged one that lists the voter and a colluding
registrant. Each row is judged, and the best result is reported: the
fewest failures, then the fewest checks short of a plain pass, then leaf
order. Before the release both may pass, because nothing yet shows which
list the ciphertext holds. After it only the row whose list is the
payload's can pass `my-voter-entry`.

Each result has one of four statuses: `pass`, `fail` (with a reason code
and a detail), `pending-key-release` and `not-applicable` (reason
`no-block`, `no-root` or `no-authorization`). The ballot verdict is `fail` if any check
fails, `pass` if all four pass with nothing left pending, and
`incomplete` otherwise.

`my-vote` is `pending-key-release` before the release, never `pass` or
`fail`: the receipt keeps the plaintext entry and its nonce but no
ciphertext, so there is nothing to compare until the block opens. A
`pass` on another check may still list parts that are pending the
release (`voter-entry-in-payload`, `block-id`).

The caller obtains the election secret, holds it and zero-fills it after
the call. The functions check it against the joint public key first
(`invalid-secret` or `secret-mismatch` refuse the whole report), and never
copy, store or return it. Other refusals are `malformed-receipt` and
`malformed-rows`.

### 7.3 Comprehensive validation

`validateElectionBlocks({ scope, rows, voterRows, ballots, registrants,
associations, timeline, release? })` checks every committed block of one
election revision, in two phases. `registrants` are the election's
`Registrant` rows (`Id`, `Status`, `Expiration`), `associations` the
device `Association` rows (`RegistrantId`, `DeviceKey`, `Expiration`),
and `timeline` the revision timeline (`votingStarts`, epoch ms). All
three are required (`malformed-input` otherwise).

- **Without the key**, for every block: the `Cid` is the digest of the
  ciphertext; the registrant list is well formed, canonical and as long
  as `EntryCount`; the ballot is known and the template digest matches;
  every listed registrant has an authenticated `VoteBlockVoter` row; and
  a registrant appears in at most one block per ballot. Such a block's
  status is `not-decryptable-yet`, which is a status of its own and not a
  failure.
- **After the release**, for every block: the block opens; the `Id` and
  the entry count match; the payload is well shaped, canonically ordered
  and free of duplicate votes or voters; every voter entry has a valid
  signature, the right scope and the ballot, and its device key is the
  device key of the registrant's authenticated voter row, which the
  authorization check below ties to a registered, associated device; and
  every vote opens, parses and is judged against its ballot template.
  A block is `invalid` exactly when it has an error finding that is not
  tied to one vote.

**Authorization.** A consent signature, or a voter-entry signature, only
shows that the row's own key signed it. Each voter row is therefore also
checked against the caller's `Registrant` and `Association` rows with the
rule of the schema's `VoterAssociated` CHECK:

- `voter-not-registered`: there is no `Registrant` row with the row's
  `RegistrantId`, `Status` `'a'` and an `Expiration` later than the
  reference time.
- `device-key-not-associated`: there is no `Association` row with the
  row's `RegistrantId` and exactly its `DeviceKey` and an `Expiration`
  later than the reference time.

The schema compares with the writer's clock at insert, which a validator
cannot see. An insert had to fall in `[votingStarts, accruingVotes)`, so
the reference time is the timeline's `votingStarts`, the weakest bound
every honest insert met. `Expiration` must be an ISO datetime ending in
`Z`; it is compared to the millisecond, and an unreadable value
authorizes nothing. Status and associations are read as supplied: a
registrant revoked, or an association deleted, after voting fails the
check.

**Attribution.** A finding lands on a block only when the evidence is
authenticated for that block. The voter rows naming a block are grouped
by registrant. For a listed registrant, the block keeps one
representative row: a row with no problem if there is one (its consent
signature verifies, it agrees with the block, and it passes the
authorization), else the row with the fewest problems, then the lowest
row key. The representative's problems are the block's findings. Every
other row naming the block (a second row for a listed registrant, a row
for a registrant the block does not list, a row with no `RegistrantId`)
is the report-level error `voter-row-forged` and never touches the block.
A registrant counts towards `registrant-in-two-blocks` only in the blocks
where its representative row is authenticated, so a forged block that
lists an honest voter without that voter's valid consent cannot exclude
the honest block. Leaves that share a `Cid` are one block for this check,
because they are claims about one ciphertext. So a forged leaf of the
honest `Cid` that lists the honest voters, with their real consent, does
not put them "in two blocks".

Shared `Cid` (T-65-05-03). After the release, every leaf of a `Cid` is
checked against the opened payload: `payload-count-mismatch`,
`voter-count-mismatch`, `voter-list-mismatch` and `id-mismatch`. So at
most one leaf of a `Cid` can be valid. If two ever were, both would get
the block-level error `cid-in-two-valid-blocks` and be excluded, rather
than counted twice. This is unreachable by construction: two leaves that
both match one payload have equal leaf data and have collapsed.

One leaf per `Cid` counts the ciphertext's entries, chosen in this order:
1. the valid leaf;
2. else a leaf that cannot be decrypted yet;
3. else an invalid one;

ties going to the most `attestedEntries`, then leaf order. Every other
leaf of the `Cid` carries `shadowedBy` (the counting leaf's `leafHash`)
and counts nothing: `attestedEntries` 0 and no `undecryptable` entries.
Before the release the counting leaf is the one with more attested
entries, so the pre-release totals may include a colluding registrant's
entry. They never count one ciphertext twice.

The answer policy for one decrypted vote against its ballot template:

- The vote is invalid when it is not shaped like a vote entry, is for
  another election, revision or ballot, carries another template digest
  or a bad nonce, repeats or mis-orders its answers, answers an unknown
  question or option, repeats or mis-orders option codes, gives an
  empty answer, gives more options than the question's cap
  (`too-many-options`), or gives fewer than `optionRange.min`
  (`below-minimum`).
- A blank answer to a required question (`required` defaults to true) is
  valid and reported as the info finding `blank-required`.
- A rank, score or text answer cannot be represented as a set of option
  codes. It is reported with the info finding `unsupported-question-type`
  and still receives the structural checks.
- Invalid votes are counted apart from valid ones and are never dropped.

The report has one finding record per block, in the block tree's leaf
order (UTF-8 bytes of `Cid`, then of the leaf data), a verdict per vote,
report-level findings and totals. Each block record carries `leafHash`
(its block-tree leaf hash, which names the leaf when a `Cid` has several),
`shadowedBy` (see above), `declaredEntries` (the `EntryCount`) and
`attestedEntries`, the smallest of `EntryCount`, the number of listed
voters and the number of listed voters with an authenticated voter row. The totals
satisfy `valid + invalid + excluded + undecryptable = entries`:

- `valid` and `invalid` count the votes of `valid` blocks only. The votes
  inside a block that is `invalid` are never counted as valid or invalid,
  because the tally excludes that block.
- `excluded` is the `attestedEntries` of every `invalid` block (0 for a
  shadowed one).
- `undecryptable` is the `EntryCount` of every `not-decryptable-yet`
  block that is not shadowed, that is, before the release, each
  ciphertext once.
- `entries` is their sum: a valid block's payload votes, an invalid
  block's `attestedEntries`, and a not-yet-decryptable block's
  `EntryCount`.

After the release these totals equal the tally root of section 7.4,
summed over the ballots: `entries` its `votes`, `invalid` its
`invalid`, `excluded` its `excluded`, and `valid` its derived valid
count. Refusals are `malformed-input`, `mixed-election`,
`mixed-revision`, `invalid-secret` and `secret-mismatch`.

The secret rule differs from section 7.2 in one point. As there, the
caller obtains the election secret, holds it and zero-fills it after the
call, and the secret is checked against the joint public key before
anything opens (`invalid-secret` or `secret-mismatch` refuse the whole
report). Unlike the slice checks, the validation works on a private copy
of the secret, which it zero-fills in a `finally` block whatever the
outcome. The caller's array is never modified and never retained, and
the report holds no byte array. `buildTallyTree` hands the release
straight to the validation and never reads the secret itself.

Every finding has a code and a severity, `error` or `info`. The codes,
grouped as the source groups them:

- Block, no key needed: `malformed-row` (a kept row with no
  `Ciphertext` text), `cid-mismatch`, `voter-list-malformed`,
  `voter-list-not-canonical`, `entry-count-mismatch`, `unknown-ballot`,
  `template-mismatch`, `voter-row-mismatch`, `voter-row-missing`,
  `consent-signature-invalid`, `voter-not-registered`,
  `device-key-not-associated`, `registrant-in-two-blocks`.
- Report level: `voter-row-without-block` (info), `voter-row-forged`,
  and `malformed-row` and
  `duplicate-block` for the rows the block-tree row policy (section 7.1)
  set aside. The validation selects them with its own `voterRows`,
  `registrants`, `associations`, `timeline` and `ballots` as the
  authorization. A set-aside row is not a block of the report and never
  adds a finding to another block, and the blocks of the report are
  exactly the leaves of the block tree, in its order. `duplicate-block`
  means only a row of a shared `Cid` that is not authenticated (or the
  loser when none is), or an exact duplicate. Rows that share only an `Id`
  are separate blocks, each with its own findings.
- Block, after the release: `block-does-not-open`, `id-mismatch`,
  `payload-count-mismatch`, `not-a-payload`, `counts-differ`,
  `voter-count-mismatch`, `not-canonical-order`, `duplicate-vote`,
  `duplicate-voter`, `voter-list-mismatch`, `voter-entry-scope-mismatch`,
  `voter-entry-malformed`, `voter-entry-signature-invalid`,
  `voter-entry-ballot-missing`, `voter-entry-device-key-mismatch`,
  `cid-in-two-valid-blocks`.
- Per vote, after the release: `vote-does-not-open`, `vote-not-json`
  (the decrypted text does not parse, or has no canonical form), and
  `vote-not-canonical` (info): the decrypted text parses but is not the
  canonical JSON of its entry. A Voter encrypts the canonical form, so
  any other text is a client fingerprint inside the block that weakens
  unlinkability. The vote is still judged on its entry and counts if it
  is valid.
- Per vote, the answer codes: `malformed-ballot`, `malformed-entry`,
  `wrong-election`, `wrong-revision`, `wrong-ballot`,
  `template-digest-mismatch`, `bad-nonce`, `answers-not-sorted`,
  `duplicate-question`, `unknown-question`, `empty-answer`,
  `unknown-option`, `duplicate-option`, `options-not-sorted`,
  `too-many-options`, `below-minimum`, `blank-required` (info),
  `unsupported-question-type` (info).

### 7.4 Tally tree

`buildTallyTree` runs the block tree, the validation and the tally in
that order and needs the released secret (`not-released` otherwise).
Because both the block tree and the validation follow the tolerant row
policy of section 7.1, a malformed or duplicate row never prevents the
tally of the other blocks; it is listed in `blockTree.rejected` and in the
validation's report-level findings.
`tallyTreeFrom` does the same from an existing tree and validation
report. It trusts neither input. It refuses `inconsistent-inputs` when the
tree does not hash to itself (leaf order and indexes, each leaf's fields
against its leaf data, the node shape, every leaf hash recomputed from
its leaf data, every internal hash from its children, and the root), when
the report does not cover exactly the tree's leaves, or when a block's
`Cid`, ballot, block id or `declaredEntries` differs from its leaf.
Findings are matched to leaves by `leafHash`, because a `Cid` may name
several leaves. It also refuses a report in which two findings of one
`Cid` count entries (two valid, or an invalid one with `attestedEntries`
above 0 next to a valid one): one ciphertext is counted once. The tally tree has one node for every node of the block tree, in
the same order, so the block-tree root is unchanged by the tally.

- **Histogram.** `{ ballots: { <ballotId>: { votes, invalid, excluded,
  questions, unsupported } } }`, listing only the ballots present in the
  subtree. For a `select` question (type absent, `null` or `select`; the
  validation and the tally share one rule, `questionType`, and a type that
  is neither a string nor absent makes the ballot malformed in both),
  `questions[code]` is `{ answered, options }`: `answered` is the number
  of valid votes that answered the question, and `options` has every
  option code of the template, starting at zero, with the number of valid
  votes choosing it. A blank is derived as the valid votes minus
  `answered` and is not stored; likewise the valid count is
  `votes - invalid - excluded`.
- **Leaf.** The histogram of one block: its valid decrypted select
  answers; its invalid votes counted apart under `invalid`. A block that
  validation marks `invalid` is not tallied: its option counts stay zero,
  the leaf lists the block-level error codes in `excludedFor`, and its
  `attestedEntries` from the validation goes under `votes` and
  `excluded`. `attestedEntries` is the smallest of the declared
  `EntryCount`, the number of listed voters and the number of listed
  voters with an authenticated voter row (section 7.3), and 0 for a leaf
  that another leaf of its `Cid` shadows. An invalid block
  is untrusted, so its declared `EntryCount` alone (up to 2^53 - 1) must
  not inflate the excluded volume. A tallied leaf's `votes` equals the
  `EntryCount` its leaf data commits to; an excluded leaf's is at most
  that.
- **Overflow.** Every count of every node must stay a safe integer. A sum
  that would pass 2^53 - 1 refuses the tally with `count-overflow`, so no
  tally is ever emitted that its own verifier would reject.
- **Parent.** The canonical sum of the two children: the union of keys,
  every count added, keys sorted.
- **Unsupported types.** Every question whose type is not `select`
  (rank, score, text, unknown) is counted under `unsupported`, as the
  number of valid votes that answered it, and never under `questions`.
- **Tally hash.** For a leaf node,
  `SHA-256(0x04 || merkleHash || UTF-8(canonicalJson({ disposition,
  excludedFor, histogram })))` (`tallyLeafHash`). For a parent node,
  `SHA-256(0x03 || merkleHash || leftHash || rightHash ||
  UTF-8(canonicalJson(histogram)))` (`tallyParentHash`), where
  `leftHash` and `rightHash` are the children's tally hashes. Every hash
  enters as its 32 raw bytes, and `merkleHash` is the block-tree node hash.
  Because each parent commits to its children's tally hashes, the root
  binds every leaf's histogram, disposition and `excludedFor` (which must
  be sorted and free of repeats): none of them can be rewritten without
  changing the root. The prefix byte `0x02` is left unused on purpose, so
  a tally hash cannot pose as a block-tree hash. The empty tally has size
  0, no nodes, and the root
  `SHA-256(0x03 || emptyRoot || UTF-8(canonicalJson({"ballots":{}})))`
  (`tallyNodeHash`), where `emptyRoot` is the empty block-tree root of
  section 7.1.
- **Contents.** The tally is plain JSON data: counts and public block
  columns only, with no vote entry, nonce, registrant id or key.
- **Verifier.** `verifyTallyTree(tally)` takes an untrusted tally and
  checks, in order: the format; the shape (leaf order by `Cid` then leaf
  data, node order, ranges and children as the block tree builds them);
  each leaf's data and disposition; then for each node the block-tree
  hash, the histogram (a leaf's own bounds, a parent's sum of its
  children; and of the leaves sharing a `Cid`, at most one with votes) and
  the tally hash; and last the root. It reports the first failure with its node or leaf
  index. A pass shows the tally is internally consistent and every
  branch holds. It does not show that the leaf histograms match the
  decrypted blocks; that needs the released key, and the check is to
  run `buildTallyTree` over the rows and compare the roots.

### 7.5 Open items

The election specification leaves these open, and this code does not
settle them:

- Who coordinates, stores, caches and publishes the block-tree root and
  the tally tree.
- Signing of tally nodes and trusted timestamps.
- The completion notification.
- Large answer sets, and normalisation of write-in answers.
- Tallies for rank, score and text questions.
- A clock the writer cannot choose. The final-root gate uses the caller's
  clock.
- The voter screens for slice-check and validation results.
- Closed (T-65-05-03): which of two rows sharing a `Cid` or an `Id` is
  genuine, before the key release. No forged row displaces an honest
  block:
  - Rows that share an `Id` under different `Cid`s are separate leaves.
  - Among rows that share a `Cid`, every authenticated one is a leaf, and
    the rest are set aside (section 7.1).
  - After the release the payload refutes every leaf but the true one,
    and each ciphertext is counted once (sections 7.3 and 7.4).

  This covers the copied ciphertext under another `Id` or voter list, the
  reused `Id` under its own `Cid`, a subset of the honest voters, a
  changed `TemplateDigest`, and the superset that adds a colluding,
  registered key. What remains is not a displacement:
  - Before the release, a `Cid` may carry extra authenticated leaves, and
    the pre-release totals may count the leaf with more attested entries.
  - The number of such leaves is bounded only by the consents the forger
    can use. Without any key it can list subsets of the honest voters;
    with keys it can add registrants. All of them are excluded after the
    release with nothing counted.
  - A writer that bypasses the schema could already add any number of
    excluded leaves under fresh `Cid`s, so this is not a new kind of
    growth.

[SEC 1 v2.0]: #5-references
[SEC 2 v2.0]: #5-references
[RFC 5869]: #5-references
[NIST SP 800-38D]: #5-references
[GCM-TEST-VECTORS]: #5-references
[RFC 5116]: #5-references
[RFC 9180]: #5-references
[USENIX-ABUSE]: #5-references
