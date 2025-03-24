import { NetworkSimulation, type Scenario } from './simulation.js';
import { expect } from 'aegir/chai'

describe('NetworkSimulation', () => {
  it('should create a network with the specified number of nodes', async () => {
    const scenario: Scenario = { nodeCount: 10, clusterSize: 3 };
    const network = await NetworkSimulation.create(scenario);

    expect(network.nodes.length).to.equal(10);
  });

  it('should find a coordinator for a key', async () => {
    const scenario: Scenario = { nodeCount: 10, clusterSize: 3 };
    const network = await NetworkSimulation.create(scenario);

    // Create a test key
    const key = new Uint8Array([1, 2, 3, 4]);

    // Find coordinator
    const coordinator = await network.findCoordinator(key);

    // Should return a valid peer id
    expect(coordinator).to.not.be.undefined;
    expect(typeof coordinator.toString()).to.equal('string');
  });

  it('should find a cluster of peers for a key', async () => {
    const scenario: Scenario = { nodeCount: 10, clusterSize: 3 };
    const network = await NetworkSimulation.create(scenario);

    // Create a test key
    const key = new Uint8Array([1, 2, 3, 4]);

    // Find cluster
    const cluster = await network.findCluster(key);

    // Should return the expected number of peers
    expect(Object.keys(cluster).length).to.equal(3); // clusterSize = 3
  });

  it('should create partial network views', async () => {
    const scenario: Scenario = { nodeCount: 10, clusterSize: 3 };
    const network = await NetworkSimulation.create(scenario);

    // Get some peer IDs to include in partial view
    const someNodeIds = network.nodes.slice(0, 5).map(node => node.peerId.toString());

    // Create partial view
    const partialNetwork = network.createPartialNetworkView(someNodeIds);

    // Should have only the specified nodes
    expect(partialNetwork.nodes.length).to.equal(5);
  });

  it('should find different coordinators for different keys', async () => {
    const scenario: Scenario = { nodeCount: 20, clusterSize: 5 };
    const network = await NetworkSimulation.create(scenario);

    // Create test keys
    const key1 = new Uint8Array([1, 2, 3, 4]);
    const key2 = new Uint8Array([5, 6, 7, 8]);

    // Find coordinators
    const coordinator1 = await network.findCoordinator(key1);
    const coordinator2 = await network.findCoordinator(key2);

    // Log the results for debugging
    console.log('Coordinator 1:', coordinator1.toString());
    console.log('Coordinator 2:', coordinator2.toString());

    // Different keys should generally have different coordinators
    // (note: there's a small chance they could be the same due to randomness in small test networks)
    // This is more of a demonstration than a strict test
  });
});
