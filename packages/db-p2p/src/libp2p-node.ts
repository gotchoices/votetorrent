import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { clusterService } from './cluster/service';
import { repoService } from './repo/service';
import { coordinatorRepo } from './repo/coordinator-repo';

export type NodeOptions = {
	port: number;
	bootstrapNodes: string[];
	networkName: string;
	id?: string; // optional peer id
	relay?: boolean; // enable relay service
};

export async function createLibp2pNode(options: NodeOptions): Promise<Libp2p> {
	// TODO: continue to build this out per: https://github.com/ipfs/helia/blob/main/packages/helia/src/utils/libp2p-defaults.ts
	// TODO: if no id is provided, try to load from keychain?: https://github.com/ipfs/helia/blob/main/packages/helia/src/utils/libp2p.ts
  const node = await createLibp2p({
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${options.port}`]
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify({
				protocolPrefix: `/p2p/${options.networkName}`
			}),
			// TODO: add ping service
			//ping: ping(),
      dht: kadDHT({
				protocol: `/p2p/${options.networkName}/kad/1.0.0`
			}),
      pubsub: gossipsub(),
			// clusterService: clusterService({
			// 	protocolPrefix: `/p2p/${options.networkName}`
			// }),
			// repoService: repoService({
			// 	protocolPrefix: `/p2p/${options.networkName}`
			// }),
			// storageRepo: storageRepo(options.)
			// repo: coordinatorRepo(options.keyNetwork, options.peerNetwork)
    },
    // Add bootstrap nodes as needed
    peerDiscovery: [
      bootstrap({
        list: options.bootstrapNodes
      })
    ]
  });

  await node.start();
  return node;
}
