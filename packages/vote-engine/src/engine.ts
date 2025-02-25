import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import type { ElectionEngineInit } from "@votetorrent/vote-core";
import { ElectionEngine } from "@votetorrent/vote-core";
import { LocalStorageReact } from "./local-storage-react";
import { KeyNetworkLibp2p } from "./key-network-libp2p";

const DefaultPort = 9090;

export async function createElectionEngine(init: ElectionEngineInit): Promise<ElectionEngine> {
	const localStorage = new LocalStorageReact();
	const libp2p = await createLibp2pNode(DefaultPort, init.bootstrap);
	const keyNetwork = new KeyNetworkLibp2p(libp2p);
	return await ElectionEngine.connect(init, localStorage, keyNetwork);
}

async function createLibp2pNode(port: number, bootstrapNodes: string[]): Promise<Libp2p> {
  const node = await createLibp2p({
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${port}`]
    },
    transports: [tcp()],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    pubsub: gossipsub(),
    dht: kadDHT(),
    services: {
      dht: kadDHT(),
      pubsub: gossipsub()
    },
    // Add bootstrap nodes as needed
    peerDiscovery: [
      bootstrap({
        list: bootstrapNodes
      })
    ]
  });

  await node.start();
  return node;
}
