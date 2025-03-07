import type { PendRequest, TrxBlocks, IRepo, MessageOptions, CommitResult, GetBlockResults, PendResult, BlockGets, CommitRequest, BlockId, RepoMessage, ClusterPeers, ClusterRecord, Signature, TrxId, IKeyNetwork } from "@votetorrent/db-core";
import { ClusterClient } from "./cluster-client.js";
import { sha256 } from 'multiformats/hashes/sha2'
import { peerIdFromString } from "@libp2p/peer-id";
import { base58btc } from "multiformats/bases/base58";

/**
 * Manages the state of cluster transactions for a specific block ID
 */
interface ClusterTransactionState {
	messageHash: string;
	record: ClusterRecord;
	isCompleted: boolean;
	result: any;
}

/**
 * Manages distributed transactions across clusters
 */
class ClusterTransactionManager {
	// TODO: move this into a state management interface so that transaction state can be persisted
	private transactions: Map<string, ClusterTransactionState> = new Map();

	constructor(
		private readonly network: IKeyNetwork,
	) {}

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
		return await this.network.findCluster(blockIdBytes);
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
		const record: ClusterRecord = {
			messageHash,
			peers,
			message,
			promises: {},
			commits: {}
		};

		// Store the transaction state
		const state: ClusterTransactionState = {
			messageHash,
			record,
			isCompleted: false,
			result: null
		};
		this.transactions.set(messageHash, state);

		try {
			// Phase 1: Collect promises from peers
			const promiseResults = await this.collectPromises(peers, record);

			// Check if we have majority consensus
			const majority = Math.floor(Object.keys(peers).length / 2) + 1;
			if (Object.keys(promiseResults.record.promises).length < majority) {
				throw new Error(`Failed to get majority consensus for transaction ${messageHash}`);
			}

			// Phase 2: Commit the transaction
			const commitResults = await this.commitTransaction(promiseResults.record);

			// Update the transaction state
			state.record = commitResults;
			state.isCompleted = true;
			state.result = commitResults; // The actual result would be extracted from the record

			return state.result;
		} catch (error) {
			// Mark the transaction as failed
			state.isCompleted = true;
			state.result = error;
			throw error;
		}
	}

	/**
	 * Collects promises from all peers in the cluster
	 */
	private async collectPromises(peers: ClusterPeers, record: ClusterRecord): Promise<{ record: ClusterRecord }> {
		// For each peer, create a client and request a promise
		const promiseRequests = Object.keys(peers).map(async (peerIdStr) => {
			try {
				// Create a client for this peer
				const peerIdObj = peerIdFromString(peerIdStr);
				const client = ClusterClient.create(peerIdObj, this.network);
				return await client.update(record);
			} catch (error) {
				console.error(`Failed to get promise from peer ${peerIdStr}:`, error);
				return null;
			}
		});

		// Wait for all promises to resolve
		const results = await Promise.all(promiseRequests);

		// Merge all promises into the record
		const updatedRecord = { ...record };
		for (const result of results) {
			if (result) {
				// Merge promises from this peer
				updatedRecord.promises = { ...updatedRecord.promises, ...result.promises };
			}
		}

		return { record: updatedRecord };
	}

	/**
	 * Commits the transaction to all peers in the cluster
	 */
	private async commitTransaction(record: ClusterRecord): Promise<ClusterRecord> {
		// For each peer, create a client and send the commit
		const commitRequests = Object.keys(record.peers).map(async (peerIdStr) => {
			try {
				// Create a client for this peer
				const peerIdObj = peerIdFromString(peerIdStr);
				const client = ClusterClient.create(peerIdObj, this.network);
				return await client.update({
					...record,
					// Add our commit signature
					commits: { ...record.commits, "self": "signature" as unknown as Signature }
				});
			} catch (error) {
				console.error(`Failed to commit to peer ${peerIdStr}:`, error);
				return null;
			}
		});

		// Wait for all commits to resolve
		const results = await Promise.all(commitRequests);

		// Merge all commits into the record
		const updatedRecord = { ...record };
		for (const result of results) {
			if (result) {
				// Merge commits from this peer
				updatedRecord.commits = { ...updatedRecord.commits, ...result.commits };
			}
		}

		return updatedRecord;
	}
}

/** Cluster coordination repo - uses local store, as well as distributes changes to other nodes using cluster consensus. */
export class Repo implements IRepo {
	private clusterManager: ClusterTransactionManager;

	constructor(
		private readonly network: IKeyNetwork,
		private readonly storeRepo: IRepo,
	) {
		// Cast KeyNetwork to IKeyNetwork to satisfy the type system
		this.clusterManager = new ClusterTransactionManager(network as unknown as IKeyNetwork);
	}

	async get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults> {
		// TODO: Verify that we are a proximate node for all block IDs in the request

		// For read operations, we don't necessarily need full consensus
		// We can randomly select a subset of the cluster to ensure we have agreement
		const blockIds = blockGets.blockIds;

		// Use the local store for the initial read
		const localResults = await this.storeRepo.get(blockGets, options);

		// For each block ID, verify with a subset of the cluster
		// This is a simplified implementation - in a real system, we might want to
		// compare results from multiple peers and ensure consistency
		for (const blockId of blockIds) {
			try {
				// Create a message for this get operation
				const singleBlockGet: BlockGets = {
					blockIds: [blockId],
					context: blockGets.context
				};

				const message: RepoMessage = {
					operations: [{ get: singleBlockGet }],
					expiration: options?.expiration
				};

				// Execute the cluster transaction for this block
				await this.clusterManager.executeClusterTransaction(blockId, message, options);

				// In a real implementation, we would compare the results from the cluster
				// with our local results and resolve any inconsistencies
			} catch (error) {
				console.error(`Error verifying block ${blockId} with cluster:`, error);
				// We might want to mark this block as potentially inconsistent
			}
		}

		return localResults;
	}

	async pend(request: PendRequest, options?: MessageOptions): Promise<PendResult> {
		// TODO: Verify that we are a proximate node for all block IDs in the request

		// Extract all block IDs affected by this pend operation
		const blockIds = Object.keys(request.transforms);

		// Create a message for this pend operation
		const message: RepoMessage = {
			operations: [{ pend: request }],
			expiration: options?.expiration
		};

		// For each block ID, execute a cluster transaction
		const clusterResults = await Promise.all(
			blockIds.map(blockId =>
				this.clusterManager.executeClusterTransaction(blockId, message, options)
			)
		);

		// If all cluster transactions succeeded, apply the pend to the local store
		const localResult = await this.storeRepo.pend(request, options);

		// In a real implementation, we would need to handle partial failures
		// and ensure consistency across the cluster

		return localResult;
	}

	async cancel(trxRef: TrxBlocks, options?: MessageOptions): Promise<void> {
		// TODO: Verify that we are a proximate node for all block IDs in the request

		// Extract all block IDs affected by this cancel operation
		const blockIds = Object.keys(trxRef);

		// Create a message for this cancel operation
		const message: RepoMessage = {
			operations: [{ cancel: { trxRef } }],
			expiration: options?.expiration
		};

		// For each block ID, execute a cluster transaction
		const clusterResults = await Promise.all(
			blockIds.map(blockId =>
				this.clusterManager.executeClusterTransaction(blockId, message, options)
			)
		);

		// If all cluster transactions succeeded, apply the cancel to the local store
		await this.storeRepo.cancel(trxRef, options);

		// In a real implementation, we would need to handle partial failures
		// and ensure consistency across the cluster
	}

	async commit(request: CommitRequest, options?: MessageOptions): Promise<CommitResult> {
		// TODO: Verify that we are a proximate node for all block IDs in the request

		// Extract all block IDs affected by this commit operation
		const blockIds = request.blockIds;

		// Create a message for this commit operation
		const message: RepoMessage = {
			operations: [{ commit: request }],
			expiration: options?.expiration
		};

		// For each block ID, execute a cluster transaction
		const clusterResults = await Promise.all(
			blockIds.map(blockId =>
				this.clusterManager.executeClusterTransaction(blockId, message, options)
			)
		);

		// If all cluster transactions succeeded, apply the commit to the local store
		const localResult = await this.storeRepo.commit(request, options);

		// In a real implementation, we would need to handle partial failures
		// and ensure consistency across the cluster

		return localResult;
	}
}
