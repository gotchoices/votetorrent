export type Value = string | number | boolean;

export interface Answer {
    slotCode: string,
		/**
		 * example: Question type 'select': "values": { "<option code>": true, "<option code>": true, ... }
		 * example: Question type 'rank': "values": { "<option code>": 0, "<option code>": 1, ... }
		 * example: Question type 'approve': "values": { "approved": true }
		 * example: Question type 'score': "values": { "<option code>": 0.2, "<option code>": 0.75, ... }
		 * example: Question type 'text': "values": { "<option code>": "<text>", ... }
		 */
    values: Record<string, Value>,
}

export interface Vote {
    answers: Answer[],
    nonce: string,
}
