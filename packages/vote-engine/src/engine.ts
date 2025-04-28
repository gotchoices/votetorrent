import type { ElectionEngineInit } from "@votetorrent/vote-core";
import { ElectionEngine } from "@votetorrent/vote-core";
import { LocalStorageReact } from "./local-storage-react";
import { KeyNetworkLibp2p } from "./key-network-libp2p";
import { createLibp2pNode } from "../../db-p2p/src/node";

const DefaultPort = 9090;

export async function createElectionEngine(init: ElectionEngineInit): Promise<ElectionEngine> {
	const localStorage = new LocalStorageReact();
	const libp2p = await createLibp2pNode({
		port: DefaultPort,
		bootstrapNodes: init.bootstrap
	});
	const keyNetwork = new KeyNetworkLibp2p(libp2p);
	return await ElectionEngine.connect(init, localStorage, keyNetwork);
}
