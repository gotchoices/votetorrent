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
	SigningNonce text null,
	primary key (Sid),
	--constraint NewSidValid check on insert (Sid = Digest(Name, DomainName, ImageRef)),
	constraint SidImmutable check on update (new.Sid = old.Sid),
	constraint CantDelete check on delete (false),
	constraint NoSigningNonceOnInsert check on insert (SigningNonce is null),
	constraint NewAuthorityValid check on insert (
		-- Very first authority in the network - shoe-in, no invitation
		not exists (select 1 from Authority)
			-- Valid invitation for this authority
			or exists (select 1 from InvitationResult IR join InvitationSlot InvS on InvS.Cid = IR.SlotCid
				where InvS.Type = 'au' and IR.InvokedSid = new.Sid)
	),
	constraint UpdateAuthorityValid check on update (
		exists (select 1 from AdministrationSigning ADS
			join AdministrationSignature
			where ADS.Nonce = new.SigningNonce)
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
	ThresholdPolicies text default '[]', -- json array of { scope: string, threshold: integer }
	SignerKey text,	-- The threshold public key of the current administration
	Signature text,
	primary key (AuthoritySid, EffectiveAt),
	-- Threshold policies are valid - the number of administrators for each scope is at least the threshold
	constraint ThresholdPoliciesValid check (
		not exists (select 1 from json_array_elements_text(ThresholdPolicies) TP(tp)
			where tp.threshold > (select count(*) from Administrator A
				where A.AuthoritySid = new.AuthoritySid and A.AdministrationEffectiveAt = new.EffectiveAt
					and tp.scope in (select policy from json_array_elements_text(A.Scopes) S(s) where s = tp.scope)
			)
		)
	),
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

-- A signing "session" for an administration
create table AdministrationSigning (
	Nonce text, -- Random ID
	AuthoritySid text,
	AdministrationEffectiveAt text,
	Scope text, -- references Scope(Code)
	Digest text, -- Content hash to be signed - Base64url encoded sha256
	UserSid text, -- Administrator who is initiating the signing session
	SignerKey text, -- Instigator's signing key
	Signature text, -- Instigator's signature of this row
	primary key (Nonce),
	constraint InsertOnly check on update, delete (false),
	constraint ScopeValid check (exists (select 1 from Scope S where S.Code = new.Scope))
	constraint UserSidValid check (exists (
		select 1 from Administrator A
			where A.UserSid = new.UserSid
				and A.AdministrationEffectiveAt = new.AdministrationEffectiveAt
				and A.AuthoritySid = new.AuthoritySid
	)),
	constraint SignerKeyValid check (exists (select 1 from UserKey K where K.UserSid = new.UserSid and K.Key = new.SignerKey and K.Expiration > now())),
	constraint SignatureValid check (SignatureValid(Digest(Nonce, AuthoritySid, AdministrationEffectiveAt, Scope, Digest, UserSid), Signature, SignerKey))
);

-- Administrator's signature on the signing session
create table AdministratorSignature (
	SigningNonce text,
	UserSid text,	-- Particular administrator
	SignerKey text,	-- User's particular signing key
	Signature text,	-- User's signature of the digest
	primary key (SigningNonce, UserSid),
	constraint InsertOnly check on update, delete (false),
	-- Key is valid for the user and the UserSid is valid
	constraint SignerKeyValid check (
		exists (select 1 from UserKey K where K.UserSid = new.UserSid and K.Key = new.SignerKey and K.Expiration > now())
	),
	-- User is an administrator with the required scope
	constraint AdministratorValid check (
		exists (select 1 from AdministrationSigning ADS
			join Administrator A on A.AuthoritySid = ADS.AuthoritySid and A.AdministrationEffectiveAt = ADS.AdministrationEffectiveAt
			where ADS.Nonce = new.SigningNonce
				 and A.UserSid = new.UserSid
				 and ADS.Scope in (select policy from json_array_elements_text(A.Scopes) S(s) where s = new.Scope)
		)
	),
	constraint SignatureValid check (exists (
		select 1 from AdministrationSigning ADS
			where ADS.Nonce = new.SigningNonce
				and SignatureValid(ADS.Digest, Signature, SignerKey)
	))
);

-- The final administration signature output - only exists if required threshold of signatures are met - exists to avoid long validation
create table AdministrationSignature (
	SigningNonce text,
	primary key (SigningNonce),
	constraint InsertOnly check on update, delete (false),
	-- Satisfies the threshold policies of the administration for the given scope
	constraint SignatureValid check (
		(select count(*) from AdministratorSignature ADS where ADS.SigningNonce = new.SigningNonce)
			>= (
				select threshold from Administration A
					join AuthoritySignature ATS on ATS.AuthoritySid = A.AuthoritySid and ATS.AdministrationEffectiveAt = A.EffectiveAt
					cross join lateral json_array_elements_text(A.ThresholdPolicies) TP(tp) on tp.scope = ATS.Scope
					where ATS.Nonce = new.SigningNonce
			)
	))
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
