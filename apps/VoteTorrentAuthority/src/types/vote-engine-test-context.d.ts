// Type surface for `@votetorrent/vote-engine/test/fixtures/test-context`.
//
// That specifier is a jest-only moduleNameMapper alias (jest.config.js and
// jest.node.config.js map it to packages/vote-engine/test/fixtures/test-context.ts).
// tsc cannot resolve it (TS2307). A `paths` mapping was tried first and rejected: it
// type-checks the whole fixture graph under the Authority's compiler options and added
// four TS2345 errors in key-release-ceremony.realschema.test.ts. So this file declares
// exactly the exports the Authority tests use. The runtime mapping is unchanged.
//
// The shapes mirror packages/vote-engine/test/fixtures/test-context.ts. The engine
// handles (networksEngine, electionsEngine) are typed `unknown` where the tests only
// pass them through; `ctx` carries the db the tests drive directly.
declare module '@votetorrent/vote-engine/test/fixtures/test-context' {
	import type {
		Authority,
		ElectionInit,
		IAuthorityEngine,
		IElectionEngine,
		INetworkEngine,
		NetworkInit,
		NetworkReference,
		Signature,
		User,
	} from '@votetorrent/vote-core';
	import type { DbFactory, EngineContext, ElectionsEngine, NetworksEngine } from '@votetorrent/vote-engine/rn';

	// `ctx.db` is `any` on purpose: the tests hand it to helpers that declare a narrow
	// structural `{ prepare(sql): { get(...) } }` parameter, which the real quereus
	// Database does not satisfy under tsc. The five `require(...) as {...}` importers
	// already cast it to `any` (AnyDb); typing it precisely surfaced four TS2345 errors.
	export type TestEngineContext = Omit<EngineContext, 'db'> & { db: any };

	export interface TestNetworkContext {
		networksEngine: NetworksEngine;
		networkEngine: INetworkEngine;
		ctx: TestEngineContext;
		user: User;
		ref: NetworkReference;
	}
	export interface TestAuthorityContext extends TestNetworkContext {
		authorityEngine: IAuthorityEngine;
		authority: Authority;
	}
	export interface TestElectionContext extends TestAuthorityContext {
		electionsEngine: ElectionsEngine;
		electionEngine: IElectionEngine;
	}

	export function createTestNetwork(overrides?: {
		user?: Partial<User>;
		network?: Partial<NetworkInit>;
		dbFactory?: DbFactory;
	}): Promise<TestNetworkContext>;
	export function addTestAuthority(net: TestNetworkContext): Promise<TestAuthorityContext>;
	export function addTestElection(auth: TestAuthorityContext): Promise<TestElectionContext>;
	export function makeTestSignCallback(user: User): (digest: Uint8Array) => Promise<Signature>;
	export function makeDistinctTestUser(): User;
	export function makeElectionInit(overrides?: Partial<ElectionInit['election']>): ElectionInit;
}
