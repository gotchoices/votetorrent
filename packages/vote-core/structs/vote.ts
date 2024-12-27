export type Value = string | number | boolean;

export interface Answer {
    slotCode: string,
		/**
		 * example: Question type 'select': "values": [ "<option code>", "<option code>" ]
		 * example: Question type 'rank': "values": [ "<option code>", "<option code>" ]
		 * example: Question type 'score': "values": { "<option code>": 0.2, "<option code>": 0.75 }
		 * example: Question type 'text': "values": "<text>"
		 */
    values: Record<string, Value> | string[] | string,
}

export interface Vote {
    answers: Answer[],
}

export type VoteWithNonce = { nonce: string; vote: Vote; };
