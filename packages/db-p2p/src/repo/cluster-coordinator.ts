import { peerIdFromString } from "@libp2p/peer-id";
import type { ClusterRecord, IKeyNetwork, RepoMessage, BlockId, ClusterPeers, MessageOptions, Signature } from "@votetorrent/db-core";
import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "multiformats/hashes/sha2";
import { ClusterClient } from "../cluster/client.js";
import { Pending } from "@votetorrent/db-core";
import type { PeerId } from "@libp2p/interface";

/**
 * Manages the state of cluster transactions for a specific block ID
 */
interface ClusterTransactionState {
	messageHash: string;
	record: ClusterRecord;
	pending: Pending<ClusterRecord>;
	lastUpdate: number;
	promiseTimeout?: NodeJS.Timeout;
	resolutionTimeout?: NodeJS.Timeout;
}

/** Manages distributed transactions across clusters */
export class ClusterCoordinator {
	// TODO: move this into a state management interface so that transaction state can be persisted
	private transactions: Map<string, ClusterTransactionState> = new Map();

	constructor(
		private readonly keyNetwork: IKeyNetwork,
		private readonly createClusterClient: (peerId: PeerId) => ClusterClient,
	) { }

	/**
	 * Creates a base 58 BTC string hash for a message to uniquely identify a transaction
	 */
	private async createMessageHash(message: RepoMessage): Promise<string> {
		const msgBytes = new TextEncoder().encode(JSON.stringify(message));
		const hashBytes = await sha256.digest(msgBytes);
		return base58btc.encode(hashBytes.digest);
	}

	/**
	 * Gets all peers in the cluster for a specific block ID
	 */
	private async getClusterForBlock(blockId: BlockId): Promise<ClusterPeers> {
		// Convert blockId to Uint8Array for DHT lookup
		const blockIdBytes = new TextEncoder().encode(blockId);
		return await this.keyNetwork.findCluster(blockIdBytes);
	}

	/**
	 * Initiates a 2-phase transaction for a specific block ID
	 */
	async executeClusterTransaction(blockId: BlockId, message: RepoMessage, options?: MessageOptions): Promise<any> {
		// Get the cluster peers for this block
		const peers = await this.getClusterForBlock(blockId);

		// Create a unique hash for this transaction
		const messageHash = await this.createMessageHash(message);

		// Create a cluster record for this transaction
		const record: ClusterRecord = { messageHash, peers, message, promises: {}, commits: {} };

		// Create a new pending transaction
		const transactionPromise = this.executeTransaction(peers, record);
		const pending = new Pending(transactionPromise);

		// Store the transaction state
		const state: ClusterTransactionState = {
			messageHash,
			record,
			pending,
			lastUpdate: Date.now()
		};
		this.transactions.set(messageHash, state);

		// Wait for the transaction to complete
		return await pending.result();
	}

	/**
	 * Executes the full transaction process
	 */
	private async executeTransaction(peers: ClusterPeers, record: ClusterRecord): Promise<ClusterRecord> {
		// Phase 1: Collect promises from peers
		const promiseResults = await this.collectPromises(peers, record);

		// Check if we have majority consensus
		const majority = Math.floor(Object.keys(peers).length / 2) + 1;
		if (Object.keys(promiseResults.record.promises).length < majority) {
			throw new Error(`Failed to get majority consensus for transaction ${record.messageHash}`);
		}

		// Phase 2: Commit the transaction
		return await this.commitTransaction(promiseResults.record);
	}

	/**
	 * Collects promises from all peers in the cluster
	 */
	private async collectPromises(peers: ClusterPeers, record: ClusterRecord): Promise<{ record: ClusterRecord }> {
		// For each peer, create a client and request a promise
		const promiseRequests = Object.keys(peers).map(peerIdStr => {
			const peerIdObj = peerIdFromString(peerIdStr);
			const client = this.createClusterClient(peerIdObj);
			const promise = client.update(record);
			return new Pending(promise);
		});

		// Wait for all promises to complete
		const results = await Promise.all(promiseRequests.map(p => p.result().catch(err => {
			console.error('Failed to get promise from peer:', err);
			return null;
		})));

		// Merge all promises into the record
		const updatedRecord = { ...record };
		for (const result of results.filter(Boolean) as ClusterRecord[]) {
			// Merge promises from this peer
			updatedRecord.promises = { ...updatedRecord.promises, ...result.promises };
		}

		return { record: updatedRecord };
	}

	/**
	 * Commits the transaction to all peers in the cluster
	 */
	private async commitTransaction(record: ClusterRecord): Promise<ClusterRecord> {
		// For each peer, create a client and send the commit
		const commitRequests = Object.keys(record.peers).map(peerIdStr => {
			const peerIdObj = peerIdFromString(peerIdStr);
			const client = this.createClusterClient(peerIdObj);
			const promise = client.update({
				...record,
				// Add our commit signature
				commits: { ...record.commits, "self": "signature" as unknown as Signature }
			});
			return new Pending(promise);
		});

		// Wait for all commits to complete
		const results = await Promise.all(commitRequests.map(p => p.result().catch(err => {
			console.error('Failed to commit to peer:', err);
			return null;
		})));

		// Merge all commits into the record
		const updatedRecord = { ...record };
		for (const result of results.filter(Boolean) as ClusterRecord[]) {
			// Merge commits from this peer
			updatedRecord.commits = { ...updatedRecord.commits, ...result.commits };
		}

		return updatedRecord;
	}
}
