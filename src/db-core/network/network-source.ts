import crypto from 'crypto';
import { IBlock, BlockType, BlockId, BlockHeader, BlockSource, BlockNetwork, BlockTrxContext } from "../index.js";

export class NetworkSource<TBlock extends IBlock> implements BlockSource<TBlock> {
	constructor(
		private readonly network: BlockNetwork,
		private readonly getTrxContext: () => BlockTrxContext
	) { }

	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader {
		return {
			type,
			id: newId ?? this.generateId(),
		};
	}

	generateId(): BlockId {
		// Need longer than UUID to fully utilize DHT address space
		return crypto.randomBytes(32).toString('base64url');
	}

	async tryGet(id: BlockId): Promise<TBlock | undefined> {
		const result = await this.network.get([{ blockId: id, ...this.getTrxContext() }]);
		return result[0]?.block as TBlock | undefined;
	}
}

