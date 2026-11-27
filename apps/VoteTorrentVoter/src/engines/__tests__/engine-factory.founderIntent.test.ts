/**
 * D-30 ported to the Voter (notes 19 E75): EngineFactory installs the founding window around its
 * own NetworksEngine.create, the call the __DEV__ dev seed (dev-seed.ts) makes for a brand-new
 * network. Mocks `./proof-flags.generated` only, like engine-factory.request-transports.test.ts.
 */
import {Database} from '@quereus/quereus';
import {LocalStorageReact} from '@votetorrent/vote-engine/rn';

jest.mock('../proof-flags.generated', () => ({
	USE_LOCAL_DB_FACTORY: false,
	USE_STUB_ATTESTATION_VERIFIER: false,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {EngineFactory} = require('../engine-factory');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fi = require('../founder-intent');

describe('EngineFactory founding window (D-30) — Voter', () => {
	it('EF-1 NetworksEngine.create runs inside a founding window', async () => {
		const factory = new EngineFactory(new LocalStorageReact(), async () => new Database());
		const engine = factory.getNetworksEngine();
		expect(Object.prototype.hasOwnProperty.call(engine, 'create')).toBe(true);
		// create claims the one founder-intent slot, so a create while another window is open is refused
		await expect(fi.withFounding(() => engine.create({}, {}))).rejects.toMatchObject({name: 'FounderIntentBusyError'});
		expect(fi.takeFounderIntent('__probe__')).toBeNull();
	});
});
