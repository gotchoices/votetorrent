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
	AdministrationRevision integer,
	UserSid text,
	Title text,
	Scopes text default '[]', -- json array of strings
	SignerKey text,
	Signature text,
	primary key (AuthoritySid, AdministrationRevision, UserSid),
	constraint AuthoritySidValid check (exists (select 1 from Authority A where A.Sid = new.AuthoritySid)),
	constraint UserSidValid check (exists (select 1 from User U where U.Sid = new.UserSid)),
	constraint AdministrationValid check (exists (select 1 from Administration A where A.AuthoritySid = new.AuthoritySid and A.Revision = new.AdministrationRevision)),
	constraint InsertOnly check on update, delete (false),
	constraint ScopesValid check (not exists (select 1 from json_array_elements_text(Scopes) S(s) where s not in (select Code from Scope))),
	constraint SignerKeyValid check (exists (select 1 from UserKey K where K.UserSid = new.UserSid and K.Key = new.SignerKey and K.Expiration > now()))
	-- constraint SignatureValid check (SignatureValid(
	-- 	Digest(Sid, AuthoritySid, AdministrationRevision, UserSid, Title, Scopes),
	-- 	Signature,
	-- 	SignerKey)
	-- )
	-- TODO: transaction level constraint that Administrators and Administration are inserted together
	-- constraint AdministrationValid transaction check (exists (select 1 from Administration A where A.AuthoritySid = new.AuthoritySid and A.Revision = new.AdministrationRevision))
);

create index AdministratorUser on Administrator (UserSid); -- include (Scopes)

create table Administration (
	AuthoritySid text,
	Revision integer,
	Expiration text,
	ThresholdPolicies text default '[]', -- json array of { policy: string (Scope), threshold: integer }
	SignerKey text,
	Signature text,
	primary key (AuthoritySid, Revision),
	constraint Monotonicity check (
		Revision > 0
			and (Revision = 1 or Revision = (select max(Revision) from Administration A where A.AuthoritySid = new.AuthoritySid) + 1)
	),
	--constraint ThresholdPoliciesValid check (...), -- TODO: constraint
	constraint AuthoritySidValid check (exists (select 1 from Authority A where A.Sid = new.AuthoritySid)),
	constraint InsertOnly check on update, delete (false),
	constraint ExpirationFuture check (Expiration > now())
	-- TODO: If prior administration, SignerKey is threshold public key of prior administration, otherwise it's the threshold public key of the current (new) administration
	--constraint SignerKeyValid check (Revision = 1 or SignerKey ...),
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

-- TODO: create table ProposedAdministration & ProposedAdministrator
-- Note: proposed aren't dependencies, just a workflow for constructing a fully signed admin

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
