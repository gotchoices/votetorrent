/**
 * D-30 ported to the Voter (notes 19 E75): the strand factory reads the founder intent.
 *
 * A fresh debug Voter on the rig is connected to the relay before its __DEV__ dev seed creates a
 * network, so "no control connections" read false and the brand-new network opened as a JOINER,
 * hanging on a first sync nobody can supply. A founding window (installed around
 * NetworksEngine.create) must make that one open the founder; every other open keeps the default.
 */

// --- mock the module-load-time native/runtime deps so importing the factory is safe ---
jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), {
  virtual: true,
});

jest.mock('@quereus/quereus', () => {
  const DatabaseMock = jest.fn(function(this: Record<string, jest.Mock>) {
    this.registerModule = jest.fn();
    this.setDefaultVtabName = jest.fn();
    this.setSchemaPath = jest.fn();
    this.exec = jest.fn().mockResolvedValue(undefined);
    this.prepare = jest.fn().mockReturnValue({ all: jest.fn().mockResolvedValue([]) });
  });
  return {
    Database: DatabaseMock,
    registerPlugin: jest.fn(),
  };
}, { virtual: true });

jest.mock('@quereus/plugin-react-native-leveldb', () => ({ ReactNativeLevelDBProvider: jest.fn() }), { virtual: true });

jest.mock('@quereus/store', () => ({
  createIsolatedStoreModule: jest.fn(() => ({ /* stub VirtualTableModule */ })),
}), { virtual: true });

jest.mock(
  '@votetorrent/vote-engine/rn',
  () => ({
    VOTETORRENT_SCHEMA_SQL: 'declare schema main {\n\ttable Network ( Id text );\n}\napply schema main;',
  }),
  { virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrandDbFactory } = require('../rn-db-factory');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fi = require('../founder-intent');

export {};

function makeFakeNode(connections: number) {
  const db = { setSchemaPath: jest.fn(), exec: jest.fn().mockResolvedValue(undefined), prepare: jest.fn() };
  const strand = { strandId: 'fake', database: { getDatabase: () => db } };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addStrand: jest.fn(async (_config: any) => strand),
    getControlNode: jest.fn(() => ({ getConnections: () => new Array(connections).fill({}) })),
    whenStrandWritable: jest.fn(async () => { throw new Error('not configured'); }),
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const founderOf = (node: ReturnType<typeof makeFakeNode>, i = 0) => (node.addStrand.mock.calls[i][0] as any).founder;

describe('createStrandDbFactory — founder intent (D-30) — Voter', () => {
  afterEach(() => {
    expect(fi.takeFounderIntent('__probe__')).toBeNull();
  });

  it('FI-1 a create inside a founding window founds even with the relay connected', async () => {
    const node = makeFakeNode(1);
    await fi.withFounding(() => createStrandDbFactory(node)('devseed1'));
    expect(founderOf(node)).toBe(true);
  });

  it('FI-2 without a window the default is unchanged: a connected node opens as a joiner', async () => {
    const node = makeFakeNode(1);
    await createStrandDbFactory(node)('plainopen');
    expect(founderOf(node)).toBe(false);
  });

  it('FI-3 without a window and with no connections the node founds (the default)', async () => {
    const node = makeFakeNode(0);
    await createStrandDbFactory(node)('soloopen');
    expect(founderOf(node)).toBe(true);
  });

  it('FI-4 the founding window is consumed by exactly one open', async () => {
    const node = makeFakeNode(1);
    const factory = createStrandDbFactory(node);
    await fi.withFounding(async () => {
      await factory('first');
      await factory('second');
    });
    expect(founderOf(node, 0)).toBe(true);
    expect(founderOf(node, 1)).toBe(false);
  });

  it('FI-5 a joined hash never founds, even inside a founding window', async () => {
    const node = makeFakeNode(0);
    await fi.withFounding(() => createStrandDbFactory(node, { isJoinedNetwork: async () => true })('joinedhash'));
    expect(founderOf(node)).toBe(false);
  });
});
