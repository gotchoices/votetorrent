# Schema Discrepancies

1. table AdminSignature -> constraint SignatureValid: 

  ```sql
      join AuthoritySignature ATS on ATS.AuthorityId = A.AuthorityId and ATS.AdminEffectiveAt = A.EffectiveAt
  ```

  `AuthoritySignature` does not exist.

2. table ProposedOfficerUser -> constraint SignatureValid:

  ```sql
  	constraint SignatureValid check (exists (select 1 from ProposedOfficer PA
        where PA.AuthorityId = new.AuthorityId and PA.AdminRevision = new.AdminRevision and PA.ProposedName = new.ProposedName and PA.UserId = new.UserId and PA.SignerKey = new.SignerKey and PA.Signature = new.Signature
			)
		)
  ```

  `ProposedOfficer` does not have AdminRevision (probably AdminEffectiveAt), UserId, SignerKey, and Signature columns.


3. table InviteSlot -> constraint InviteSignatureValid

  ```sql
  constraint InviteSignatureValid check (SignatureValid(Digest(Cid, Type, Name, Expiration),      InviteSignature, InviteKey)),
  ```

  Type column is missing. However a note says that: 
  
  SigningNonce text, -- AdminSigning.Nonce, shows admin approval including scope (implies the type of invite, e.g. authority, officer, keyholder, registrant)


4. table User -> constraint UserValid

  ```sql
  -- Must be associated with a keyholder
  exists (select 1 from Keyholder K where K.UserId = new.UserId)
  -- or must be associated with an officer
  or exists (select 1 from Officer O where O.UserId = new.UserId)
  ```

  Keyholder table is missing from the schema.


5. These election/model.ts models are not in the schema yet but the ElectionType enum is there:

```ts
type ElectionCore 
interface ElectionRevision
type ElectionCoreInit 
type ElectionRevisionInit 
type ElectionDetails 
type ElectionInit 
type ElectionSummary 

enum ElectionEvent
type KeyholderInvite
type SentKeyholderInvite 
type Ballot 
type BallotDetails 
type BallotSummary 
type Option 
type Question 
type QuestionSummary
```

The Task table is mentioned in comments but not sure if it needs to be brought back 

e.g. -- select 1 from Task T join AdminSigning A on A.Nonce = T.SigningNonce 


# TypeScript Model Discrepancies

1. Admin { id: string, officers: Officer[]}

  Schema uses PK (AuthorityId, EffectiveAt) so we can make a virtual 'id' field based on that. Officers array can also be derived. 

2. Officer type is missing `adminEffectiveAt` field to identify the epoch this officer belongs to.

3. Authority { domainName: string }

  Schema has `DomainName text null`.

4. Scope 'rnp' 

  Scope's union has 'rnp' but 'rnp' is missing from `scopeDescriptions` and the Scope view in the schema.

5. InviteResult digest

  InviteResult is missing `digest: string | null` and `invitationSignature` is InviteSignature in the schema.


6. AdminSigning, OfficerSignature, and AdminSignature have no corresponding TS types yet. `ISigningEngine` has `sign` and `startSigningSession` method signatures. 
