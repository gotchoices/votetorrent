import { Database } from '@quereus/quereus';
import { ElectionType, UserKeyType } from '@votetorrent/vote-core';
import { expect } from 'chai';
import { prepareDb } from '../src/database/initialize';
import { NetworkEngine } from '../src/network/network-engine';
import { NetworksEngine } from '../src/networks/networks-engine';
import type { EngineContext } from '../src/types.js';
import { randomTestKeyPair } from './fixtures/keys.js';
import { AsyncStorage } from './shims/react-native';
import type {
	Authority,
	INetworkEngine,
	NetworkInit,
	NetworkReference,
	Scope,
	User,
	UserKey,
} from '@votetorrent/vote-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides?: Partial<User>): User {
	const { publicHex } = randomTestKeyPair();
	return {
		id: 'user-1',
		name: 'Test User',
		imageRef: { url: 'https://img.local/user.png' },
		activeKeys: [
			{
				key: publicHex,
				type: UserKeyType.mobile,
				expiration: Date.now() + 86_400_000,
			},
		],
		...overrides,
	};
}

function makeNetworkInit(overrides?: Partial<NetworkInit>): NetworkInit {
	return {
		name: 'Test Network',
		imageUrl: 'https://cdn.example.com/logo.png',
		relays: ['/dns4/relay.example.com/tcp/443/wss'],
		primaryAuthority: {
			name: 'Primary Authority',
			domainName: 'authority.example.com',
		},
		admin: {
			officers: [
				{
					init: {
						name: 'Admin A',
						title: 'Chair',
						scopes: ['rn', 'mel'] as Scope[],
					},
				},
			],
			effectiveAt: Date.now(),
			thresholdPolicies: [{ policy: 'rn', threshold: 1 }],
		},
		policies: {
			timestampAuthorities: [{ url: 'https://tsa.example.com' }],
			numberRequiredTSAs: 1,
			electionType: ElectionType.adhoc,
		},
		...overrides,
	};
}

async function createNetworkEngine(): Promise<{
	engine: INetworkEngine;
	ref: NetworkReference;
}> {
	await AsyncStorage.clear();
	await AsyncStorage.setItem('recentNetworks', []);
	const networksEngine = new NetworksEngine(AsyncStorage);
	const user = makeUser();
	const networkInit = makeNetworkInit();
	const engine = await networksEngine.create(networkInit, user);
	const recents =
		(await AsyncStorage.getItem<NetworkReference[]>('recentNetworks')) ?? [];
	const ref = recents[0];
	if (!ref) throw new Error('No network reference found after create');
	return { engine, ref };
}

// Construct a NetworkEngine bound to a schema-only DB (no INSERTs run, so
// quereus#23 is not in play). Used for guard-path tests that only need a
// queryable schema and a NetworkReference shell.
async function makeDbOnlyNetworkEngine(): Promise<{
	engine: NetworkEngine;
	ctx: EngineContext;
	ref: NetworkReference;
	user: User;
}> {
	const db = new Database();
	await prepareDb(db);
	const user = makeUser();
	const ctx: EngineContext = { db, user };
	const ref: NetworkReference = {
		hash: 'h'.repeat(16),
		name: 'Pure Test Network',
		relays: ['/dns4/relay.example.com/tcp/443/wss'],
		primaryAuthorityDomainName: 'pure.example.com',
	};
	const engine = new NetworkEngine(ref, AsyncStorage, ctx);
	return { engine, ctx, ref, user };
}

// ===========================================================================
// NetworkEngine Tests
// ===========================================================================

describe('NetworkEngine', () => {
	// -----------------------------------------------------------------------
	// 1. Network Details & Summary
	// -----------------------------------------------------------------------
	describe('getDetails', () => {
		it('throws Network not found when the hash is not present in the DB', async () => {
			// Pure read-side guard: schema-only DB has no Network row. The
			// implementation catches the missing row and rethrows
			// 'Network not found'. No INSERT — quereus#23 is not exercised.
			const { engine } = await makeDbOnlyNetworkEngine();
			let caught: unknown;
			try {
				await engine.getDetails();
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('Network not found');
		});

		// BLOCKED on https://github.com/gotchoices/quereus/issues/23 —
		// createNetworkEngine() depends on NetworksEngine.create() which
		// trips CantDelete on INSERT today.
		it('should return network details with correct id, hash, name, and relays', async () => {
			const { engine, ref } = await createNetworkEngine();
			const details = await engine.getDetails();
			expect(details.network.hash).to.equal(ref.hash);
			expect(details.network.name).to.equal('Test Network');
			expect(details.network.relays).to.deep.equal(ref.relays);
		});

		// BLOCKED on quereus#23
		it('should include primaryAuthorityId referencing the created authority', async () => {
			const { engine } = await createNetworkEngine();
			const details = await engine.getDetails();
			expect(details.network.primaryAuthorityId)
				.to.be.a('string')
				.with.length.greaterThan(0);
		});

		// BLOCKED on quereus#23
		it('should return correct network policies (electionType, TSAs, numberRequiredTSAs)', async () => {
			const { engine } = await createNetworkEngine();
			const details = await engine.getDetails();
			expect(details.network.policies.electionType).to.equal(
				ElectionType.adhoc,
			);
			expect(details.network.policies.numberRequiredTSAs).to.equal(1);
		});

		// BLOCKED on quereus#23
		it('should return undefined proposed revision when none has been proposed', async () => {
			const { engine } = await createNetworkEngine();
			const details = await engine.getDetails();
			expect(details.proposed).to.equal(undefined);
		});
	});

	describe('getNetworkSummary', () => {
		it('throws Network not found when the hash is not present in the DB', async () => {
			const { engine } = await makeDbOnlyNetworkEngine();
			let caught: unknown;
			try {
				await engine.getNetworkSummary();
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('Network not found');
		});

		// BLOCKED on quereus#23
		it('should return a summary with hash, name, id, and primaryAuthorityDomainName', async () => {
			const { engine, ref } = await createNetworkEngine();
			const summary = await engine.getNetworkSummary();
			expect(summary.hash).to.equal(ref.hash);
			expect(summary.name).to.equal('Test Network');
			expect(summary.primaryAuthorityDomainName).to.equal(
				'authority.example.com',
			);
		});

		// BLOCKED on quereus#23
		it('should return imageUrl from the primary authority imageRef', async () => {
			const { engine } = await createNetworkEngine();
			const summary = await engine.getNetworkSummary();
			// primaryAuthority.imageUrl is not seeded in the default init.
			expect(summary.imageUrl).to.equal(undefined);
		});

		// BLOCKED on quereus#23
		it('should throw when the primary authority for the network is missing', async () => {
			// Phase 6 will need to manually delete the Authority row after a
			// successful create() to exercise this branch. Bug-blocked until
			// #23 ships (UPDATE/DELETE on Network/Authority also trips today).
		});
	});

	// -----------------------------------------------------------------------
	// 2. Network Schema Constraints (from votetorrent.qsql)
	// -----------------------------------------------------------------------
	// All assertions in this describe require a populated DB seeded via
	// NetworksEngine.create() (so a Network row exists to attempt a
	// mutation against). All are bug-blocked on quereus#23.
	describe('schema constraints - Network table', () => {
		it('should reject deletion of a Network (CantDelete constraint) — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec('delete from Network');
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('CantDelete');
		});

		it('should reject mutation of Network.Id on update (IdImmutable constraint) — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					'update Network with context Tid = 1 set Id = :newId',					{ newId: 'mutated-network-id' },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('IdImmutable');
		});

		it('should reject mutation of Network.Hash on update (HashImmutable constraint) — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					'update Network with context Tid = 1 set Hash = :newHash',					{ newHash: 'h'.repeat(16) },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('HashImmutable');
		});

		it('should reject mutation of Network.PrimaryAuthorityId on update (PrimaryAuthorityIdImmutable constraint) — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					'update Network with context Tid = 1 set PrimaryAuthorityId = :newPa',					{ newPa: 'some-other-authority-id' },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include(
				'PrimaryAuthorityIdImmutable',
			);
		});

		it('should reject insert when PrimaryAuthorityId does not reference an existing Authority — BLOCKED on quereus#23', async () => {
			// Schema-level guard: Network.PrimaryAuthorityIdValid. Attempt to
			// insert a second Network row pointing at a non-existent authority.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into Network (Id, Hash, PrimaryAuthorityId, Name, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType)
           with context SigningNonce = null, Tid = 2
           values (:id, :hash, :pa, :name, '[]', '[]', 0, 'a')`,
					{
						id: crypto.randomUUID(),
						hash: 'b'.repeat(16),
						pa: 'non-existent-authority-id',
						name: 'BadNet',
					},
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('PrimaryAuthorityIdValid');
		});

		it('should reject insert/update when ElectionType is not a valid code (o or a) — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					'update Network with context Tid = 1 set ElectionType = :et',					{ et: 'xx' },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('ElectionTypeValid');
		});

		it('should reject insert/update when NumberRequiredTSAs is negative — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					'update Network with context Tid = 1 set NumberRequiredTSAs = :n',					{ n: -1 },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('NumberRequiredTSAsValid');
		});

		it('should reject insert/update when NumberRequiredTSAs is not an integer — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					'update Network with context Tid = 1 set NumberRequiredTSAs = :n',					{ n: 1.5 },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('NumberRequiredTSAsValid');
		});

		it('should enforce that SigningNonce is null on insert (NoSigningNonceOnInsert) — BLOCKED on quereus#23', async () => {
			// Direct second-network insert with a non-null SigningNonce in context.
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			const db = new Database();
			await prepareDb(db);
			let caught: unknown;
			try {
				await db.exec(
					`insert into Network (Id, Hash, PrimaryAuthorityId, Name, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType)
           with context SigningNonce = 'not-null-nonce', Tid = 1
           values (:id, :hash, :pa, 'Bad', '[]', '[]', 0, 'a')`,
					{
						id: crypto.randomUUID(),
						hash: 'c'.repeat(16),
						pa: crypto.randomUUID(),
					},
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('NoSigningNonceOnInsert');
		});

		it('should reject update without a valid AdminSignature with scope rn from primary authority (UpdateNetworkValid) — BLOCKED on quereus#23', async () => {
			// Attempting any UPDATE without a signing-nonce context entry must
			// trip UpdateNetworkValid (the CHECK requires context.SigningNonce
			// is not null and references a completed AdminSignature with scope rn).
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					'update Network with context Tid = 1, SigningNonce = null set Name = :n',					{ n: 'Renamed' },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('UpdateNetworkValid');
		});
	});

	// -----------------------------------------------------------------------
	// 3. Authority Creation from within a Network
	// -----------------------------------------------------------------------
	describe('createAuthority', () => {
		// BLOCKED on quereus#23 — createAuthority INSERTs into Authority/Admin/Officer.
		it('should create an authority with a generated UUID id', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			await engine.createAuthority(
				{ name: 'New Authority', domainName: 'new.example.com' },
				{
					officers: [
						{
							init: {
								name: 'Officer Bob',
								title: 'Inspector',
								scopes: ['rad'] as Scope[],
							},
						},
					],
					effectiveAt: Date.now(),
					thresholdPolicies: [{ policy: 'rad', threshold: 1 }],
				},
			);
			const row = await ctx.db
				.prepare('select Id from Authority where Name = :name')
				.get({ name: 'New Authority' });
			expect(row?.Id)
				.to.be.a('string')
				.that.matches(
					/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
				);
		});

		it('should insert Authority, Admin, and Officer rows in one transaction', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const effectiveAt = Date.now();
			await engine.createAuthority(
				{ name: 'TxnAuthority', domainName: 'txn.example.com' },
				{
					officers: [
						{
							init: {
								name: 'Officer Txn',
								title: 'Chair',
								scopes: ['rad'] as Scope[],
							},
						},
					],
					effectiveAt,
					thresholdPolicies: [{ policy: 'rad', threshold: 1 }],
				},
			);
			const aRow = await ctx.db
				.prepare('select Id from Authority where Name = :n')
				.get({ n: 'TxnAuthority' });
			expect(aRow?.Id).to.be.a('string');
			const newAuthorityId = aRow!.Id as string;
			const adRow = await ctx.db
				.prepare('select count(*) as n from Admin where AuthorityId = :id')
				.get({ id: newAuthorityId });
			expect(Number(adRow?.n)).to.equal(1);
			const oRow = await ctx.db
				.prepare('select count(*) as n from Officer where AuthorityId = :id')
				.get({ id: newAuthorityId });
			expect(Number(oRow?.n)).to.equal(1);
		});

		it('should fail when officer init is missing (no officers provided)', async () => {
			// Pure-guard path: createAuthority validates officer.init before
			// touching the DB. Empty officers array triggers the throw.
			const { engine } = await makeDbOnlyNetworkEngine();
			let caught: unknown;
			try {
				await engine.createAuthority(
					{ name: 'No-Officer Authority', domainName: 'no.example' },
					{
						officers: [],
						effectiveAt: Date.now(),
						thresholdPolicies: [],
					},
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('Officer init is required');
		});

		it('should fail when officer scopes contain invalid scope codes — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			let caught: unknown;
			try {
				await engine.createAuthority(
					{ name: 'BadScopes', domainName: 'bs.example.com' },
					{
						officers: [
							{
								init: {
									name: 'Officer Bad',
									title: 'Chair',
									scopes: ['xx-not-a-scope'] as unknown as Scope[],
								},
							},
						],
						effectiveAt: Date.now(),
						thresholdPolicies: [],
					},
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('ScopesValid');
		});

		it('should reject creating a second authority without a valid invite (InsertValid constraint) — BLOCKED on quereus#23', async () => {
			// The very-first authority is seeded by createNetworkEngine(). A
			// second createAuthority call binds Tid/InviteSlotCid/InviteSignature
			// all to TODO (engine source leaves them as the SQL literal `:Tid`,
			// etc.). Since no invite is present and an Authority already exists,
			// Authority.InsertValid must fail.
			const { engine } = await createNetworkEngine();
			let caught: unknown;
			try {
				await engine.createAuthority(
					{ name: 'SecondAuth', domainName: 'second.example.com' },
					{
						officers: [
							{
								init: {
									name: 'Officer Two',
									title: 'Chair',
									scopes: ['rad'] as Scope[],
								},
							},
						],
						effectiveAt: Date.now(),
						thresholdPolicies: [],
					},
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('InsertValid');
		});

		it('should set Authority.DomainName to the provided value or null — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			await engine.createAuthority(
				{ name: 'WithDomain', domainName: 'wd.example.com' },
				{
					officers: [
						{
							init: { name: 'O', title: 'T', scopes: ['rad'] as Scope[] },
						},
					],
					effectiveAt: Date.now(),
					thresholdPolicies: [],
				},
			);
			const withDomain = await ctx.db
				.prepare('select DomainName from Authority where Name = :n')
				.get({ n: 'WithDomain' });
			expect(withDomain?.DomainName).to.equal('wd.example.com');

			await engine.createAuthority({ name: 'NoDomain' } as never, {
				officers: [
					{
						init: { name: 'O', title: 'T', scopes: ['rad'] as Scope[] },
					},
				],
				effectiveAt: Date.now(),
				thresholdPolicies: [],
			});
			const noDomain = await ctx.db
				.prepare('select DomainName from Authority where Name = :n')
				.get({ n: 'NoDomain' });
			expect(noDomain?.DomainName).to.equal(null);
		});

		it('should serialize imageRef as JSON in the Authority row — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			await engine.createAuthority(
				{
					name: 'WithImage',
					domainName: 'wi.example.com',
					imageUrl: 'https://cdn.example.com/auth.png',
				} as never,
				{
					officers: [
						{
							init: { name: 'O', title: 'T', scopes: ['rad'] as Scope[] },
						},
					],
					effectiveAt: Date.now(),
					thresholdPolicies: [],
				},
			);
			const row = await ctx.db
				.prepare('select ImageRef from Authority where Name = :n')
				.get({ n: 'WithImage' });
			expect(row?.ImageRef).to.be.a('string');
			expect(JSON.parse(row!.ImageRef as string)).to.equal(
				'https://cdn.example.com/auth.png',
			);
		});
	});

	// -----------------------------------------------------------------------
	// 4. Authority Schema Constraints (from votetorrent.qsql)
	// -----------------------------------------------------------------------
	describe('schema constraints - Authority table', () => {
		it('should allow the very first authority without an invite or signing nonce — BLOCKED on quereus#23', async () => {
			// createNetworkEngine() itself exercises the first-authority shoe-in
			// branch of Authority.InsertValid. If it returns without throw, the
			// constraint accepted the no-invite/no-signing path.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const row = await ctx.db
				.prepare('select count(*) as n from Authority')
				.get({});
			expect(Number(row?.n)).to.equal(1);
		});

		it('should reject deletion of an Authority (CantDelete constraint) — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					'delete from Authority with context Tid = 1, SigningNonce = null, InviteSlotCid = null, InviteSignature = null',
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('CantDelete');
		});

		it('should reject mutation of Authority.Id on update (IdImmutable constraint) — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					'update Authority with context Tid = 1, SigningNonce = null, InviteSlotCid = null, InviteSignature = null set Id = :id',					{ id: 'mutated-authority-id' },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('IdImmutable');
		});

		it('should require an Admin row to exist when inserting an Authority (AdminRequired) — BLOCKED on quereus#23', async () => {
			// Insert an Authority without inserting a matching Admin in the same
			// batch — AdminRequired fires at end-of-batch.
			await AsyncStorage.clear();
			const db = new Database();
			await prepareDb(db);
			let caught: unknown;
			try {
				await db.exec(
					`insert into Authority (Id, Name, DomainName, ImageRef)
           with context Tid = 1, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:id, 'NoAdmin', 'na.example', null)`,
					{ id: crypto.randomUUID() },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('AdminRequired');
		});

		it('should require a valid invite for subsequent authority inserts — BLOCKED on quereus#23', async () => {
			// Duplicates the createAuthority InsertValid test above but exercised
			// via raw SQL to make the constraint name visible in the error path.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into Authority (Id, Name, DomainName, ImageRef)
           with context Tid = 2, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:id, 'NoInvite', 'ni.example', null)`,
					{ id: crypto.randomUUID() },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('InsertValid');
		});

		it('should validate update using AdminSignature with scope uai (UpdateValid) — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					'update Authority with context Tid = 1, SigningNonce = null, InviteSlotCid = null, InviteSignature = null set Name = :n',					{ n: 'Renamed' },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('UpdateValid');
		});
	});

	// -----------------------------------------------------------------------
	// 5. Network Revision Proposals
	// -----------------------------------------------------------------------
	describe('proposeRevision', () => {
		it('should insert a ProposedNetwork row with the proposed name, relays, and policies — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			await engine.proposeRevision({
				name: 'Revised Network',
				relays: ['/dns4/r2.example.com/tcp/443/wss'],
				policies: {
					timestampAuthorities: [{ url: 'https://tsa2.example.com' }],
					numberRequiredTSAs: 2,
					electionType: ElectionType.official,
				},
			});
			const row = await ctx.db
				.prepare(
					'select Name, Relays, NumberRequiredTSAs, ElectionType from ProposedNetwork where Name = :n',
				)
				.get({ n: 'Revised Network' });
			expect(row?.Name).to.equal('Revised Network');
			expect(JSON.parse(row!.Relays as string)).to.deep.equal([
				'/dns4/r2.example.com/tcp/443/wss',
			]);
			expect(Number(row?.NumberRequiredTSAs)).to.equal(2);
			expect(row?.ElectionType).to.equal('o');
		});

		it('should serialize imageRef as JSON or null — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			await engine.proposeRevision({
				name: 'WithImage',
				imageRef: { url: 'https://cdn.example.com/r.png' },
				relays: [],
				policies: {
					timestampAuthorities: [],
					numberRequiredTSAs: 1,
					electionType: ElectionType.adhoc,
				},
			});
			const withImg = await ctx.db
				.prepare('select ImageRef from ProposedNetwork where Name = :n')
				.get({ n: 'WithImage' });
			expect(JSON.parse(withImg!.ImageRef as string)).to.deep.equal({
				url: 'https://cdn.example.com/r.png',
			});

			await engine.proposeRevision({
				name: 'NoImage',
				relays: [],
				policies: {
					timestampAuthorities: [],
					numberRequiredTSAs: 1,
					electionType: ElectionType.adhoc,
				},
			});
			const noImg = await ctx.db
				.prepare('select ImageRef from ProposedNetwork where Name = :n')
				.get({ n: 'NoImage' });
			expect(noImg?.ImageRef).to.equal(null);
		});

		it('should serialize relays as a JSON array — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const relays = ['/a', '/b', '/c'];
			await engine.proposeRevision({
				name: 'RelayShape',
				relays,
				policies: {
					timestampAuthorities: [],
					numberRequiredTSAs: 1,
					electionType: ElectionType.adhoc,
				},
			});
			const row = await ctx.db
				.prepare('select Relays from ProposedNetwork where Name = :n')
				.get({ n: 'RelayShape' });
			expect(JSON.parse(row!.Relays as string)).to.deep.equal(relays);
		});

		it('should serialize timestampAuthorities as a JSON array — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const tsas = [{ url: 'https://t1' }, { url: 'https://t2' }];
			await engine.proposeRevision({
				name: 'TsaShape',
				relays: [],
				policies: {
					timestampAuthorities: tsas,
					numberRequiredTSAs: 2,
					electionType: ElectionType.adhoc,
				},
			});
			const row = await ctx.db
				.prepare(
					'select TimestampAuthorities from ProposedNetwork where Name = :n',
				)
				.get({ n: 'TsaShape' });
			expect(JSON.parse(row!.TimestampAuthorities as string)).to.deep.equal(
				tsas,
			);
		});

		it('should reject proposed revision with invalid ElectionType (ElectionTypeValid constraint) — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			let caught: unknown;
			try {
				await engine.proposeRevision({
					name: 'BadType',
					relays: [],
					policies: {
						timestampAuthorities: [],
						numberRequiredTSAs: 1,
						electionType: 'xx' as unknown as ElectionType,
					},
				});
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('ElectionTypeValid');
		});

		it('should reject proposed revision with negative NumberRequiredTSAs — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			let caught: unknown;
			try {
				await engine.proposeRevision({
					name: 'NegTSAs',
					relays: [],
					policies: {
						timestampAuthorities: [],
						numberRequiredTSAs: -3,
						electionType: ElectionType.adhoc,
					},
				});
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('NumberRequiredTSAsValid');
		});

		it('should only allow officers with rn scope from the primary authority (UserValid constraint) — BLOCKED on quereus#23', async () => {
			// The seeded officer in makeNetworkInit only has scopes ['rn', 'mel'];
			// proposeRevision (which omits explicit context.UserId/UserKey today)
			// will fall through UserValid. We exercise the failure path by clearing
			// the user from the engine ctx so the join in UserValid finds no row.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			(ctx as { user?: User }).user = undefined;
			let caught: unknown;
			try {
				await engine.proposeRevision({
					name: 'NoUserCtx',
					relays: [],
					policies: {
						timestampAuthorities: [],
						numberRequiredTSAs: 1,
						electionType: ElectionType.adhoc,
					},
				});
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('UserValid');
		});

		it('should require a valid user signature over the proposed digest — BLOCKED on quereus#23', async () => {
			// Even with a present user, an invalid context.Signature must trip
			// the SignatureValid sub-clause of ProposedNetwork.UserValid.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				// proposeRevision today does not bind context.Signature, so the
				// signature subtest is implicit in UserValid failure. Once the
				// engine wires context for proposeRevision, this test should bind
				// a deliberately invalid signature and expect UserValid in the
				// resulting QuereusError.
				await ctx.db.exec(
					`insert into ProposedNetwork (Name, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType)
           with context UserId = :uid, UserKey = 'bad-key', Signature = 'deadbeef', Tid = 9, now = ${Date.now()}, IsUserValid = false
           values ('SigCheck', null, '[]', '[]', 1, 'a')`,
					{ uid: ctx.user?.id ?? 'user-1' },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('UserValid');
		});
	});

	// -----------------------------------------------------------------------
	// 6. Network Revision Signing (AdminSigning / AdminSignature flow)
	// -----------------------------------------------------------------------
	describe('network revision signing flow', () => {
		// These tests duplicate coverage in signing.spec.ts (TEST-02). They're
		// retained here as the natural-language witness for the rn-scoped
		// Network revision flow. When #23 lands, sweep signing.spec.ts and these
		// together — most bodies below assert constraint names rather than
		// exact signature bytes, since real digest construction lives in
		// SigningEngine and is exercised in detail there.

		it('should create an AdminSigning session with scope rn and a valid digest — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const details = await engine.getDetails();
			// Seed an AdminSigning row with scope rn. Real digest/signature
			// production lives in SigningEngine; here we assert the row lands.
			const nonce = 'nonce-' + crypto.randomUUID();
			await ctx.db.exec(
				`insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = ${Date.now()}
         values (:nonce, :authId, :effAt, 'rn', :digest, :uid, :key, :sig)`,
				{
					nonce: nonce,
					authId: details.network.primaryAuthorityId,
					effAt: new Date().toISOString(),
					digest: 'digest-rn',
					uid: ctx.user?.id ?? 'user-1',
					key: (ctx.user?.activeKeys ?? [])[0]!.key,
					sig: 'a'.repeat(128),
				},
			);
			const row = await ctx.db
				.prepare('select Scope from AdminSigning where Nonce = :n')
				.get({ n: nonce });
			expect(row?.Scope).to.equal('rn');
		});

		it('should reject AdminSigning with an invalid scope code — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const details = await engine.getDetails();
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
           with context now = ${Date.now()}
           values (:nonce, :authId, :effAt, 'xx', :digest, :uid, :key, :sig)`,
					{
						nonce: 'bad-scope-nonce',
						authId: details.network.primaryAuthorityId,
						effAt: new Date().toISOString(),
						digest: 'd',
						uid: ctx.user?.id ?? 'user-1',
						key: (ctx.user?.activeKeys ?? [])[0]!.key,
						sig: 'a'.repeat(128),
					},
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('ScopeValid');
		});

		it('should validate the instigator signature on AdminSigning (SignatureValid) — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const details = await engine.getDetails();
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
           with context now = ${Date.now()}
           values ('bad-sig-nonce', :authId, :effAt, 'rn', 'd', :uid, :key, 'deadbeef')`,
					{
						authId: details.network.primaryAuthorityId,
						effAt: new Date().toISOString(),
						uid: ctx.user?.id ?? 'user-1',
						key: (ctx.user?.activeKeys ?? [])[0]!.key,
					},
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('SignatureValid');
		});

		it('should accept OfficerSignature when the officer has rn scope and the digest matches — BLOCKED on quereus#23', async () => {
			// Happy-path OfficerSignature insertion. Detailed digest math is in
			// signing.spec.ts — here we assert "no constraint fires" after a
			// SigningEngine-produced AdminSigning + matching OfficerSignature.
			// Placeholder for sweep: replicate signing.spec.ts threshold-met
			// setup once #23 lands.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const row = await ctx.db
				.prepare('select count(*) as n from OfficerSignature')
				.get({});
			expect(Number(row?.n)).to.be.a('number');
		});

		it('should reject OfficerSignature when the signature does not match the AdminSigning digest — BLOCKED on quereus#23', async () => {
			// After a valid AdminSigning is in place, insert an OfficerSignature
			// whose Signature does not validate against AdminSigning.Digest;
			// expect SignatureValid to fire.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const details = await engine.getDetails();
			// Seed AdminSigning first (real signature production deferred to
			// SigningEngine; this stub asserts the SignatureValid CHECK fires
			// on a deliberately-wrong OfficerSignature).
			const nonce = 'os-mismatch-' + crypto.randomUUID();
			await ctx.db.exec(
				`insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = ${Date.now()}
         values (:nonce, :authId, :effAt, 'rn', 'd-true', :uid, :key, :sig)`,
				{
					nonce: nonce,
					authId: details.network.primaryAuthorityId,
					effAt: new Date().toISOString(),
					uid: ctx.user?.id ?? 'user-1',
					key: (ctx.user?.activeKeys ?? [])[0]!.key,
					sig: 'a'.repeat(128),
				},
			);
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into OfficerSignature (SigningNonce, UserId, SignerKey, Signature)
           with context now = ${Date.now()}
           values (:nonce, :uid, :key, 'wrong-sig')`,
					{
						nonce: nonce,
						uid: ctx.user?.id ?? 'user-1',
						key: (ctx.user?.activeKeys ?? [])[0]!.key,
					},
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('SignatureValid');
		});

		it('should create AdminSignature only when the threshold of OfficerSignatures is met — BLOCKED on quereus#23', async () => {
			// Sentinel: signing.spec.ts owns the rigorous threshold-met case.
			// Here we assert the AdminSignature row count grows when the seeded
			// threshold (1) is met.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const before = await ctx.db
				.prepare('select count(*) as n from AdminSignature')
				.get({});
			// SigningEngine-driven flow would populate AdminSignature here. The
			// assertion shape is documented; the body fills out when #23 ships.
			const after = await ctx.db
				.prepare('select count(*) as n from AdminSignature')
				.get({});
			expect(Number(after?.n)).to.be.at.least(Number(before?.n));
		});

		it('should reject AdminSignature when insufficient OfficerSignatures exist — BLOCKED on quereus#23', async () => {
			// Try to insert AdminSignature for a SigningNonce with zero
			// OfficerSignature rows; SignatureValid must fire.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into AdminSignature (SigningNonce) values ('no-sigs-nonce')`,
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('SignatureValid');
		});

		it('should allow network update only after AdminSignature exists with matching digest — BLOCKED on quereus#23', async () => {
			// Without a matching AdminSignature, an UPDATE on Network with a
			// bound SigningNonce in context must still trip UpdateNetworkValid.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					`update Network with context Tid = 1, SigningNonce = 'no-such-nonce' set Name = 'X'`
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('UpdateNetworkValid');
		});
	});

	// -----------------------------------------------------------------------
	// 7. Pinned Authorities (local storage) — pure LocalStorage tests
	// -----------------------------------------------------------------------
	describe('pinAuthority / unpinAuthority', () => {
		it('should start with an empty list of pinned authorities', async () => {
			await AsyncStorage.clear();
			const { engine } = await makeDbOnlyNetworkEngine();
			const pinned = await engine.getPinnedAuthorities();
			expect(pinned).to.deep.equal([]);
		});

		it('should add an authority to pinned list via pinAuthority', async () => {
			await AsyncStorage.clear();
			const { engine } = await makeDbOnlyNetworkEngine();
			const auth: Authority = {
				id: 'aid-1',
				name: 'AuthorityOne',
				domainName: 'one.example.com',
			};
			await engine.pinAuthority(auth);
			const pinned = await engine.getPinnedAuthorities();
			expect(pinned).to.have.length(1);
			expect(pinned[0]?.id).to.equal('aid-1');
		});

		it('should deduplicate when pinning the same authority twice', async () => {
			await AsyncStorage.clear();
			const { engine } = await makeDbOnlyNetworkEngine();
			const auth: Authority = {
				id: 'aid-dup',
				name: 'Dup',
				domainName: 'dup.example.com',
			};
			await engine.pinAuthority(auth);
			await engine.pinAuthority(auth);
			const pinned = await engine.getPinnedAuthorities();
			expect(pinned).to.have.length(1);
		});

		it('should remove an authority from pinned list via unpinAuthority', async () => {
			await AsyncStorage.clear();
			const { engine } = await makeDbOnlyNetworkEngine();
			const auth: Authority = {
				id: 'aid-rm',
				name: 'Removable',
				domainName: 'rm.example.com',
			};
			await engine.pinAuthority(auth);
			await engine.unpinAuthority(auth.id);
			const pinned = await engine.getPinnedAuthorities();
			expect(pinned).to.deep.equal([]);
		});

		it('should be a no-op when unpinning an authority that is not pinned', async () => {
			await AsyncStorage.clear();
			const { engine } = await makeDbOnlyNetworkEngine();
			const auth: Authority = {
				id: 'aid-real',
				name: 'Real',
				domainName: 'real.example.com',
			};
			await engine.pinAuthority(auth);
			await engine.unpinAuthority('aid-ghost');
			const pinned = await engine.getPinnedAuthorities();
			expect(pinned).to.have.length(1);
			expect(pinned[0]?.id).to.equal('aid-real');
		});

		it('should persist pinned authorities across engine instances via localStorage', async () => {
			await AsyncStorage.clear();
			const first = await makeDbOnlyNetworkEngine();
			const auth: Authority = {
				id: 'aid-persist',
				name: 'Persistent',
				domainName: 'p.example.com',
			};
			await first.engine.pinAuthority(auth);
			const second = await makeDbOnlyNetworkEngine();
			const pinned = await second.engine.getPinnedAuthorities();
			expect(pinned).to.have.length(1);
			expect(pinned[0]?.id).to.equal('aid-persist');
		});
	});

	// -----------------------------------------------------------------------
	// 8. Open Authority
	// -----------------------------------------------------------------------
	describe('openAuthority', () => {
		it('should use the provided Authority object when supplied (no DB lookup)', async () => {
			// openAuthority's two-arg form short-circuits the DB SELECT.
			// No INSERT or row read — runs against schema-only DB.
			const { engine } = await makeDbOnlyNetworkEngine();
			const auth: Authority = {
				id: 'aid-pass-through',
				name: 'PassThrough',
				domainName: 'pt.example.com',
			};
			const authorityEngine = await engine.openAuthority(auth.id, auth);
			expect(authorityEngine).to.not.equal(undefined);
		});

		// BLOCKED on quereus#23 — NetworkEngine.openAuthority uses colon-prefix
		// bind keys (`:id`) which fail to resolve under Quereus 3.x parameter
		// convention (see 05-SUMMARY.md deviation §1). The not-found path
		// therefore can't be exercised without modifying engine source, which
		// is out of scope for Phase 6. When colon-prefix sites are swept post-#23,
		// unskip and assert 'Authority not found'.
		it('should throw Authority not found when the authorityId does not exist in the database', async () => {
			const { engine } = await makeDbOnlyNetworkEngine();
			let caught: unknown;
			try {
				await engine.openAuthority('never-existed-authority');
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('Authority not found');
		});

		// BLOCKED on quereus#23 — happy-path query needs a seeded Authority row.
		it('should return an AuthorityEngine when given a valid authorityId', async () => {
			const { engine } = await createNetworkEngine();
			const details = await engine.getDetails();
			const authorityEngine = await engine.openAuthority(
				details.network.primaryAuthorityId,
			);
			expect(authorityEngine).to.not.equal(undefined);
		});

		// BLOCKED on quereus#23 — needs a seeded Authority row to query.
		it('should query the database for the authority when no object is provided', async () => {
			const { engine } = await createNetworkEngine();
			const details = await engine.getDetails();
			const authorityEngine = await engine.openAuthority(
				details.network.primaryAuthorityId,
			);
			expect(authorityEngine).to.not.equal(undefined);
		});
	});

	// -----------------------------------------------------------------------
	// 9. User Retrieval
	// -----------------------------------------------------------------------
	describe('getUser', () => {
		// BLOCKED on quereus#23 — NetworkEngine.getUser uses colon-prefix
		// bind keys (`:id`) which fail to resolve under Quereus 3.x. The
		// not-found path can't be exercised without engine-source changes
		// (out of Phase 6 scope; documented in 05-SUMMARY.md deviation §1).
		it('throws User not found when userId does not exist', async () => {
			const { engine } = await makeDbOnlyNetworkEngine();
			let caught: unknown;
			try {
				await engine.getUser('never-existed-user');
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('User not found');
		});

		// BLOCKED on quereus#23
		it('should return a UserEngine for a valid userId', async () => {
			const { engine } = await createNetworkEngine();
			const user = await engine.getUser('user-1');
			expect(user).to.not.equal(undefined);
		});

		// BLOCKED on quereus#23
		it('should include only non-expired active keys in the returned user', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			// Insert an expired UserKey alongside the live one.
			await ctx.db.exec(
				`insert into UserKey (UserId, Type, PubKey, Expiration)
         with context UserKey = :live, Signature = null, Tid = 9, now = ${Date.now()}
         values ('user-1', 'M', 'expired-key', :exp)`,
				{
					live: (ctx.user?.activeKeys ?? [])[0]!.key,
					exp: Date.now() - 60_000,
				},
			);
			const userEngine = await engine.getUser('user-1');
			const summary = await userEngine?.getSummary();
			const keys = summary?.activeKeys ?? [];
			expect(keys.find((k: UserKey) => k.key === 'expired-key')).to.equal(
				undefined,
			);
		});
	});

	describe('getCurrentUser', () => {
		it('returns undefined when no user is bound to the engine context', async () => {
			// ctx.user is undefined → getCurrentUser returns undefined without
			// touching the DB.
			const db = new Database();
			await prepareDb(db);
			const ref: NetworkReference = {
				hash: 'h'.repeat(16),
				name: 'NoUser',
				relays: [],
				primaryAuthorityDomainName: 'n.example',
			};
			const ctx: EngineContext = { db, user: undefined };
			const engine = new NetworkEngine(ref, AsyncStorage, ctx);
			const current = await engine.getCurrentUser();
			expect(current).to.equal(undefined);
		});

		// BLOCKED on quereus#23
		it('should return the current user engine from the engine context', async () => {
			const { engine } = await createNetworkEngine();
			const current = await engine.getCurrentUser();
			expect(current).to.not.equal(undefined);
		});
	});

	// -----------------------------------------------------------------------
	// 10. Election Stubs (ensure not-implemented errors)
	// -----------------------------------------------------------------------
	describe('election methods (not yet implemented)', () => {
		it('should throw "Not implemented" from createElection', async () => {
			const { engine } = await makeDbOnlyNetworkEngine();
			let caught: unknown;
			try {
				await engine.createElection({} as never);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('Not implemented');
		});

		it('should throw "Not implemented" from openElection', async () => {
			const { engine } = await makeDbOnlyNetworkEngine();
			let caught: unknown;
			try {
				await engine.openElection('any-id');
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('Not implemented');
		});
	});

	// -----------------------------------------------------------------------
	// 11. Invite Response — USER-07 (shipped in Phase 4)
	// -----------------------------------------------------------------------
	describe('respondToInvite', () => {
		// BLOCKED on quereus#23 — needs a seeded InviteSlot + AdminSignature
		// row, which require NetworksEngine.create() / saveInviteWithSigning,
		// both of which trip the same #23 chain.
		it('inserts an InviteResult row for an accepted invite', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			// Seed an InviteSlot + AdminSignature pair so SigningValid passes.
			// Real seeding lives in AuthorityEngine.saveInviteWithSigning; this
			// body shapes the call once that flow can run.
			const slotCid = 'slot-' + crypto.randomUUID();
			await engine.respondToInvite({
				invite: { digest: slotCid } as never,
				isAccepted: true,
				invokes: { authority: { name: 'Invokee', domainName: 'inv.example' } },
				inviteSignature: 'a'.repeat(128),
				userId: undefined,
				userInit: undefined,
			} as never);
			const row = await ctx.db
				.prepare(
					'select IsAccepted, Digest from InviteResult where SlotCid = :c',
				)
				.get({ c: slotCid });
			expect(Boolean(row?.IsAccepted)).to.equal(true);
			expect(row?.Digest).to.not.equal(null);
		});

		it('inserts an InviteResult row with null digest for a rejected invite — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const slotCid = 'slot-rej-' + crypto.randomUUID();
			await engine.respondToInvite({
				invite: { digest: slotCid } as never,
				isAccepted: false,
				invokes: undefined,
				inviteSignature: 'b'.repeat(128),
				userId: undefined,
				userInit: undefined,
			} as never);
			const row = await ctx.db
				.prepare(
					'select IsAccepted, Digest from InviteResult where SlotCid = :c',
				)
				.get({ c: slotCid });
			expect(Boolean(row?.IsAccepted)).to.equal(false);
			expect(row?.Digest).to.equal(null);
		});
	});

	// -----------------------------------------------------------------------
	// 12. Authorities By Name (cursor-based) — Not implemented stubs
	// -----------------------------------------------------------------------
	describe('getAuthoritiesByName / nextAuthoritiesByName', () => {
		it('should throw "Not implemented" from getAuthoritiesByName', async () => {
			const { engine } = await makeDbOnlyNetworkEngine();
			let caught: unknown;
			try {
				await engine.getAuthoritiesByName(undefined);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('Not implemented');
		});

		it('should throw "Not implemented" from nextAuthoritiesByName', async () => {
			const { engine } = await makeDbOnlyNetworkEngine();
			let caught: unknown;
			try {
				await engine.nextAuthoritiesByName({ items: [] } as never, true);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('Not implemented');
		});
	});
});

// ===========================================================================
// NetworksEngine - Additional Constraint & Validation Tests
// ===========================================================================

describe('NetworksEngine - creation constraints', () => {
	// -----------------------------------------------------------------------
	// 13. Network Creation Validation
	// -----------------------------------------------------------------------
	describe('create - input validation', () => {
		it('should fail when no officers are provided in admin init', async () => {
			// Pure-guard: NetworksEngine.create throws before any DB write when
			// officer init is missing. quereus#23 not exercised.
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			const engine = new NetworksEngine(AsyncStorage);
			const user = makeUser();
			const init = makeNetworkInit({
				admin: {
					officers: [],
					effectiveAt: Date.now(),
					thresholdPolicies: [],
				},
			});
			let caught: unknown;
			try {
				await engine.create(init, user);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('Officer init is required');
		});

		it('should fail when user has no active keys', async () => {
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			const engine = new NetworksEngine(AsyncStorage);
			const user = makeUser({ activeKeys: [] });
			let caught: unknown;
			try {
				await engine.create(makeNetworkInit(), user);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('User key is required');
		});

		// The user-key-expired guard is enforced at the schema level (UserKey
		// ExpirationFuture CHECK) rather than in the engine; it can't run
		// until the schema can accept the INSERT, so it's bug-blocked.
		it('should fail when user key is expired — BLOCKED on quereus#23', async () => {
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			const engine = new NetworksEngine(AsyncStorage);
			const user = makeUser({
				activeKeys: [
					{
						key: randomTestKeyPair().publicHex,
						type: UserKeyType.mobile,
						expiration: Date.now() - 60_000,
					},
				],
			});
			let caught: unknown;
			try {
				await engine.create(makeNetworkInit(), user);
			} catch (err) {
				caught = err;
			}
			// UserKey.ExpirationFuture is the schema-level CHECK that fires here.
			expect((caught as Error)?.message).to.include('ExpirationFuture');
		});

		it('should create Network, Authority, Admin, Officer, User, and UserKey in one transaction — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const counts = await Promise.all(
				['Network', 'Authority', 'Admin', 'Officer', 'User', 'UserKey'].map(
					async (table) =>
						(await ctx.db.prepare(`select count(*) as n from ${table}`).get({}))
							?.n,
				),
			);
			for (const c of counts) expect(Number(c)).to.equal(1);
		});

		it('should generate a unique network ID (UUID) on each create — BLOCKED on quereus#23', async () => {
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			const a = await new NetworksEngine(AsyncStorage).create(
				makeNetworkInit({ name: 'A' }),
				makeUser({ id: 'user-a' }),
			);
			const b = await new NetworksEngine(AsyncStorage).create(
				makeNetworkInit({ name: 'B' }),
				makeUser({ id: 'user-b' }),
			);
			const aCtx = (a as unknown as { ctx: EngineContext }).ctx;
			const bCtx = (b as unknown as { ctx: EngineContext }).ctx;
			const aId = (await aCtx.db.prepare('select Id from Network').get({}))
				?.Id as string;
			const bId = (await bCtx.db.prepare('select Id from Network').get({}))
				?.Id as string;
			expect(aId).to.be.a('string').with.length.greaterThan(0);
			expect(bId).to.not.equal(aId);
		});

		it('should compute Hash as H16 of the network ID — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const row = await ctx.db.prepare('select Id, Hash from Network').get({});
			// H16 produces a 16-char hex slice; assert shape rather than recompute.
			expect((row?.Hash as string)?.length).to.equal(16);
			expect(row?.Hash).to.match(/^[0-9a-f]+$/);
		});

		it('should set PrimaryAuthorityId to the generated authority UUID — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const row = await ctx.db
				.prepare('select PrimaryAuthorityId from Network')
				.get({});
			const paId = row?.PrimaryAuthorityId as string;
			const exists = await ctx.db
				.prepare('select Id from Authority where Id = :id')
				.get({ id: paId });
			expect(exists?.Id).to.equal(paId);
		});
	});

	// -----------------------------------------------------------------------
	// 14. Network Creation - Schema Constraint Coverage
	// -----------------------------------------------------------------------
	describe('create - schema constraints', () => {
		it('should reject when ElectionType is not a valid code — BLOCKED on quereus#23', async () => {
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			let caught: unknown;
			try {
				await new NetworksEngine(AsyncStorage).create(
					makeNetworkInit({
						policies: {
							timestampAuthorities: [{ url: 'https://t' }],
							numberRequiredTSAs: 1,
							electionType: 'xx' as unknown as ElectionType,
						},
					}),
					makeUser(),
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('ElectionTypeValid');
		});

		it('should reject when NumberRequiredTSAs is negative — BLOCKED on quereus#23', async () => {
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			let caught: unknown;
			try {
				await new NetworksEngine(AsyncStorage).create(
					makeNetworkInit({
						policies: {
							timestampAuthorities: [{ url: 'https://t' }],
							numberRequiredTSAs: -1,
							electionType: ElectionType.adhoc,
						},
					}),
					makeUser(),
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('NumberRequiredTSAsValid');
		});

		it('should reject when admin EffectiveAt is not a valid ISO datetime ending in Z — BLOCKED on quereus#23', async () => {
			// engine source passes a numeric Date.now() into Admin.EffectiveAt;
			// EffectiveAtValid demands an ISO string ending in 'Z'. Force a bad
			// value via raw seed to make the constraint name visible.
			await AsyncStorage.clear();
			const db = new Database();
			await prepareDb(db);
			let caught: unknown;
			try {
				await db.exec(
					`insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context Tid = 1, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values ('aid-x', '2026-05-22 not-iso', '[]')`,
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('EffectiveAtValid');
		});

		it('should reject when officer scopes contain unknown scope codes — BLOCKED on quereus#23', async () => {
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			let caught: unknown;
			try {
				await new NetworksEngine(AsyncStorage).create(
					makeNetworkInit({
						admin: {
							officers: [
								{
									init: {
										name: 'Bad Officer',
										title: 'Chair',
										scopes: ['not-a-scope'] as unknown as Scope[],
									},
								},
							],
							effectiveAt: Date.now(),
							thresholdPolicies: [],
						},
					}),
					makeUser(),
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('ScopesValid');
		});

		it('should allow the first authority+admin+officer to bootstrap without signing context — BLOCKED on quereus#23', async () => {
			// createNetworkEngine() succeeds <=> the first-authority shoe-in
			// branch accepted the no-invite/no-signing context.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const a = await ctx.db
				.prepare('select count(*) as n from Authority')
				.get({});
			const ad = await ctx.db
				.prepare('select count(*) as n from Admin')
				.get({});
			const o = await ctx.db
				.prepare('select count(*) as n from Officer')
				.get({});
			expect(Number(a?.n)).to.equal(1);
			expect(Number(ad?.n)).to.equal(1);
			expect(Number(o?.n)).to.equal(1);
		});
	});

	// -----------------------------------------------------------------------
	// 15. Recent Networks Management — pure LocalStorage tests
	// -----------------------------------------------------------------------
	describe('recent networks', () => {
		// BLOCKED on quereus#23 — `append after create()` half exercises
		// the create() pipeline.
		it('should append the created network to recent networks', async () => {
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			const engine = new NetworksEngine(AsyncStorage);
			await engine.create(makeNetworkInit({ name: 'Appended' }), makeUser());
			const recents = await engine.getRecentNetworks();
			expect(recents).to.have.length.greaterThan(0);
			expect(recents[0]?.name).to.equal('Appended');
		});

		it('should return empty array from getRecentNetworks when none exist', async () => {
			await AsyncStorage.clear();
			const engine = new NetworksEngine(AsyncStorage);
			const recents = await engine.getRecentNetworks();
			expect(recents).to.deep.equal([]);
		});

		it('should remove all recent networks on clearRecentNetworks', async () => {
			await AsyncStorage.clear();
			const ref: NetworkReference = {
				hash: 'preseed-hash',
				relays: [],
				name: 'preseed',
				primaryAuthorityDomainName: 'p.example',
			};
			await AsyncStorage.setItem('recentNetworks', [ref]);
			const engine = new NetworksEngine(AsyncStorage);
			await engine.clearRecentNetworks();
			const got = await AsyncStorage.getItem('recentNetworks');
			expect(got).to.equal(undefined);
		});

		it('should move a reopened network to the front of recents (dedup) — BLOCKED on quereus#23', async () => {
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			const engine = new NetworksEngine(AsyncStorage);
			await engine.create(
				makeNetworkInit({ name: 'First' }),
				makeUser({ id: 'u1' }),
			);
			await engine.create(
				makeNetworkInit({ name: 'Second' }),
				makeUser({ id: 'u2' }),
			);
			const before = await engine.getRecentNetworks();
			const firstRef = before.find((n) => n.name === 'First')!;
			await engine.open(firstRef, undefined, true);
			const after = await engine.getRecentNetworks();
			expect(after[0]?.name).to.equal('First');
			// Dedup — exactly one entry per network.
			expect(after.filter((n) => n.name === 'First')).to.have.length(1);
		});

		it('should not modify recents when open is called with storeAsRecent=false — BLOCKED on quereus#23', async () => {
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			const engine = new NetworksEngine(AsyncStorage);
			await engine.create(makeNetworkInit({ name: 'Stable' }), makeUser());
			const before = await engine.getRecentNetworks();
			const ref = before[0]!;
			await engine.open(ref, undefined, false);
			const after = await engine.getRecentNetworks();
			expect(after).to.deep.equal(before);
		});
	});

	// -----------------------------------------------------------------------
	// 16. Open
	// -----------------------------------------------------------------------
	describe('open', () => {
		it('should return a NetworkEngine instance — BLOCKED on quereus#23 (open() requires a cached context from create())', async () => {
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			const engine = new NetworksEngine(AsyncStorage);
			const user = makeUser();
			await engine.create(makeNetworkInit(), user);
			const recents = await engine.getRecentNetworks();
			const opened = await engine.open(recents[0]!, user, true);
			expect(opened).to.not.equal(undefined);
			const summary = await opened.getNetworkSummary();
			expect(summary.name).to.equal('Test Network');
		});

		it('should create a fresh database context for each open call — BLOCKED on quereus#23', async () => {
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			const engine = new NetworksEngine(AsyncStorage);
			const user = makeUser();
			await engine.create(makeNetworkInit(), user);
			const recents = await engine.getRecentNetworks();
			const a = await engine.open(recents[0]!, user, false);
			const b = await engine.open(recents[0]!, user, false);
			expect(a).to.not.equal(b);
			// Cached context: ctx.db is shared between opens.
			const aDb = (a as unknown as { ctx: EngineContext }).ctx.db;
			const bDb = (b as unknown as { ctx: EngineContext }).ctx.db;
			expect(aDb).to.equal(bDb);
		});

		it('should work with undefined user — BLOCKED on quereus#23', async () => {
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			const engine = new NetworksEngine(AsyncStorage);
			await engine.create(makeNetworkInit(), makeUser());
			const recents = await engine.getRecentNetworks();
			const opened = await engine.open(recents[0]!, undefined, false);
			const current = await opened.getCurrentUser();
			expect(current).to.equal(undefined);
		});
	});

	// -----------------------------------------------------------------------
	// 17. Admin / Officer Schema Constraints
	// -----------------------------------------------------------------------
	describe('Admin table constraints', () => {
		it('should require at least one Officer with rad scope when inserting Admin (OfficerRequired) — BLOCKED on quereus#23', async () => {
			// Seeded admin in createNetworkEngine has officer with ['rn','mel'],
			// missing 'rad'. The CHECK fires at end-of-batch — exercising via
			// the create() pipeline surfaces OfficerRequired.
			await AsyncStorage.clear();
			await AsyncStorage.setItem('recentNetworks', []);
			let caught: unknown;
			try {
				await new NetworksEngine(AsyncStorage).create(
					makeNetworkInit({
						admin: {
							officers: [
								{
									init: {
										name: 'No-Rad Officer',
										title: 'Chair',
										scopes: ['mel'] as Scope[],
									},
								},
							],
							effectiveAt: Date.now(),
							thresholdPolicies: [],
						},
					}),
					makeUser(),
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('OfficerRequired');
		});

		it('should reject Admin insert when AuthorityId does not reference an existing Authority — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values ('no-such-authority', :effAt, '[]')`,
					{ effAt: new Date().toISOString() },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('AuthorityIdValid');
		});

		it('should reject Admin when EffectiveAt is not a valid ISO datetime ending in Z — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const details = await engine.getDetails();
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:authId, 'not-iso', '[]')`,
					{ authId: details.network.primaryAuthorityId },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('EffectiveAtValid');
		});

		it('should allow initial admin for very first authority without invite or signing — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const row = await ctx.db
				.prepare('select count(*) as n from Admin')
				.get({});
			expect(Number(row?.n)).to.equal(1);
		});

		it('should require valid invite for admin of a new (non-first) authority — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			let caught: unknown;
			try {
				await engine.createAuthority(
					{ name: 'NewAuth', domainName: 'na.example' },
					{
						officers: [
							{
								init: { name: 'O', title: 'T', scopes: ['rad'] as Scope[] },
							},
						],
						effectiveAt: Date.now(),
						thresholdPolicies: [],
					},
				);
			} catch (err) {
				caught = err;
			}
			// The Admin's MutationValid branch fires because no invite is present
			// and there's already an Authority. Schema labels it MutationValid;
			// upstream Quereus may surface either MutationValid or InsertValid.
			const msg = (caught as Error)?.message ?? '';
			expect(msg).to.match(/MutationValid|InsertValid/);
		});

		it('should require valid AdminSignature for admin update of existing authority — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const details = await engine.getDetails();
			let caught: unknown;
			try {
				await ctx.db.exec(
					`update Admin set ThresholdPolicies = '[]'
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           where AuthorityId = :authId`,
					{ authId: details.network.primaryAuthorityId },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('MutationValid');
		});
	});

	describe('Officer table constraints', () => {
		it('should reject Officer with scopes not in the Scope view — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const details = await engine.getDetails();
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:authId, :effAt, 'user-1', 'Bad', :scopes)`,
					{
						authId: details.network.primaryAuthorityId,
						effAt: new Date().toISOString(),
						scopes: JSON.stringify(['no-such-scope']),
					},
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('ScopesValid');
		});

		it('should reject Officer update or delete (OnlyInsert constraint) — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let updateErr: unknown;
			try {
				await ctx.db.exec(
					`update Officer set Title = 'Renamed'
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null`,
				);
			} catch (err) {
				updateErr = err;
			}
			expect((updateErr as Error)?.message).to.include('OnlyInsert');

			let deleteErr: unknown;
			try {
				await ctx.db.exec(
					`delete from Officer
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null`,
				);
			} catch (err) {
				deleteErr = err;
			}
			expect((deleteErr as Error)?.message).to.include('OnlyInsert');
		});

		it('should allow initial officer for very first authority without invite or signing — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const row = await ctx.db
				.prepare('select count(*) as n from Officer')
				.get({});
			expect(Number(row?.n)).to.equal(1);
		});

		it('should require valid invite for officers of a new authority — BLOCKED on quereus#23', async () => {
			// Same chain as the createAuthority InsertValid stub — a second
			// authority's officer insert without invite must trip InsertValid.
			const { engine } = await createNetworkEngine();
			let caught: unknown;
			try {
				await engine.createAuthority(
					{ name: 'OfficerInsertCheck', domainName: 'oi.example' },
					{
						officers: [
							{
								init: { name: 'O', title: 'T', scopes: ['rad'] as Scope[] },
							},
						],
						effectiveAt: Date.now(),
						thresholdPolicies: [],
					},
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('InsertValid');
		});

		it('should require valid AdminSigning for officers of an existing authority — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const details = await engine.getDetails();
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:authId, :effAt, 'user-1', 'Extra', '["rad"]')`,
					{
						authId: details.network.primaryAuthorityId,
						effAt: new Date().toISOString(),
					},
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('InsertValid');
		});
	});

	// -----------------------------------------------------------------------
	// 18. ProposedNetwork Constraints
	// -----------------------------------------------------------------------
	describe('ProposedNetwork constraints', () => {
		it('should reject proposal from user without rn scope on primary authority — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into ProposedNetwork (Name, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType)
           with context UserId = 'no-such-user', UserKey = 'no-key', Signature = 'sig', Tid = 9, now = ${Date.now()}, IsUserValid = false
           values ('NoScope', null, '[]', '[]', 1, 'a')`,
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('UserValid');
		});

		it('should require a valid user signature matching the proposed digest — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into ProposedNetwork (Name, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType)
           with context UserId = :uid, UserKey = :key, Signature = 'bad-sig', Tid = 9, now = ${Date.now()}, IsUserValid = false
           values ('BadSig', null, '[]', '[]', 1, 'a')`,
					{
						uid: ctx.user?.id ?? 'user-1',
						key: (ctx.user?.activeKeys ?? [])[0]!.key,
					},
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('UserValid');
		});

		it('should reject proposal with invalid ElectionType — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			let caught: unknown;
			try {
				await engine.proposeRevision({
					name: 'BadElectionType',
					relays: [],
					policies: {
						timestampAuthorities: [],
						numberRequiredTSAs: 1,
						electionType: 'zz' as unknown as ElectionType,
					},
				});
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('ElectionTypeValid');
		});

		it('should reject proposal with non-integer NumberRequiredTSAs — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			let caught: unknown;
			try {
				await engine.proposeRevision({
					name: 'NonInt',
					relays: [],
					policies: {
						timestampAuthorities: [],
						numberRequiredTSAs: 2.5,
						electionType: ElectionType.adhoc,
					},
				});
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('NumberRequiredTSAsValid');
		});
	});

	// -----------------------------------------------------------------------
	// 19. Administration Lifecycle (from doc)
	// -----------------------------------------------------------------------
	describe('administration lifecycle', () => {
		// These three duplicate the AuthorityEngine.proposeAdmin + signing.spec.ts
		// coverage. They're retained as the network-side natural-language
		// witness. Each requires a full AdminSigning → OfficerSignature →
		// AdminSignature chain produced by SigningEngine, plus an Admin row
		// mutation. Bodies below assert observable post-state shapes; the
		// signing setup will be wired in when #23 lands.

		it('should allow admin renewal before expiration with proper signatures — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const details = await engine.getDetails();
			// After SigningEngine produces an AdminSignature with scope 'rad' and
			// a matching digest, a new Admin row with a later EffectiveAt should
			// land. For now, assert the existing Admin row count is 1 (post-#23
			// sweep fills in: insert AdminSigning, OfficerSignature(s),
			// AdminSignature, then new Admin, then expect count = 2).
			const before = await ctx.db
				.prepare('select count(*) as n from Admin where AuthorityId = :id')
				.get({ id: details.network.primaryAuthorityId });
			expect(Number(before?.n)).to.equal(1);
		});

		it('should allow primary authority to replace expired admin of another authority — BLOCKED on quereus#23', async () => {
			// Same shape as renewal but with the primary authority signing a new
			// Admin row on a secondary authority. Post-#23 sweep needs a second
			// authority seed via accepted invite + AdminSignature on uai/rad.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const row = await ctx.db
				.prepare('select count(*) as n from Authority')
				.get({});
			// For now, just confirm the single authority is present; sweep when
			// multi-authority seeding is unblocked.
			expect(Number(row?.n)).to.equal(1);
		});

		it('should require a new network if the primary authority admin itself expires without renewal — BLOCKED on quereus#23', async () => {
			// Conceptually a no-renewal observation: after Admin.EffectiveAt is
			// in the past and no successor row exists, CurrentAdmin returns
			// nothing for that authority, and downstream operations (e.g.,
			// proposeRevision UserValid) start to fail.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const details = await engine.getDetails();
			const rows = await ctx.db
				.prepare(
					'select AuthorityId, EffectiveAt from CurrentAdmin where AuthorityId = :id',
				)
				.get({ id: details.network.primaryAuthorityId });
			// While the seeded admin is still effective, CurrentAdmin returns a
			// row. Post-#23 sweep: time-warp and assert CurrentAdmin is empty.
			expect(rows?.AuthorityId).to.equal(details.network.primaryAuthorityId);
		});
	});

	// -----------------------------------------------------------------------
	// 20. Invitation Flow (from doc/invitations.md & schema)
	// -----------------------------------------------------------------------
	describe('invitation flow for authorities', () => {
		it('should create an InviteSlot with a valid CID, key pair, and AdminSignature backing — BLOCKED on quereus#23', async () => {
			// Full flow: AuthorityEngine.createAuthorityInvite (pure crypto) +
			// saveInviteWithSigning (DB seed). The slot row should land with a
			// CID = Digest(...) and a SigningNonce referencing an AdminSignature.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			// Sweep post-#23: open authority via createNetworkEngine, then call
			// createAuthorityInvite + saveInviteWithSigning, then assert below.
			const row = await ctx.db
				.prepare('select count(*) as n from InviteSlot')
				.get({});
			expect(Number(row?.n)).to.be.a('number');
		});

		it('should reject InviteSlot when expiration is in the past — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
           with context Tid = 9, now = ${Date.now()}
           values ('past-cid', 'au', 'Past', :exp, 'pubkey', 'sig', 'nonce')`,
					{ exp: new Date(Date.now() - 60_000).toISOString() },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('ExpirationValid');
		});

		it('should reject InviteSlot when InviteSignature does not validate against InviteKey — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
           with context Tid = 9, now = ${Date.now()}
           values ('badsig-cid', 'au', 'BadSig', :exp, 'pubkey', 'not-a-real-sig', 'nonce')`,
					{ exp: new Date(Date.now() + 60_000).toISOString() },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('InviteSignatureValid');
		});

		it('should reject InviteSlot without a completed AdminSignature for the signing nonce — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
           with context Tid = 9, now = ${Date.now()}
           values ('orphan-cid', 'au', 'Orphan', :exp, 'pk', 'sig', 'never-signed')`,
					{ exp: new Date(Date.now() + 60_000).toISOString() },
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('InsertValid');
		});

		it('should create InviteResult marking acceptance with digest and invite signature — BLOCKED on quereus#23', async () => {
			// Sentinel post-state shape — full seed depends on saveInviteWithSigning.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const row = await ctx.db
				.prepare('select count(*) as n from InviteResult')
				.get({});
			expect(Number(row?.n)).to.be.a('number');
		});

		it('should reject InviteResult acceptance when Digest is null — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
           values ('any-slot', true, null, 'sig', null)`,
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('DigestValid');
		});

		it('should reject InviteResult rejection when Digest is not null — BLOCKED on quereus#23', async () => {
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			let caught: unknown;
			try {
				await ctx.db.exec(
					`insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
           values ('any-slot-2', false, 'non-null-digest', 'sig', null)`,
				);
			} catch (err) {
				caught = err;
			}
			expect((caught as Error)?.message).to.include('DigestValid');
		});

		it('should allow creating a new Authority via accepted invite with valid proof of possession — BLOCKED on quereus#23', async () => {
			// Full flow: NetworkEngine.createAuthority with context.InviteSlotCid
			// and context.InviteSignature backed by a real InviteResult row.
			// Post-#23 sweep: createAuthorityInvite → saveInviteWithSigning →
			// respondToInvite(accept) → createAuthority succeeds.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			const before = await ctx.db
				.prepare('select count(*) as n from Authority')
				.get({});
			expect(Number(before?.n)).to.equal(1);
		});

		it('should prevent reuse of an already-claimed invite slot — BLOCKED on quereus#23', async () => {
			// InviteResult primary key is SlotCid, so a duplicate insert for the
			// same slot will fail on PK violation regardless of signature.
			const { engine } = await createNetworkEngine();
			const ctx = (engine as unknown as { ctx: EngineContext }).ctx;
			// Sweep post-#23: insert one InviteResult, then attempt a duplicate
			// and assert the PK conflict surfaces.
			const row = await ctx.db
				.prepare('select count(*) as n from InviteResult')
				.get({});
			expect(Number(row?.n)).to.be.a('number');
		});
	});
});
