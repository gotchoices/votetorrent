export interface Option {
    /** The option code */
    code: string,

    /** The option description */
    description: string,

    /** Details about the option */
    details?: string,

    /** Additional information link */
    infoURL?: string,
}

export interface Question {
    /** The slot code on the solicitation describing the position, role, or question filled by this question */
    slotCode: string,

    /** Markdown instructions for this question. */
    instructions: string,

    /** The options to be selected from - must have at least one entry to associate with the answer*/
    options: Option[],

    /** Type of question (default 'select') */
    type: 'select' | 'rank' | 'approve' | 'score' | 'text',

    /** maximum number of options to select (default 1) */
    number?: number,

    /** Preserve the order of the options (default false) */
    ordered?: boolean,
}

export interface Election {
    /** Public key */
    key: string,

    /** Authority's signature of the associated solicitation */
    solicitationSignature: string,

    /** Options to be voted on */
    questions: Question[],

    /** Authority's signature of this election digest */
    signature: string,
}