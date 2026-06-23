const STRAND_SCHEMA = `    table Header (
        Id text,    -- UUID of this network - generated at inception - immutable

        -- Types: 'o' = Open, 'c' = Closed
        -- Any peers can join an open network, but only members can join a closed network
        -- Open can still control writes in the app, but only Closed prevents reads
        Type text check (Type in ('o', 'c')),

        -- The app that this strand faciliates - public key from author to prevent tampering
        sAppId text,

        -- The version of the sApp that this strand faciliates
        sAppVersion text,

        -- The schema of the sApp that this strand faciliates
        sAppSchema text,

        -- The author's signature on the schema to guarantee authorship
        sAppSignature text,

        -- The engine (rules logic system) that is assumed to manage this strand
        Engine text,

        -- The version of the engine that is assumed to manage this strand
        EngineVersion text,

        primary key (/* empty - singleton */),
        constraint InsertOnly check on update, delete (false),  -- One-time insert only for now - TODO: revisit for versioning
    );

    -- An invitation to join a strand as a member
    table Invite (
        Key text primary key,
        Expiration datetime null,
        -- TODO: ability to deactivate?
        constraint InsertOnly check on update, delete (false),
        constraint OnlyClosed check (
            exists (select 1 from Header H where H.Type = 'c')
        ),
        constraint InviteValid check on insert (
            -- Can only be inserted by an authority,
            exists (select 1 from Authority A
                where A.MemberKey = context.AuthorityKey
                    and verify(digest(new.Key || '|' || coalesce(new.Expiration, ''), 'sha256', 'utf8'), context.AuthoritySignature, A.MemberKey, 'ed25519')
            )
                -- and must also prove invite private key held by issuing authority
                and verify(digest(new.Key || '|' || coalesce(new.Expiration, ''), 'sha256', 'utf8'), context.InviteSignature, new.Key, 'ed25519')
        )
    ) with context (AuthorityKey text null, AuthoritySignature text null, InviteSignature text null);

    -- Invite [InviteKey] has been used to add [MemberKey] as a member
    table ConsumedInvite (
        InviteKey text primary key,
        MemberKey text,
        constraint InsertOnly check on update, delete (false),
        constraint InviteExists check (exists (select 1 from Invite I where I.Key = new.InviteKey)),
        constraint MemberExists check (exists (select 1 from Member M where M.Key = new.MemberKey)),
        constraint ValidUsage check on insert (
            exists (select 1 from Invite I where I.Key = new.InviteKey and verify(digest(new.InviteKey || '|' || new.MemberKey, 'sha256', 'utf8'), context.InviteSignature, new.InviteKey, 'ed25519'))
        ),
        constraint MemberValid check (exists (select 1 from Member M where M.Key = new.MemberKey))
    ) with context (InviteSignature text null);

    -- A party in the closed strand network
    table Member (
        Key text primary key,
        constraint NoUpdate check on update (false),
        constraint OnlyClosed check (
            exists (select 1 from Header H where H.Type = 'c')
        ),
        constraint Authorized check on insert (
            -- There are no other records - first member needs no authorization
            (select count(1) from Member) <= 1

                -- or added directly by authority
                or exists (
                    select 1 from Authority A
                        where A.MemberKey = context.AuthorityKey
                            and verify(digest(new.Key, 'sha256', 'utf8'), context.AuthoritySignature, A.MemberKey, 'ed25519')
                )

                -- or added by invite
                or exists (
                    select 1 from ConsumedInvite CI where CI.MemberKey = new.Key
                )
        ),
        -- TODO: handle member revocation constraint
    ) with context (AuthorityKey text null, AuthoritySignature text null);

    -- A member-associated peer (node)
    table MemberPeer (
        MemberKey text,
        PeerId text,
        primary key (MemberKey, PeerId),
        constraint MemberExists check (exists (select 1 from Member M where M.Key = new.MemberKey)),
        constraint Authorized check (
            verify(
                digest(coalesce(new.MemberKey, old.MemberKey) || '|' || coalesce(new.PeerId, old.PeerId), 'sha256', 'utf8'),
                context.Signature,
                coalesce(new.MemberKey, old.MemberKey),
                'ed25519'
            )
        ),
    ) with context (Signature text null);

    -- An authority is a member that can issue invites, authorize members, and rotate authorities
    table Authority (
        MemberKey text primary key,
        constraint OnlyClosed check (
            exists (select 1 from Header H where H.Type = 'c')
        ),
        constraint Authorized check (
            -- There are no existing records - first authority needs no authorization
            (select count(1) from Authority) <= 1

                -- or authorized by this former authority
                or (
                    old.MemberKey is not null
                        and old.MemberKey = context.AuthorityKey
                        and verify(digest(old.MemberKey, 'sha256', 'utf8'), context.Signature, old.MemberKey, 'ed25519')
                )

                -- or authorized by another existing authority
                or exists (
                    select 1 from Authority A
                        where A.MemberKey = context.AuthorityKey
                            and verify(digest(coalesce(new.MemberKey, old.MemberKey), 'sha256', 'utf8'), context.Signature, A.MemberKey, 'ed25519')
                )
        )
    ) with context (AuthorityKey text null, Signature text null);
`;
export {
  STRAND_SCHEMA
};
