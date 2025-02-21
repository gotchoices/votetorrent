export type PoolHeader = {
    /** CID of the peer formed pool */
    cid: string,

		/** CID of the associated election */
		electionCid: string,

    /** CID of the pool coordinator */
    coordinatorCid: string,

    /** Multiaddr of the pool coordinator */
    coordinatorMultiaddr: string,
    /** Expiration timestamp relative to the coordinator */
    expiration: number,

    /** The maximum number of members that can be accepted into the pool */
    capacity: number,
}

/** A summary of a pool which is advertised to others. */
export interface PoolSummary {
    /** The header of the pool */
    header: PoolHeader,

    /** The number of members in the pool */
    memberCount: number,
}

/** A pool member is a participant in a pool. */
export type PoolMember = {
    /** CID of the member */
    cid: string,

    /** Public key of the member used in signature */
    key: string,

    /** Multiaddr of the member */
    multiaddr: string,

    /** The round-trip delay time communicating with the member, relative to the coordinator */
    roundTrip: number,
}

/** A pool is a set of participants who wish to form a block. */
export type Pool = {
    /** The header of the pool */
    header: PoolHeader,

    /** The members of the pool */
    members: PoolMember[],
}
