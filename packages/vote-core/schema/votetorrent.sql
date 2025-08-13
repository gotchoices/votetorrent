create table Network (
	Sid text,
	Hash text,
	SignerKey text,
	Signature text,
	primary key (/* none - one row max */),
	--constraint SignatureValid check (SignatureValid(Digest(Sid, Hash), Signature, SignerKey)),
	--constraint HashValid check (Hash = Digest(Sid) % 65536),
	constraint InsertOnly check on update, delete (false)
);

create view ElectionType as select * from (values ('o', 'Official'), ('a', 'Adhoc')) as ElectionType(Code, Name);

create table NetworkRevision (
	NetworkSid text,
	Revision integer,
	Timestamp text,
	Name text,
	ImageRef text, -- json object { url?: string, cid?: string }
	Relays text, -- json array of strings - TODO: constraint
	TimestampAuthorities text, -- json array of { url: string } - TODO: constraint
	NumberRequiredTSAs integer,
	ElectionType text, -- references ElectionType(Code)
	SignerKey text,
	Signature text,
	primary key (NetworkSid, Revision),
	constraint Monotonicity check (
		Revision > 0
			and (Revision = 1 or Revision = (select max(Revision) from NetworkRevision NR where NR.NetworkSid = new.NetworkSid) + 1)
	),
	constraint NetworkSidValid check (exists (select 1 from Network N where N.Sid = new.NetworkSid)),
	constraint ElectionTypeValid check (ElectionType in (select Code from ElectionType)),
	constraint InsertOnly check on update, delete (false)
);

create view Scope as select * from (values
	('rn', 'Revise Network'),
	('rad', 'Revise or replace the Administration'),
	('vrg', 'Validate registrations'),
	('iad', 'Invite other Authorities'),
	('uai', 'Update Authority Information'),
	('ceb', 'Create/Edit ballot templates'),
	('mel', 'Manage Elections'),
	('cap', 'Configure Authority Peers')
) as Scope(Code, Name);

create table Authority (
	Sid text, -- Cid of first record for this authority
	Name text,
	DomainName text,
	ImageRef text null, -- json object { url?: string, cid?: string }
	SignerKey text,
	Signature text,
	primary key (Sid),
	--constraint NewSidValid check on insert (Sid = Digest(Name, DomainName, ImageRef)),
	constraint SidImmutable check on update (new.Sid = old.Sid),
	constraint InvitationValid check on insert (
		not exists (select 1 from Authority)
			or exists (select 1 from InvitationResult IR join InvitationSlot InvS on InvS.Cid = IR.SlotCid
				where InvS.Type = 'au' and IR.InvokedSid = new.Sid)
	),
	constraint CantDelete check on delete (false),
	constraint SignerKeyValid check (exists (select 1 from Administration A where A.AuthoritySid = new.Sid and A.Revision = 1))
);

create table Administrator (
	AuthoritySid text,
	AdministrationEffectiveAt text,
	UserSid text,
	Title text,
	Scopes text default '[]', -- json array of strings
	SignerKey text,
	Signature text,
	primary key (AuthoritySid, AdministrationEffectiveAt, UserSid),
	constraint AuthoritySidValid check (exists (select 1 from Authority A where A.Sid = new.AuthoritySid)),
	constraint UserSidValid check (exists (select 1 from User U where U.Sid = new.UserSid)),
	constraint AdministrationValid check (exists (select 1 from Administration A where A.AuthoritySid = new.AuthoritySid and A.EffectiveAt = new.AdministrationEffectiveAt)),
	constraint InsertOnly check on update, delete (false),
	constraint ScopesValid check (not exists (select 1 from json_array_elements_text(Scopes) S(s) where s not in (select Code from Scope))),
	constraint SignerKeyValid check (exists (select 1 from UserKey K where K.UserSid = new.UserSid and K.Key = new.SignerKey and K.Expiration > now()))
	-- constraint SignatureValid check (SignatureValid(
	-- 	Digest(AuthoritySid, AdministrationEffectiveAt, UserSid, Title, Scopes),
	-- 	Signature,
	-- 	SignerKey)
	-- )
	-- TODO: transaction level constraint that Administrators and Administration are inserted together
	-- constraint AdministrationValid transaction check (exists (select 1 from Administration A where A.AuthoritySid = new.AuthoritySid and A.EffectiveAt = new.AdministrationEffectiveAt))
);

create index AdministratorUser on Administrator (UserSid); -- include (Scopes)

create table Administration (
	AuthoritySid text,
	EffectiveAt text,
	ThresholdPolicies text default '[]', -- json array of { policy: string (Scope), threshold: integer }
	SignerKey text,	-- The threshold public key of the current administration
	Signature text,
	primary key (AuthoritySid, EffectiveAt),
	--constraint ThresholdPoliciesValid check (...), -- TODO: constraint
	constraint AuthoritySidValid check (exists (select 1 from Authority A where A.Sid = new.AuthoritySid)),
	constraint CantDelete check on delete (false),
	-- constraint SignerKeyValid check (not exists (select 1 from Administration A where A.AuthoritySid = new.AuthoritySid)
	--	or SignerKey ...),
	-- constraint SignatureValid check (SignatureValid(
	-- 	Digest(
	-- 		Sid,
	-- 		AuthoritySid,
	-- 		Revision,
	-- 		Expiration,
	-- 		ThresholdPolicies,
	-- 		-- TODO: fix this syntax:
	-- 		json(select * from Administrator A where A.AuthoritySid = new.AuthoritySid
	-- 			and A.AdministrationRevision = new.Revision
	-- 		)
	-- 	), Signature, SignerKey)
  -- )
);

-- Note: proposed aren't dependencies, just a workflow for constructing a fully signed admin

-- A threshold signing "session"
create table ThresholdSigning (
	Nonce text, -- Random ID
	ThresholdKey text, -- Public key of the threshold group
	Threshold integer, -- Number of required participants
	TermsHash text, -- Hash of the DKG terms
	Digest text, -- Content hash to be signed - Base64url encoded sha256
	primary key (Nonce),
	constraint InsertOnly check on update, delete (false)
);

-- Indicates that a given user has opted in as a participant for the upcoming attempt
create table ThresholdOptIn (
	SigningNonce text,
	AttemptSequence integer,
	IdNum integer, -- User's threshold ID number
	UserSid text,
	primary key (SigningNonce, AttemptSequence, IdNum),
	constraint SigningNonceValid check (exists (select 1 from ThresholdSigning TS where TS.Nonce = new.SigningNonce)),
	constraint InsertOnly check on update, delete (false),
	constraint OnlyAddBeforeAttempt check (not exists (select 1 from ThresholdAttempt TA where TA.SigningNonce = new.SigningNonce and TA.Sequence = new.AttemptSequence))
	constraint ValidUserSid check (exists (select 1 from User U where U.Sid = new.UserSid))
);

-- Represents the beginning of an attempt to complete a signature based on the current opt-in set
-- Once this is created, no more opt-ins are allowed for this attempt
create table ThresholdAttempt (
	SigningNonce text,
	Sequence integer,
	primary key (SigningNonce, Sequence),
	constraint EnoughOptIns check (
		(select count(*) from ThresholdOptIn TOI where TOI.SigningNonce = new.SigningNonce and TOI.AttemptSequence = new.Sequence)
			>= (select Threshold from ThresholdSigning TS where TS.Nonce = new.SigningNonce)
	),
	constraint InsertOnly check on update, delete (false)
);

-- Participant's commitment to the attempt
create table ThresholdCommitment (
	SigningNonce text,
	AttemptSequence integer,
	IdNum integer, -- Also assumed ordering
	R1 text,
	R2 text,
	primary key (SigningNonce, AttemptSequence, IdNum),
	constraint InsertOnly check on update, delete (false),
	constraint ThresholdAttemptExists check (exists (select 1 from ThresholdAttempt TA where TA.SigningNonce = new.SigningNonce and TA.Sequence = new.AttemptSequence)),
	constraint IdNumValid check (IdNum in (select IdNum from ThresholdOptIn TOI where TOI.SigningNonce = new.SigningNonce and TOI.AttemptSequence = new.AttemptSequence))
	constraint R1Valid check (IsValidPoint(R1) and not IsIdentityPoint(R1)),
	constraint R2Valid check (IsValidPoint(R2) and not IsIdentityPoint(R2))
);

-- Participant's response to the attempt - each participant should verify all other commitments
create table ThresholdResponse (
	SigningNonce text,
	AttemptSequence integer,
	IdNum integer,
	SignatureShare text null,	-- encoded s_i
	RejectionReason text null,
	primary key (SigningNonce, AttemptSequence, IdNum),
	constraint InsertOnly check on update, delete (false),
	constraint ShareRejectionMutex check ((SignatureShare is not null) xor (RejectionReason is not null)),
	constraint SignatureShareValid check (
		SignatureShare is null or IsScalarModN(SignatureShare)
	),
	constraint ThresholdCommitmentsValid check (
		-- Use case expression to short-circuit the check
		case when
			-- A response is already present for this attempt and participant (fast check with short-circuit)
			exists (select 1 from ThresholdResponse TR where TR.SigningNonce = new.SigningNonce and TR.AttemptSequence = new.AttemptSequence and TR.IdNum <> new.IdNum)
		then true
		else
			-- Or all expected commitments are present
			not exists ((select IdNum from ThresholdCommitment TC where TC.SigningNonce = new.SigningNonce and TC.AttemptSequence = new.AttemptSequence)
				diff (select IdNum from ThresholdOptIn TOI where TOI.SigningNonce = new.SigningNonce and TOI.AttemptSequence = new.AttemptSequence))
		end
	)
);

-- The final signature output - only need one for Signing since this will only insert if valid
create table ThresholdSignature (
	SigningNonce text,
	AttemptSequence integer,
	Signature text,	-- encoded schnorr (r||s)
	primary key (SigningNonce),
	constraint InsertOnly check on update, delete (false),
	constraint SignatureValid check (exists (
		select 1 from ThresholdSigning TS on TS.Nonce = new.SigningNonce
			where SchnorrSignatureValid(TS.Digest, Signature, TS.ThresholdKey))
	)
);

create table ProposedAdministration (
	AuthoritySid text,
	EffectiveAt text,
	ThresholdPolicies text default '[]', -- json array of { policy: string (Scope), threshold: integer }
	primary key (AuthoritySid, EffectiveAt),
	--constraint ThresholdPoliciesValid check (...), -- TODO: constraint
	constraint AuthoritySidValid check (exists (select 1 from Authority A where A.Sid = new.AuthoritySid)),
	constraint CantDelete check on delete (false),
);

create table ProposedAdministrationSignature (
	AuthoritySid text,
	EffectiveAt text,
	UserSid text,
	SignerKey text,	-- TODO: Is this a key, or a threshold share, or what?
	SignatureShare text,
	primary key (AuthoritySid, EffectiveAt, UserSid),
);

create table ProposedAdministrator (
	AuthoritySid text,
	AdministrationEffectiveAt text,
	ProposedName text,
	Title text,
	Scopes text default '[]', -- json array of strings
	AdministratorKey text,	-- Key of some current administrator
	AdministratorSignature text,
	primary key (AuthoritySid, AdministrationEffectiveAt, ProposedName),
	constraint AuthoritySidValid check (exists (select 1 from Authority A where A.Sid = new.AuthoritySid)),
	constraint AdministrationValid check (exists (select 1 from Administration A where A.AuthoritySid = new.AuthoritySid and A.Revision = new.AdministrationRevision)),
	constraint CantDelete check on delete (false),
	constraint ScopesValid check (not exists (select 1 from json_array_elements_text(Scopes) S(s) where s not in (select Code from Scope))),
	constraint AdministratorKeyValid check (exists (select 1 from UserKey K
		-- Most recent effective administration
		join Administrator A on A.UserSid = K.UserSid and A.AdministrationEffectiveAt <= now()
		join Administration AD on AD.AuthoritySid = A.AuthoritySid and AD.E
		where K.UserSid = new.AdministratorKey and K.Expiration > now()))
);

-- Extension of ProposedAdministrator to associate a specific UserSid and include the user's signature
create table ProposedAdministratorUser (
	AuthoritySid text,
	AdministrationEffectiveAt text,
	ProposedName text,
	UserSid text,
	UserKey text,
	UserSignature text,
	primary key (AuthoritySid, AdministrationEffectiveAt, ProposedName),
	constraint ProposedAdministratorValid check (exists (select 1 from ProposedAdministrator PA where PA.AuthoritySid = new.AuthoritySid and PA.AdministrationEffectiveAt = new.AdministrationEffectiveAt and PA.ProposedName = new.ProposedName)),
	constraint UserSidValid check (exists (select 1 from User U where U.Sid = new.UserSid)),
	constraint UserKeyValid check (exists (select 1 from UserKey K where K.UserSid = new.UserSid and K.Key = new.UserKey and K.Expiration > now()))
	constraint CantDelete check on delete (false),
	constraint SignatureValid check (exists (select 1 from ProposedAdministrator PA
		where PA.AuthoritySid = new.AuthoritySid and PA.AdministrationRevision = new.AdministrationRevision and PA.ProposedName = new.ProposedName and PA.UserSid = new.UserSid and PA.SignerKey = new.SignerKey and PA.Signature = new.Signature
		-- and SignatureValid(
		-- 	Digest(new.AuthoritySid, new.AdministrationRevision, new.UserSid, PA.Title, PA.Scopes),
		-- 	Signature,
		-- 	SignerKey
		-- )
	)
);

create view InvitationType as select * from (values ('au', 'Authority'), ('ad', 'Administrator'), ('k', 'Keyholder'), ('r', 'Registrant')) as InvitationType(Code, Name);

create table InvitationSlot (
	Cid text,
	Type text,
	-- Name of person or authority for informational purpose and/or manually catch abuse
	Name text,
	Expiration text,
	InviteKey text, -- public key of temporary invitation key pair
	InviteSignature text,
	InviterKey text, -- public key of inviter
	InviterSignature text, -- signature of inviter on the invitation slot
	primary key (Cid),
	constraint TypeValid check (exists (select 1 from InvitationType IT where IT.Code = new.Type)),
	constraint ExpirationValid check (Expiration > now()),
	-- Prooves that the inviter has a valid private key corresponding to the public key in the invitation slot
	constraint InviteSignatureValid check (SignatureValid(Digest(Cid, Type, Name, Expiration), InviteSignature, InviteKey)),
	constraint InviterKeyValid check (exists (
		select 1 from UserKey K
			join Administrator A on A.UserSid = K.UserSid
			where K.Key = new.InviterKey and K.Expiration > now()
	)),
	constraint InviterSignatureValid check (SignatureValid(Digest(Cid, Type, Name, Expiration, InviteKey, InviteSignature), InviterSignature, InviterKey)),
	constraint InsertOnly check on update, delete (false)
)

create table InvitationSlotScope (
	SlotCid text,
	Scopes text, -- json array of strings
	primary key (SlotCid),
	constraint SlotCidValid check (exists (select 1 from InvitationSlot IS where IS.Cid = new.SlotCid)),
	-- TODO: look up the inviter administrator and verify that this represents a subset of their scopes
	-- constraint ScopesValid check (...),
	constraint InsertOnly check on update, delete (false)
)

-- Acceptance or rejection of invitation, created before resulting object
create table InvitationResult (
	SlotCid text primary key,
	IsAccepted boolean,
	InvitationSignature text,
);

create view UserKeyType (values ('M', 'Mobile'), ('Y', 'Yubico')) as UserKeyType(Code, Name);

create table UserKey (
	UserSid text, -- references future User.Sid
	Type text, -- references UserKeyType(Code)
	Key text,
	Expiration text,
	primary key (UserSid, Key),
	constraint SidValid check (
		not exists (select 1 from UserKey)
			or exists (
				select 1 from InvitationSlot IS
					join InvitationResult IR on IR.SlotCid = IS.Cid and IR.IsAccepted
					where IS.Cid = new.UserSid
			)
	),
	constraint ExpirationFuture check (Expiration > now()),
	constraint CantUpdate check on update (false)
);

create table User (
	Sid text, -- references InvitationSlot.Cid (of accepted invitation)
	Name text,
	ImageRef text null, -- json object { url?: string, cid?: string }
	SignerKey text,
	Signature text,
	primary key (Sid),
	constraint SidValid check (
		not exists (select 1 from User)
			or exists (
				select 1 from InvitationSlot IS
					join InvitationResult IR on IR.SlotCid = IS.Cid and IR.IsAccepted
					where IS.Cid = new.Sid
			)
	),
	constraint SignerKeyValid check (
		exists (select 1 from UserKey K where K.UserSid = new.Sid and K.Key = new.SignerKey and K.Expiration > now())
	),
	constraint SignatureValid check (SignatureValid(Digest(Sid, Name, ImageRef), Signature, SignerKey)),
	constraint CantDelete check on delete (false),
	constraint ValidModification check (new.Sid = old.Sid)
)
