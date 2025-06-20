create table Network (
	Sid text,
	Hash text,
	SignerKey text,
	Signature text,
	primary key (/* none - one row max */),
	constraint SignatureValid check (SignatureValid(Digest(Sid, Hash), Signature, SignerKey)),
	constraint HashValid check (Hash = Digest(Sid) % 65536),
	constraint InsertOnly check on update, delete (false)
);

create view ElectionType (values ('o', 'Official'), ('a', 'Adhoc')) as ElectionType(Code, Name);

create table NetworkRevision (
	NetworkSid text,
	Revision integer,
	Timestamp text,
	Name text,
	ImageRef text,
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

create table Authority (
	Sid text, -- Cid of first record for this authority
	Name text,
	DomainName text,
	ImageRef text null, -- json object { url?: string, cid?: string }
	SignerKey text,
	Signature text,
	primary key (Sid),
	constraint NewSidValid check on insert (Sid = Digest(Name, DomainName, ImageRef)),
	constraint SidImmutable check on update (new.Sid = old.Sid),
	constraint InvitationValid check on insert (
		not exists (select 1 from Authority)
			or exists (select 1 from InvitationResult IR where InvokedSid = new.Sid)
	),
	constraint InvitationUnused check on update (new.InvitationSid is not null),
	constraint CantDelete check on delete (false)
);

create view InvitationType (values ('au', 'Authority'), ('ad', 'Administrator'), ('k', 'Keyholder')) as InvitationType(Code, Name);

create table InvitationSlot (
	Cid text,
	Type text,
	Expiration text,
	InviteKey text, -- public key of temporary invitation key pair
	InviteSignature text,
)

create table InvitationResult (
	SlotCid text primary key,
	UserSid text,
	IsAccepted boolean,
	InvokedSid text,
	InvitationSignature text,
	UserSignerKey text,
	UserSignature text,

)