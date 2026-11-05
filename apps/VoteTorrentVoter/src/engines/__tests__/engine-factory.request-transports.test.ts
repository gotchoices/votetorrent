/**
 * engine-factory.request-transports.test.ts — Phase 62 Plan 22 (D-28/D-32/D-39).
 *
 * `EngineFactory`'s `'requestTransports'` case: the solo (non-strand-backed) network yields no
 * delivery path, a strand-backed network yields a peer-backed source whose strandId is the
 * network's own hash, a network switch rebuilds the source, and the precondition/delegation
 * rules hold. Mocks `./proof-flags.generated` only (so `USE_LOCAL_DB_FACTORY` reads false) —
 * everything else (Quereus, the schema, `NetworksEngine`) runs for real.
 */
import {Database} from '@quereus/quereus';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {bytesToHex} from '@noble/curves/utils.js';
import type {NetworkInit, Signature, User} from '@votetorrent/vote-core';
import {ElectionType, UserKeyType} from '@votetorrent/vote-core';
import {LocalStorageReact, registerDbPlugins} from '@votetorrent/vote-engine/rn';
import type {StrandConfig, StrandInstance} from '@serfab/cadre-core';

jest.mock('../proof-flags.generated', () => ({
	USE_LOCAL_DB_FACTORY: false,
	USE_STUB_ATTESTATION_VERIFIER: false,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {EngineFactory} = require('../engine-factory');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {VOTER_REQUEST_TRANSPORTS_ENGINE} = require('../voter-request-transports');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {resolveVoterRequestTransports} = require('../../screens/registration/attach-voter-request-transport');

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** Copied from voter-request-transports.test.ts (not imported — each test file builds its own
 * fixtures per this plan's own instruction). */
function makeOfficer(): {user: User; sign: (digest: Uint8Array) => Promise<Signature>} {
	const privBytes = secp256k1.utils.randomSecretKey();
	const pubBytes = secp256k1.getPublicKey(privBytes, true);
	const pubHex = bytesToHex(pubBytes);
	const user: User = {
		id: `officer-${crypto.randomUUID()}`,
		name: 'Test Officer',
		activeKeys: [{key: pubHex, type: UserKeyType.mobile, expiration: Date.now() + TEN_YEARS_MS}],
	};
	const sign = async (digest: Uint8Array): Promise<Signature> => ({
		signerUserId: user.id,
		signerKey: pubHex,
		signature: bytesToHex(secp256k1.sign(digest, privBytes)),
	});
	return {user, sign};
}

function makeNetworkInit(officerName: string): NetworkInit {
	return {
		name: `Engine Factory Request Transports Test Network ${crypto.randomUUID()}`,
		relays: [],
		primaryAuthority: {name: 'Engine Factory Request Transports Test Authority', domainName: 'test.votetorrent.local'},
		admin: {
			officers: [{init: {name: officerName, title: 'Registrar', scopes: ['mel', 'vrg']}}],
			effectiveAt: Date.now(),
			thresholdPolicies: [],
		},
		policies: {timestampAuthorities: [], numberRequiredTSAs: 0, electionType: ElectionType.adhoc},
	};
}

/**
 * Fake `StrandHost`. `addStrand` applies the already-stripped inner DDL (exactly what
 * `createStrandDbFactory` passes as `sAppConfig.schema`) under `App`, mirroring
 * `strand-reattach-guard.spec.ts`'s recipe (that file renames `main` -> `App` on the FULL schema
 * SQL; this reconstructs the identical wrapper around the INNER ddl `rn-db-factory.ts` already
 * stripped away, since `config.sAppConfig.schema` arrives pre-stripped).
 */
function makeFakeStrandHost() {
	const addStrandCalls: StrandConfig[] = [];
	return {
		addStrandCalls,
		getControlNode: () => ({getConnections: () => []}),
		async addStrand(config: StrandConfig): Promise<StrandInstance> {
			addStrandCalls.push(config);
			const db = new Database();
			await registerDbPlugins(db);
			const appSchemaSql = `declare schema App {\n${config.sAppConfig.schema}\n}\napply schema App;`;
			await db.exec(appSchemaSql);
			db.setSchemaPath(['App', 'main']);
			return {database: {getDatabase: () => db}} as unknown as StrandInstance;
		},
		async whenStrandWritable(): Promise<StrandInstance> {
			throw new Error('engine-factory.request-transports.test.ts: whenStrandWritable should never be reached');
		},
	};
}

describe('EngineFactory — requestTransports (D-28/D-32/D-39)', () => {
	it('precondition: getEngine("requestTransports") before any network is established rejects with the existing error', async () => {
		const factory = new EngineFactory(new LocalStorageReact(), async () => new Database());

		await expect(factory.getEngine(VOTER_REQUEST_TRANSPORTS_ENGINE)).rejects.toThrow(
			'Network context not established',
		);
	});

	it('solo network: resolve(authorityId) is undefined when the DbFactory never went through the strand path', async () => {
		const factory = new EngineFactory(new LocalStorageReact(), async () => new Database());
		const officer = makeOfficer();
		const networkInit = makeNetworkInit(officer.user.name);

		await factory.getNetworksEngine().create(networkInit, officer.user);
		const refs = await factory.getNetworksEngine().getRecentNetworks();
		const ref = refs.find((r: {name: string}) => r.name === networkInit.name);
		if (!ref) throw new Error('test setup: network not found in recentNetworks');
		await factory.getEngine('network', ref);

		const source = await factory.getEngine(VOTER_REQUEST_TRANSPORTS_ENGINE);
		const resolved = await source.resolve('any-authority-id');

		expect(resolved).toBeUndefined();
	});

	it('peer-backed network: resolve(authorityId) is defined with registrationRoute "peer", and addStrand was called once with strandRow.Id === the network hash', async () => {
		const factory = new EngineFactory(new LocalStorageReact(), async () => new Database());
		const node = makeFakeStrandHost();
		factory.setNode(node);

		const officer = makeOfficer();
		const networkInit = makeNetworkInit(officer.user.name);

		await factory.getNetworksEngine().create(networkInit, officer.user);
		const refs = await factory.getNetworksEngine().getRecentNetworks();
		const ref = refs.find((r: {name: string}) => r.name === networkInit.name);
		if (!ref) throw new Error('test setup: network not found in recentNetworks');

		expect(node.addStrandCalls).toHaveLength(1);
		expect(node.addStrandCalls[0]!.strandRow.Id).toBe(ref.hash);

		await factory.getEngine('network', ref);
		const source = await factory.getEngine(VOTER_REQUEST_TRANSPORTS_ENGINE);
		const resolved = await source.resolve('authority-does-not-matter-for-the-peer-flag');

		expect(resolved).toBeDefined();
		expect(resolved.registrationRoute).toBe('peer');
		// addStrand still called exactly once — getEngine('network', ref) on an already-cached
		// hash must not re-open the strand.
		expect(node.addStrandCalls).toHaveLength(1);
	});

	it('network switch: clearEngineCache() + re-establishing a network returns a NEW requestTransports source object, not the cached one', async () => {
		const factory = new EngineFactory(new LocalStorageReact(), async () => new Database());
		const officer = makeOfficer();
		const networkInit = makeNetworkInit(officer.user.name);

		await factory.getNetworksEngine().create(networkInit, officer.user);
		const refs = await factory.getNetworksEngine().getRecentNetworks();
		const ref = refs.find((r: {name: string}) => r.name === networkInit.name);
		if (!ref) throw new Error('test setup: network not found in recentNetworks');

		await factory.getEngine('network', ref);
		const sourceBefore = await factory.getEngine(VOTER_REQUEST_TRANSPORTS_ENGINE);

		factory.clearEngineCache();

		await factory.getEngine('network', ref);
		const sourceAfter = await factory.getEngine(VOTER_REQUEST_TRANSPORTS_ENGINE);

		expect(sourceAfter).not.toBe(sourceBefore);
	});

	it('delegation: resolveVoterRequestTransports calls getEngine with exactly "requestTransports" and returns resolve(authorityId) unchanged', async () => {
		const sentinel = {registrationRoute: 'peer'};
		const resolve = jest.fn(async (authorityId: string) => (authorityId === 'authority-1' ? sentinel : undefined));
		const getEngine = jest.fn(async (engineName: string) => {
			expect(engineName).toBe(VOTER_REQUEST_TRANSPORTS_ENGINE);
			return {resolve};
		});

		const result = await resolveVoterRequestTransports({getEngine, authorityId: 'authority-1'});

		expect(getEngine).toHaveBeenCalledTimes(1);
		expect(getEngine).toHaveBeenCalledWith(VOTER_REQUEST_TRANSPORTS_ENGINE);
		expect(resolve).toHaveBeenCalledWith('authority-1');
		expect(result).toBe(sentinel);
	});

	it('delegation: a rejection from getEngine propagates unchanged', async () => {
		const boom = new Error('getEngine boom');
		const getEngine = jest.fn(async () => {
			throw boom;
		});

		await expect(resolveVoterRequestTransports({getEngine, authorityId: 'authority-1'})).rejects.toBe(boom);
	});

	it('delegation: a rejection from source.resolve propagates unchanged', async () => {
		const boom = new Error('resolve boom');
		const resolve = jest.fn(async () => {
			throw boom;
		});
		const getEngine = jest.fn(async () => ({resolve}));

		await expect(resolveVoterRequestTransports({getEngine, authorityId: 'authority-1'})).rejects.toBe(boom);
	});
});
