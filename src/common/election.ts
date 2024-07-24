export type Deadline = 'signatures' | 'voting' | 'resolution' | 'reporting' | 'validation' | 'close';

export interface Slot {
    /** Identifier representing the slot*/
    code: string,
    /** Markdown describing the position, role, or question to be filled by the eventual election */
    description: string,
    /** The type of election to be held for this slot */
    type: 'single' | 'multiple' | 'ranked' | 'approval' | 'scored',
}

export interface ElectionDetails {
    /** The description/name of the election */
    description: string,

    /** The question slots fulfilled by the eventual election */
    slots: Slot[],

    /** Unix timestamps corresponding to each deadline */
    deadlines: Map<Deadline, number>,

    /** Rules for the pending election */
    rules: Map<string, string>,

    /** Markdown instructions for the election. */
    instructions: string,
}

export interface Election {
    /** Hash key (of details) and identifier for election */
    cid: string,

    /** Details about the election */
    details: ElectionDetails,

    /** Authority's signature of election detail digest */
    signature: string,
}
