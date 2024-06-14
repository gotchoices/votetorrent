export type Value = string | number | boolean;

export interface Answer {
    slotCode: string,
    values: Record<string, Value>,
}

export interface Vote {
    answers: Answer[],
    nonce: string,
}