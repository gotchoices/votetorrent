import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { mplex } from '@libp2p/mplex';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import type { Libp2p } from 'libp2p';

export async function createNode(port: number): Promise<Libp2p> {
  const node = await createLibp2p({
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${port}`]
    },
    transports: [tcp()],
    connectionEncryption: [noise()],
    streamMuxers: [mplex()],
    pubsub: gossipsub(),
    dht: kadDHT(),
    services: {
      dht: kadDHT(),
      pubsub: gossipsub()
    },
    // Add bootstrap nodes as needed
    peerDiscovery: [
      bootstrap({
        list: [
          // Add bootstrap nodes here
        ]
      })
    ]
  });

  await node.start();
  return node;
}
