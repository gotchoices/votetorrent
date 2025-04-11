// import { LocalStorageReact } from './local-storage-react';
// import { KeyNetworkLibp2p } from './key-network-libp2p';
// import { createLibp2pNode } from '../../db-p2p/src/node';
// import type { INetworkEngine, NetworkReference } from '@votetorrent/vote-core';
// import { NetworkEngine } from './network/network-engine';
// import type { IKeyNetwork } from '@votetorrent/db-core';

// const DefaultPort = 9090;

// export async function createNetworkEngine(
// 	init: NetworkReference
// ): Promise<INetworkEngine> {
// 	const localStorage = new LocalStorageReact();
// 	const libp2p = await createLibp2pNode({
// 		port: DefaultPort,
// 		bootstrapNodes: init.bootstrap,
// 	});
// 	const keyNetwork = new KeyNetworkLibp2p(libp2p) as IKeyNetwork;
// 	return await NetworkEngine.connect(init, localStorage, keyNetwork);
// }
