// opened-set-preimage.ts - the canonical preimage of an opened vote set, shared by the in-app decrypt probe and
// the host. It has no imports, so it runs unchanged in Metro, in ts-node and in any later host script.
//
// Host side (64-26 onward): build the expected entries from the choices that were cast, call this function, take
// the lowercase hex sha256 of the UTF-8 of its result, and compare that with the probe's reported digest.
//
// The projection is the ballot id plus the answers only. Nonces are excluded, because the host never knows the
// nonce a phone drew. Each entry becomes the text of [ballotId, [[questionCode, [sorted optionCodes]], ...]] with
// the answers sorted by question code. The entry texts are then sorted with the default sort and the whole list is
// serialised once more.

export interface OpenedAnswer {
	questionCode: string
	optionCodes: string[]
}

export interface OpenedEntry {
	ballotId: string
	answers: OpenedAnswer[]
}

function shapeError (): TypeError {
	return new TypeError('opened-set-shape')
}

function compareCodes (a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function compareAnswers (a: OpenedAnswer, b: OpenedAnswer): number {
	return compareCodes(a.questionCode, b.questionCode)
}

function isStringArray (v: unknown): v is string[] {
	return Array.isArray(v) && v.every(isString)
}

function isString (v: unknown): v is string {
	return typeof v === 'string'
}

function isAnswer (v: unknown): v is OpenedAnswer {
	const a = v as OpenedAnswer | null
	return a !== null && typeof a === 'object' && isString(a.questionCode) && isStringArray(a.optionCodes)
}

function isEntry (v: unknown): v is OpenedEntry {
	const e = v as OpenedEntry | null
	return e !== null && typeof e === 'object' && isString(e.ballotId) && Array.isArray(e.answers) && e.answers.every(isAnswer)
}

function shapeAnswer (a: OpenedAnswer): [string, string[]] {
	return [a.questionCode, a.optionCodes.slice().sort(compareCodes)]
}

function entryText (e: OpenedEntry): string {
	return JSON.stringify([e.ballotId, e.answers.slice().sort(compareAnswers).map(shapeAnswer)])
}

export function openedSetPreimage (entries: OpenedEntry[]): string {
	if (!Array.isArray(entries) || !entries.every(isEntry)) throw shapeError()
	return JSON.stringify(entries.map(entryText).sort())
}
