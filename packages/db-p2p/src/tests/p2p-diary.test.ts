import { createLibp2p } from 'libp2p';
import { P2PDiaryCollection } from '../p2p-diary';
import { createNode } from '../../../test-cli/src/node';

describe('P2PDiaryCollection', () => {
  let node1: any;
  let node2: any;
  let diary1: P2PDiaryCollection;
  let diary2: P2PDiaryCollection;

  beforeAll(async () => {
    node1 = await createNode(0);
    node2 = await createNode(0);
    await node2.dial(node1.getMultiaddrs()[0]);
  });

  afterAll(async () => {
    await node1.stop();
    await node2.stop();
  });

  beforeEach(() => {
    diary1 = new P2PDiaryCollection('test-diary', node1);
    diary2 = new P2PDiaryCollection('test-diary', node2);
  });

  test('should sync entries between nodes', async () => {
    const entry = { content: 'Test entry', timestamp: new Date() };
    await diary1.addEntry(entry);

    // Wait for sync
    await new Promise(resolve => setTimeout(resolve, 1000));

    const entries2 = await diary2.getEntries();
    expect(entries2).toHaveLength(1);
    expect(entries2[0].content).toBe('Test entry');
  });
});
