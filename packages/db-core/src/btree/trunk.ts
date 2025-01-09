import { BlockId, BlockStore } from "../blocks";
import { ITreeNode } from "./nodes";
import { TreeBlock } from "./tree-block";

export interface ITreeTrunk {
	get(): Promise<ITreeNode>;
	set(node: ITreeNode): Promise<void>;
	getId(): Promise<BlockId>;
}

export type getTrunkFunc = (store: BlockStore<TreeBlock>, rootId: BlockId, newId?: BlockId) => ITreeTrunk;
