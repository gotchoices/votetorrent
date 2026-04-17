import { expect } from 'aegir/chai';
import { parseAll } from '@quereus/quereus/parser';
import { transpileQuereusAstToTypeql } from '../src/qsql-to-typeql.js';

export const ast = parseAll(`
	declare schema main

{
	view ElectionType as select * from (values ('o', 'Official'), ('a', 'Adhoc')) as ElectionType(Code, Name);

	table Network (
		Id text, -- 32 byte random id
		Hash text, -- H16(Id)
		PrimaryAuthorityId text,
		Name text,
		ImageRef text null, -- json object { url?: string, cid?: string }
		Relays text, -- json array of strings - TODO: constraint
		TimestampAuthorities text, -- json array of { url: string } - TODO: constraint
		NumberRequiredTSAs integer default 0,
		ElectionType text, -- references ElectionType(Code)
		primary key (),
		constraint CantDelete check on delete (false),
		constraint IdImmutable check on update (new.Id = old.Id),
		-- TODO: constraint HashValid check on insert (Hash = H16(Id)),
		constraint HashImmutable check on update (new.Hash = old.Hash),
		constraint PrimaryAuthorityIdImmutable check on update (new.PrimaryAuthorityId = old.PrimaryAuthorityId),
		constraint PrimaryAuthorityIdValid check on insert (exists (select 1 from Authority A where A.Id = new.PrimaryAuthorityId)),
		-- TODO: constraint ImageRefValid check (ImageRef is a valid image reference JSON)
		-- TODO: constraint RelaysValid check (Relays is a valid array of strings)
		-- TODO: constraint TimestampAuthoritiesValid check (TimestampAuthorities is a valid array of { url: string })
		constraint NumberRequiredTSAsValid check (NumberRequiredTSAs >= 0 and typeof(new.NumberRequiredTSAs) = 'integer'),
		constraint ElectionTypeValid check (ElectionType in (select Code from ElectionType)),
		constraint NoSigningNonceOnInsert check on insert (SigningNonce is null),
		constraint UpdateNetworkValid check on update (
				context.SigningNonce is not null
				and exists (
					select 1 from AdminSignature ASig join AdminSigning A on A.Nonce = ASig.SigningNonce
						where A.Nonce = context.SigningNonce
							-- Only the primary authority can update the network
							and A.AuthorityId = new.PrimaryAuthorityId
							and A.Scope = 'rn'
							and A.Digest = Digest(
								Tid, new.Id, new.Name, new.ImageRef, new.Relays, new.TimestampAuthorities, new.NumberRequiredTSAs, new.ElectionType
							)
			)
		)
	)
		with context ( SigningNonce text null, Tid int );

	view Scope as select * from (values
		('rn', 'Revise Network'),
		('rad', 'Revise or replace the Admin'),
		('vrg', 'Validate registrations'),
		('iad', 'Invite other Authorities'),
		('uai', 'Update Authority Information'),
		('ceb', 'Create/Edit ballot templates'),
		('mel', 'Manage Elections'),
		('cap', 'Configure Authority Peers')
	) as Scope(Code, Name);

	table Authority (
		Id text primary key, -- 32 byte random id
		Name text,
		DomainName text null,
		ImageRef text null, -- json object { url?: string, cid?: string }
		constraint CantDelete check on delete (false),
		constraint AdminRequired check on insert (exists (select 1 from Admin A where A.AuthorityId = new.Id)),
		constraint IdImmutable check on update (new.Id = old.Id),
		-- TODO: constraint ImageRefValid check (ImageRef is a valid image reference JSON)
		constraint InsertValid check on insert (
			-- Very first authority in the network - shoe-in, no Invite, no signing
			(context.SigningNonce is null and context.InviteSignature is null and not exists (select 1 from Authority))
				-- or Valid Invite for this authority
				or (InviteSlotCid is not null and InviteSignature is not null
					and exists (
						select 1 from InviteResult I where I.SlotCid = InviteSlotCid and I.IsAccepted
							and I.Digest = Digest(
								Tid, new.Id, new.Name, new.DomainName, new.ImageRef
							)
					)
				)
		),
		constraint UpdateValid check on update (
			SigningNonce is not null and InviteSlotCid is null and InviteSignature is not null
			and exists (
				select 1 from AdminSignature ASig join AdminSigning A on A.Nonce = ASig.SigningNonce
					where A.Nonce = context.SigningNonce
						and A.Scope = 'uai'
						and A.Digest = Digest(
							Tid, new.Name, new.DomainName, new.ImageRef
						)
			)
		),
	)
		with context ( SigningNonce text null, InviteSlotCid text null, InviteSignature text null, Tid int );
	-- Tid is assumed to be a unique transaction identifier that ensures that an update can''t be repeated with the same credentials. Provided internally, not by the user

	-- Administration
	table Admin (
		AuthorityId text,
		EffectiveAt datetime,
		ThresholdPolicies text default '[]', -- json array of { scope: string, threshold: integer } - if not set for a scope, 1 is assumed
		primary key (AuthorityId, EffectiveAt),
		constraint OfficerRequired check on insert (
			exists (select 1 from Officer O where O.AuthorityId = new.AuthorityId and O.AdminEffectiveAt = new.EffectiveAt
				and exists (select scope from json_array_elements_text(O.Scopes) S(s) where s = 'rad')
			)
		),
		constraint AuthorityIdValid check (exists (select 1 from Authority A where A.Id = new.AuthorityId)),
		constraint EffectiveAtValid check (isISODatetime(EffectiveAt) and endswith(EffectiveAt, 'Z')),
		-- TODO: constraint ThresholdPoliciesValid check (valid json array of { scope: string, threshold: integer }),
		constraint MutationValid check (
			-- Initial admin for the first authority - no invite, no signing
			(
				SigningNonce is null and InviteSlotCid is null and InviteSignature is null
					and old.AuthorityId is null -- an insertion
					and not exists (select 1 from Authority where Id <> new.AuthorityId)
			)
				-- or, if an invite is present this is a new authority - invite is valid
				or (
					SigningNonce is null and InviteSlotCid is not null and InviteSignature is not null
						and old.AuthorityId is null -- an insertion
						and exists (
							select 1 from InviteResult I join Authority A on A.Id = new.AuthorityId
							where I.SlotCid = InviteSlotCid and I.IsAccepted
								and I.Digest = Digest(
									Tid, A.Id, A.Name, A.DomainName, A.ImageRef,
									(select DigestAll(Digest(EffectiveAt, ThresholdPolicies)) over (order by EffectiveAt)
											from Admin A where A.AuthorityId = new.AuthorityId and A.EffectiveAt = new.EffectiveAt),
									(select DigestAll(Digest(AdminEffectiveAt, UserId, Title, Scopes)) over (order by AdminEffectiveAt, UserId)
										from Officer O where O.AuthorityId = new.AuthorityId and O.AdminEffectiveAt = new.EffectiveAt)
								)
						)
				)
				-- or, if a signing nonce is present this is a new or updated administration for existing authority - signing nonce is valid
				or (
					SigningNonce is not null and InviteSlotCid is null and InviteSignature is null
						and exists (
							select 1 from AdminSignature ASig join AdminSigning A on A.Nonce = ASig.SigningNonce
								where A.Nonce = context.SigningNonce
									and A.Digest = Digest(
										Tid, AuthorityId,
										(select DigestAll(Digest(EffectiveAt, ThresholdPolicies)) over (order by EffectiveAt)
												from Admin Ad where Ad.AuthorityId = new.AuthorityId and Ad.EffectiveAt = new.EffectiveAt),
										(select DigestAll(Digest(AdminEffectiveAt, UserId, Title, Scopes)) over (order by AdminEffectiveAt, UserId)
												from Officer O where O.AuthorityId = new.AuthorityId and O.AdminEffectiveAt = new.EffectiveAt)
									)
						)
				)
		),
	)
		with context ( SigningNonce text null, InviteSlotCid text null, InviteSignature text null, Tid int );

	view CurrentAdmin as
		select AuthorityId, max(EffectiveAt) as EffectiveAt
			from Admin
			where EffectiveAt <= datetime('now')
			group by AuthorityId;

	table Officer (
		AuthorityId text,
		AdminEffectiveAt datetime,
		UserId text,
		Title text,
		Scopes text default '[]', -- json array of strings
		primary key (AuthorityId, AdminEffectiveAt, UserId),
		-- NOT NEEDED - AuthorityId is validated through Admin
		constraint AuthorityIdValid check (exists (select 1 from Authority A where A.Id = new.AuthorityId)),
		constraint AdminValid check (exists (select 1 from Admin A where A.AuthorityId = new.AuthorityId and A.EffectiveAt = new.AdminEffectiveAt)),
		constraint UserIdValid check (exists (select 1 from User U where U.Id = new.UserId)),
		constraint ScopesValid check (not exists (select 1 from json_array_elements_text(Scopes) S(s) where s not in (select Code from Scope))),
		constraint OnlyInsert check on update, delete (false),
		constraint InsertValid check on insert (
			-- part of the very first authority in the network - no invite, no signing
			(SigningNonce is null and InviteSlotCid is null and InviteSignature is null) -- and not exists (select 1 from Authority) TODO error
			-- part of the first admin for an authority - invite is valid
				or (SigningNonce is null and InviteSlotCid is not null and InviteSignature is not null
					and not exists (select 1 from Authority A where A.Id = new.AuthorityId)
						and exists (
							select 1 from InviteResult I join Authority A on A.Id = new.AuthorityId
							where I.SlotCid = InviteSlotCid and I.IsAccepted
								and I.Digest = Digest(
									Tid, A.Id, A.Name, A.DomainName, A.ImageRef,
									(select DigestAll(Digest(EffectiveAt, ThresholdPolicies)) over (order by EffectiveAt)
											from Admin A where A.AuthorityId = new.AuthorityId and A.EffectiveAt = new.AdminEffectiveAt),
									(select DigestAll(Digest(AdminEffectiveAt, UserId, Title, Scopes)) over (order by AdminEffectiveAt, UserId)
										from Officer O where O.AuthorityId = new.AuthorityId and O.AdminEffectiveAt = new.AdminEffectiveAt)
								)
						)
				)
				-- or, if a signing nonce is present this is a new or updated administration for existing authority - signing nonce is valid
				or (SigningNonce is not null and InviteSlotCid is null and InviteSignature is null
					and exists (
							select 1 from AdminSignature ASig join AdminSigning A on A.Nonce = ASig.SigningNonce
								where A.Nonce = context.SigningNonce
									and A.Digest = Digest(
										Tid, AuthorityId,
										(select DigestAll(Digest(EffectiveAt, ThresholdPolicies)) over (order by EffectiveAt)
												from Admin Ad where Ad.AuthorityId = new.AuthorityId and Ad.EffectiveAt = new.AdminEffectiveAt),
										(select DigestAll(Digest(AdminEffectiveAt, UserId, Title, Scopes)) over (order by AdminEffectiveAt, UserId)
												from Officer O where O.AuthorityId = new.AuthorityId and O.AdminEffectiveAt = new.AdminEffectiveAt)
									)
						)
				)
		),
	)
		with context ( SigningNonce text null, InviteSlotCid text null, InviteSignature text null, Tid int );

	index OfficerUser on Officer(UserId); -- include (Scopes)

	-- A signing "session" for an Admin
	table AdminSigning (
		Nonce text primary key, -- Random ID
		AuthorityId text,
		AdminEffectiveAt datetime,
		Scope text, -- references Scope(Code)
		Digest text, -- Content hash to be signed - Base64url encoded sha256
		UserId text, -- Officer who is instigator the signing session
		SignerKey text, -- Instigator's signing key
		Signature text, -- Instigator's signature of this row
		constraint InsertOnly check on update, delete (false),
		constraint ScopeValid check (exists (select 1 from Scope S where S.Code = new.Scope)),
		-- constraint UserIdValid check (exists (
		-- 	select 1 from Officer O
		-- 		where O.UserId = new.UserId
		-- 			and O.AdminEffectiveAt = new.AdminEffectiveAt
		-- 			and O.AuthorityId = new.AuthorityId
		-- )),
		-- constraint SignerKeyValid check (exists (select 1 from UserKey K where K.UserId = new.UserId and K.Key = new.SignerKey and K.Expiration > datetime('now'))),
		constraint SignatureValid check (SignatureValid(Digest(Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId), Signature, SignerKey))
	); --TODO fix signature

index AdminSigningDigest on AdminSigning (Digest);

	-- Officer''s signature on the signing session
	table OfficerSignature (
		SigningNonce text,
		UserId text,	-- Particular Officer
		SignerKey text,	-- User's particular signing key
		Signature text,	-- User's signature of the digest
		primary key (SigningNonce, UserId),
		constraint InsertOnly check on update, delete (false),
		-- Key is valid for the user and the UserId is valid
		-- constraint SignerKeyValid check (
		-- 	exists (select 1 from UserKey K where K.UserId = new.UserId and K.Key = new.SignerKey and K.Expiration > datetime('now'))
		-- ),
		-- User is an Officer with the required scope
		-- constraint OfficerValid check (
		-- 	exists (select 1 from AdminSigning ADS
		-- 		join Officer O on O.AuthorityId = ADS.AuthorityId and O.AdminEffectiveAt = ADS.AdminEffectiveAt
		-- 		where ADS.Nonce = new.SigningNonce
		-- 			and O.UserId = new.UserId
		-- 			and ADS.Scope in (select policy from json_array_elements_text(O.Scopes) S(s) where s = new.Scope)
		-- 	)
		-- ),
		constraint SignatureValid check (exists (
			select 1 from AdminSigning ADS
				where ADS.Nonce = new.SigningNonce
					and SignatureValid(ADS.Digest, Signature, SignerKey)
		))
	);

	-- The final Admin signature output - only exists if required threshold of signatures are met - exists to avoid long validation
	table AdminSignature (
		SigningNonce text primary key,
		constraint InsertOnly check on update, delete (false),
		-- Satisfies the threshold policies of the Admin for the given scope
		constraint SignatureValid check (
			(select count(*) from OfficerSignature OS where OS.SigningNonce = new.SigningNonce)
				>= (
					select threshold from Admin A
						join AuthoritySignature ATS on ATS.AuthorityId = A.AuthorityId and ATS.AdminEffectiveAt = A.EffectiveAt
						-- TODO: if threshold policy is missing, 1 is assumed
						cross join lateral json_array_elements_text(A.ThresholdPolicies) TP(tp) on tp.scope = ATS.Scope
						where ATS.Nonce = new.SigningNonce
				)
		)
	);

	table ProposedNetwork (
		Name text,
		ImageRef text null, -- json object { url?: string, cid?: string }
		Relays text, -- json array of strings - TODO: constraint
		TimestampAuthorities text, -- json array of { url: string } - TODO: constraint
		NumberRequiredTSAs integer default 0,
		ElectionType text, -- references ElectionType(Code)
		primary key (),
		-- TODO: constraint ImageRefValid check (ImageRef is a valid image reference JSON)
		-- TODO: constraint RelaysValid check (Relays is a valid array of strings)
		-- TODO: constraint TimestampAuthoritiesValid check (TimestampAuthorities is a valid array of { url: string })
		constraint NumberRequiredTSAsValid check (NumberRequiredTSAs >= 0 and typeof(new.NumberRequiredTSAs) = 'integer'),
		constraint ElectionTypeValid check (ElectionType in (select Code from ElectionType)),
		constraint UserValid check (
			exists (
				select 1 from Officer O
					join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
					join Network N on N.PrimaryAuthorityId = CA.AuthorityId
					join UserKey K on K.UserId = O.UserId and K.Key = context.UserKey and K.Expiration > datetime('now')
					where O.UserId = context.UserId
						and exists(select 1 from json_array_elements_text(O.Scopes) S(s) where s = 'rn')
						and SignatureValid(
							Digest(Tid, coalesce(new.Name, old.Name), coalesce(new.ImageRef, old.ImageRef), coalesce(new.Relays, old.Relays),
								coalesce(new.TimestampAuthorities, old.TimestampAuthorities), coalesce(new.NumberRequiredTSAs, old.NumberRequiredTSAs),
								coalesce(new.ElectionType, old.ElectionType)),
							context.Signature,
							context.UserKey
						)
			)
		),
		-- constraint TasksHandled	check (
		-- 	-- There must be an AdminSigning for rn whose digest matches this ProposedNetwork,
		-- 	-- and either the signing is fully completed (AdminSignature exists), or
		-- 	-- tasks exist for all other rn-scoped officers of the primary authority
		-- 	exists (
		-- 		select 1 from AdminSigning A
		-- 			join Network N on N.Name = coalesce(new.Name, old.Name) and N.PrimaryAuthorityId = A.AuthorityId
		-- 			where A.Scope = 'rn'
		-- 				and A.Digest = Digest(
		-- 					Tid,
		-- 					coalesce(new.Name, old.Name),
		-- 					coalesce(new.ImageRef, old.ImageRef),
		-- 					coalesce(new.Relays, old.Relays),
		-- 					coalesce(new.TimestampAuthorities, old.TimestampAuthorities),
		-- 					coalesce(new.NumberRequiredTSAs, old.NumberRequiredTSAs),
		-- 					coalesce(new.ElectionType, old.ElectionType)
		-- 				)
		-- 			and (
		-- 				exists (select 1 from AdminSignature ASig where ASig.SigningNonce = A.Nonce)
		-- 				or not exists (
		-- 					-- find any rn-scoped officer in this admin epoch (excluding instigator)
		-- 					-- who does NOT have a corresponding open task + NetworkSignatureTaskExtension
		-- 					select 1 from Officer O
		-- 						where O.AuthorityId = A.AuthorityId
		-- 							and O.AdminEffectiveAt = A.AdminEffectiveAt
		-- 							and exists (select 1 from json_array_elements_text(O.Scopes) S(s) where s = 'rn')
		-- 							and O.UserId != A.UserId
		-- 							and not exists (
		-- 								select 1 from Task T
		-- 									join NetworkSignatureTaskExtension NX on NX.TaskId = T.Id
		-- 									where T.UserId = O.UserId
		-- 										and T.Type = 'signature'
		-- 										and T.SignatureType = 'network'
		-- 										and T.IsCompleted = false
		-- 										and T.SigningNonce = A.Nonce
		-- 										and NX.NetworkName = coalesce(new.Name, old.Name)
		-- 							)
		-- 				)
		-- 			)
		-- 	)
		-- )
	)
		with context ( UserId text, UserKey text, Signature text, Tid int );

	table ProposedAuthority (
		Id text primary key,
		Name text,
		DomainName text null,
		ImageRef text null, -- json object { url?: string, cid?: string }
		constraint AuthorityExists check on insert, update (exists (select 1 from Authority A where A.Id = new.Id)),
		constraint UserValid check (
			exists (
				select 1 from Officer O
					join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
					join UserKey K on K.UserId = O.UserId and K.Key = context.UserKey and K.Expiration > datetime('now')
					where O.UserId = context.UserId and O.AuthorityId = new.Id
						and exists(select 1 from json_array_elements_text(O.Scopes) S(s) where s = 'uai')
						and SignatureValid(
							Digest(Tid, coalesce(new.Id, old.Id), coalesce(new.Name, old.Name), coalesce(new.DomainName, old.DomainName),
								coalesce(new.ImageRef, old.ImageRef)),
							context.Signature,
							context.UserKey
						)
			)
		),
		-- constraint TasksHandled	check (
		-- 	-- if more signatures are required
		-- 	-- exists (

		-- 	-- )
		-- 	-- if a signature is present, no hanging tasks should be left
		-- 	not exists (
		-- 		select 1 from Task T join AdminSigning A on A.Nonce = T.SigningNonce
		-- 			join AdminSignature ASig on ASig.SigningNonce = A.Nonce
		-- 				where T.Id = new.TaskId and T.IsCompleted = false
		-- 	)
		-- )
	)
		with context ( UserId text, UserKey text, Signature text, Tid int );

	table ProposedAdmin (
		AuthorityId text,
		EffectiveAt datetime,
		ThresholdPolicies text default '[]', -- json array of { policy: string (Scope), threshold: integer }
		primary key (AuthorityId, EffectiveAt),
		constraint AuthorityIdValid check (exists (select 1 from Authority A where A.Id = new.AuthorityId)),
		constraint EffectiveAtValid check on insert, update (isISODatetime(EffectiveAt) and endswith(EffectiveAt, 'Z')),
		--constraint ThresholdPoliciesValid check (...), -- TODO: constraint
		constraint UserValid check (
			exists (
				select 1 from Officer O
					join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
					join UserKey K on K.UserId = O.UserId and K.Key = context.UserKey and K.Expiration > datetime('now')
					where O.UserId = context.UserId and O.AuthorityId = new.AuthorityId
						and exists(select 1 from json_array_elements_text(O.Scopes) S(s) where s = 'rad')
						and SignatureValid(
							Digest(Tid, coalesce(new.AuthorityId, old.AuthorityId),
								coalesce(new.EffectiveAt, old.EffectiveAt), coalesce(new.ThresholdPolicies, old.ThresholdPolicies)),
							context.Signature,
							context.UserKey
						)
			)
		),
	)
		with context ( UserId text, UserKey text, Signature text, Tid int );

	table ProposedOfficer (
		AuthorityId text,
		AdminEffectiveAt datetime,
		ProposedName text,
		Title text,
		Scopes text default '[]', -- json array of strings
		primary key (AuthorityId, AdminEffectiveAt, ProposedName),
		constraint AuthorityIdValid check (exists (select 1 from Authority A where A.Id = new.AuthorityId)),
		constraint AdminValid check (exists (select 1 from ProposedAdmin A where A.AuthorityId = new.AuthorityId and A.EffectiveAt = new.AdminEffectiveAt)),
		constraint CantDelete check on delete (false),
		constraint ScopesValid check (not exists (select 1 from json_array_elements_text(Scopes) S(s) where s not in (select Code from Scope))),
		constraint UserValid check (
			exists (
				select 1 from Officer O
					join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
					join UserKey K on K.UserId = O.UserId and K.Key = context.UserKey and K.Expiration > datetime('now')
					where O.UserId = context.UserId and O.AuthorityId = new.AuthorityId
						and exists(select 1 from json_array_elements_text(O.Scopes) S(s) where s = 'rad')
						and SignatureValid(
							Digest(Tid, coalesce(new.AuthorityId, old.AuthorityId), coalesce(new.AdminEffectiveAt, old.AdminEffectiveAt),
								coalesce(new.ProposedName, old.ProposedName), coalesce(new.Title, old.Title), coalesce(new.Scopes, old.Scopes)),
							context.Signature,
							context.UserKey
						)
			)
		),
	);
		with context ( UserId text, UserKey text, Signature text, Tid int );

	-- Possibly remove, since users must be associated with a keyholer or officer
	-- Extension of ProposedOfficer to associate a specific UserId and include the user''s signature
	table ProposedOfficerUser (
		AuthorityId text,
		AdminEffectiveAt datetime,
		ProposedName text,
		UserId text,
		UserKey text,
		UserSignature text,
		primary key (AuthorityId, AdminEffectiveAt, ProposedName),
		constraint ProposedOfficerValid check (exists (select 1 from ProposedOfficer PA where PA.AuthorityId = new.AuthorityId and PA.AdminEffectiveAt = new.AdminEffectiveAt and PA.ProposedName = new.ProposedName)),
		constraint UserIdValid check (exists (select 1 from User U where U.Id = new.UserId)),
		constraint UserKeyValid check (exists (select 1 from UserKey K where K.UserId = new.UserId and K.Key = new.UserKey and K.Expiration > datetime('now'))),
		constraint CantDelete check on delete (false),
		constraint SignatureValid check (exists (select 1 from ProposedOfficer PA
			where PA.AuthorityId = new.AuthorityId and PA.AdminRevision = new.AdminRevision and PA.ProposedName = new.ProposedName and PA.UserId = new.UserId and PA.SignerKey = new.SignerKey and PA.Signature = new.Signature
			-- and SignatureValid(
			-- 	Digest(new.AuthorityId, new.AdminRevision, new.UserId, PA.Title, PA.Scopes),
			-- 	Signature,
			-- 	SignerKey
			-- 	)
			)
		)
	);

	table InviteSlot (
		Cid text primary key,
		Name text, -- Name of invited person or authority for informational purpose and/or manually catch abuse
		Expiration datetime,
		InviteKey text, -- public key of temporary Invite key pair
		InviteSignature text,
		SigningNonce text, -- AdminSigning.Nonce, shows admin approval including scope (implies the type of invite, e.g. authority, officer, keyholder, registrant)
		constraint CidValid check (Cid = Digest(Name, Expiration, InviteKey, InviteSignature, SigningNonce)),
		constraint ExpirationValid check (Expiration > datetime('now')),
		-- Proves that the inviter has a valid private key corresponding to the public key in the Invite slot
		constraint InviteSignatureValid check (SignatureValid(Digest(Cid, Type, Name, Expiration), InviteSignature, InviteKey)),
		constraint InsertOnly check on update, delete (false),
		constraint InsertValid check on insert (
			SigningNonce is not null and exists (
				select 1 from AdminSigning SIG join AdminSignature ASig on ASig.SigningNonce = SIG.SigningNonce
					where SIG.SigningNonce = new.SigningNonce
						and SIG.Digest = Digest(Cid, Name, Expiration, InviteKey, InviteSignature)
			)
		)
	)
		with context ( Tid int );

	index InviteSlotSigningNonce on InviteSlot (SigningNonce, Cid);

	-- A single signing can encompass a batch of Invite slots, so validate the whole batch at once
	assertion InviteSlotSigningValid check (not exists (
		select 1 from (
			select SigningNonce, DigestAll(Cid) over (order by Cid) as Digest from InviteSlot I
		) SND
			where not exists (
				select 1 from AdminSigning SIG
					where SIG.SigningNonce = SND.SigningNonce and SIG.Digest = SND.Digest
			)
	));

	-- Acceptance or rejection of Invite, created before resulting object
	table InviteResult (
		SlotCid text primary key,
		IsAccepted boolean,	-- If Not accepted, Digest must be null
		Digest text null,	-- On whatever the invited party is intending to create - not validated here besides not null if IsAccepted
		InviteSignature text,	-- Signs H(SlotCid, Digest, IsAccepted)
		InvokedId text null,	-- ID of the object that will be invoked by the invitation - not validated here, this id is reserved for when the authority/user/ is created
		constraint InsertOnly check on update, delete (false),
		constraint SigningValid check (exists (
			select 1 from InviteSlot I
				join AdminSignature SIG on SIG.Nonce = I.SigningNonce
				where I.Cid = new.SlotCid)
		),
		constraint SignatureValid check (exists (
			select 1 from InviteSlot S
				where S.Cid = new.SlotCid and SignatureValid(Digest(SlotCid, Digest, IsAccepted), new.InviteSignature, S.InviteKey)
		)),
		constraint DigestValid check (
			(not IsAccepted and new.Digest is null)
				or (IsAccepted and new.Digest is not null)
		),
	);

	view AcceptedInvite as
		select IR.SlotCid, IR.IsAccepted, IR.Digest, IR.InviteSignature, SIG.Scope
			from InviteResult IR
			join InviteSlot S on S.Cid = IR.SlotCid
			join AdminSigning SIG on SIG.SigningNonce = S.SigningNonce
			where IR.IsAccepted;

	view UserKeyType as
		select Code, Name from (values ('M', 'Mobile'), ('Y', 'Yubico')) as UserKeyType(Code, Name);

	table User (
		Id text primary key, -- Random ID
		Name text,
		ImageRef text null, -- json object { url?: string, cid?: string }
		constraint UserValid check (
			-- Must be associated with a keyholder
			exists (select 1 from Keyholder K where K.UserId = new.UserId)
				-- or must be associated with an officer
				or exists (select 1 from Officer O where O.UserId = new.UserId)
		),
		constraint UserKeyValid check (
			-- Must be a non-expired key for the user
			exists (select 1 from UserKey K where K.UserId = new.UserId)
		),
		constraint CantDelete check on delete (false),
		constraint ValidModification check (new.Id = old.Id),
		-- TODO add check for valid update
		constraint InsertValid check on insert (
			-- First user in the network - no invite, no signing
			(SigningNonce is null and InviteSlotCid is null and InviteSignature is null and (select count(*) from User) = 1)
				-- or Valid Invite for this user
				or (SigningNonce is null and InviteSlotCid is not null and InviteSignature is not null
					and exists (
						select 1 from InviteSlot I where I.Cid = InviteSlotCid and I.InviteSignature = InviteSignature
					)
				)
		),
	);
		with context (SigningNonce text null, InviteSlotCid text null, InviteSignature text null, Tid int);

	table UserKey (
		UserId text, -- references future User.Id
		Type text, -- references UserKeyType(Code)
		PubKey text, -- paired private key is stored on the user''s device
		Expiration datetime,
		primary key (UserId, PubKey),
		constraint UserIdValid check (
			exists (select 1 from User U where U.Id = new.UserId)
		),
		-- constraint InsertValid check on insert (
		-- 	(
		-- 		not exists (select 1 from UserKey K where K.UserId = new.UserId)
		-- 		and context.UserKey is null
		-- 	)
		-- 	or exists (
		-- 		select 1
		-- 		from UserKey K
		-- 		where K.UserId = new.UserId
		-- 			and K.PubKey = context.UserKey
		-- 			and K.Expiration > datetime('now')
		-- 	)
		-- ),
		constraint DeleteValid check on delete (
				-- must be a non-expired key for the user
				exists (select 1 from UserKey K where K.UserId = old.UserId and K.PubKey = context.UserKey and K.Expiration > datetime('now'))
					-- and not the last key for the user
					and exists (select 1 from UserKey K where K.UserId = old.UserId and K.PubKey <> old.PubKey)
		),
		constraint SignatureValid check
			-- first key for the user
			(UserKey is null
			or SignatureValid(
				Digest(Tid, coalesce(old.UserId, new.UserId), coalesce(old.Type, new.Type),
					coalesce(old.PubKey, new.PubKey), coalesce(old.Expiration, new.Expiration)),
				Signature,
				UserKey)
			),
		constraint NoUpdate check on update (false),
		constraint ExpirationFuture check (Expiration > datetime('now')),
	)
		with context ( UserKey text null, Signature text null, Tid int );


}

apply schema main;

	`);

describe('qsql-to-typeql', () => {
	let typeql: string;

	before(() => {
		typeql = transpileQuereusAstToTypeql(ast);
	});

	describe('structure', () => {
		it('starts with define block', () => {
			expect(typeql.trimStart()).to.match(/^define/);
		});

		it('declares attribute types section', () => {
			expect(typeql).to.include('# ATTRIBUTE TYPES');
		});

		it('declares entity types section', () => {
			expect(typeql).to.include('# ENTITY TYPES');
		});

		it('declares relation types section', () => {
			expect(typeql).to.include('# RELATION TYPES');
		});
	});

	describe('attributes', () => {
		it('maps text columns to string attributes', () => {
			expect(typeql).to.include('attribute name, value string;');
		});

		it('maps integer columns to integer attributes', () => {
			expect(typeql).to.include('attribute number_required_tsas, value integer;');
		});

		it('maps datetime columns to datetime-tz attributes', () => {
			expect(typeql).to.include('attribute effective_at, value datetime-tz;');
		});

		it('maps boolean columns to boolean attributes', () => {
			expect(typeql).to.include('attribute is_accepted, value boolean;');
		});
	});

	describe('entities', () => {
		it('emits entity for each table', () => {
			expect(typeql).to.include('entity authority,');
			expect(typeql).to.include('entity network,');
			expect(typeql).to.include('entity admin,');
			expect(typeql).to.include('entity officer,');
			expect(typeql).to.include('entity user_key,');
		});

		it('uses @key for single-column primary key', () => {
			expect(typeql).to.include('entity authority,');
			expect(typeql).to.match(/entity authority,[\s\S]*?owns id @key/);
		});

		it('uses surrogate key for composite or missing primary key', () => {
			expect(typeql).to.include('owns network_key @key');
			expect(typeql).to.include('owns admin_key @key');
			expect(typeql).to.include('owns officer_key @key');
			expect(typeql).to.include('owns user_key_key @key');
		});

		it('owns all non-key columns as attributes', () => {
			expect(typeql).to.match(/entity authority,[\s\S]*?owns name/);
			expect(typeql).to.match(/entity admin,[\s\S]*?owns threshold_policies/);
		});
	});

	describe('relations', () => {
		it('infers relation from authority_id column on admin', () => {
			expect(typeql).to.include('relation admin_authority,');
		});

		it('infers relation from authority_id column on officer', () => {
			expect(typeql).to.include('relation officer_authority,');
		});

		it('infers relation from user_id column on officer', () => {
			expect(typeql).to.include('relation officer_user,');
		});

		it('infers relation from user_id column on user_key', () => {
			expect(typeql).to.include('relation user_key_user,');
		});

		it('emits relates lines for each role', () => {
			expect(typeql).to.match(/relation admin_authority,[\s\S]*?relates admin/);
			expect(typeql).to.match(/relation admin_authority,[\s\S]*?relates authority/);
		});

		it('emits plays lines on the corresponding entities', () => {
			expect(typeql).to.match(/entity admin,[\s\S]*?plays admin_authority:admin/);
			expect(typeql).to.match(/entity authority,[\s\S]*?plays admin_authority:authority/);
		});
	});
});
