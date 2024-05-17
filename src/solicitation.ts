export type Deadline = 'signatures' | 'voteStart' | 'resolution' | 'reporting' | 'validation' | 'close';

export interface Slot {
    /** Identifier representing the slot*/
    code: string,
    /** Markdown describing the position, role, or question to be filled by the eventual election */
    description: string,
    /** The type of election to be held for this slot */
    type: 'single' | 'multiple' | 'ranked' | 'approval' | 'scored',
}

export interface Solicitation {
    /** Public key for solicitation */
    key: string,

    /** Signature of the associated authority */
    authoritySignature: string,

    /** The description/name of the election */
    description: string,

    /** The question slots fulfilled by the eventual election */
    slots: Slot[],

    /** Unix timestamps corresponding to each deadline */
    deadlines: Map<Deadline, number>,

    /** Rules for the pending election */
    rules: Map<string, string>,

    /** Markdown instructions for the solicitation and election. */
    instructions: string,

    /** Authority's signature of solicitation digest */
    signature: string,
}
