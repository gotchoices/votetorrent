import { PoolHeader, PoolMember } from "./pool";

export interface BlockHeader extends PoolHeader {
}

export interface BlockMember extends PoolMember {
}

export interface Block {
    header: BlockHeader,
    members: BlockMember[],
}

export interface BlockSignature {
    memberCid: string,
    signature: string,
}

export interface BlockRecord {
    block: Block,
    promises: BlockSignature[],
}
