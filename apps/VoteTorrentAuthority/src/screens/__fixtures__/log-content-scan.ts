/**
 * Shared checks for the screen tests that prove a screen logs only fixed tags and error class
 * names (REVIEW WR-R5-01). The earlier copies kept only the calls whose first argument was a
 * double-quoted tag harvested from the source, so a log written as a template literal or a
 * concatenation was filtered out before any check ran. These checks look at every call instead:
 *
 *  - `consoleTags(source)`: the literal first arguments of the screen's console.warn/error calls,
 *    in either quote style (or a backtick literal with no interpolation).
 *  - `nonLiteralConsoleFirstArgs(source)`: every console.warn/error call in the source whose first
 *    argument is NOT such a literal. A screen test asserts this is empty, so a log whose tag is
 *    built at runtime fails statically, before any rendering.
 *  - `leakingCalls(calls, secrets)`: every spied call (not only the tagged ones) with an argument
 *    whose inspected form contains a planted secret. Error objects are inspected with their
 *    message and stack, so a raw Error argument cannot hide its text.
 *  - `untaggedCalls(calls, tags, allowed)`: every spied call whose first argument is not one of
 *    the screen's tags, minus the ones the caller names as not this screen's (React's own
 *    warnings). An unknown first argument fails rather than being dropped.
 *
 * Lives outside __tests__ so jest does not collect it as a suite.
 */
import { inspect } from 'util'

const CONSOLE_CALL = /console\.(?:warn|error)\(\s*/g

/** Read one JS string literal starting at `i` (a quote char). Returns [value, end] or undefined. */
function readLiteral(src: string, i: number): [string, number] | undefined {
	const q = src[i]
	if (q !== '"' && q !== "'" && q !== '`') return undefined
	let out = ''
	for (let j = i + 1; j < src.length; j++) {
		const c = src[j]
		if (c === '\\') {
			out += src[j + 1] ?? ''
			j++
			continue
		}
		if (q === '`' && c === '$' && src[j + 1] === '{') return undefined
		if (q !== '`' && c === '\n') return undefined
		if (c === q) return [out, j + 1]
		out += c
	}
	return undefined
}

/**
 * The first argument of each console.warn/error call: `{ literal }` when it is a plain string
 * literal standing alone (followed by `,` or `)`), otherwise `{ raw }` with the source text that
 * starts it.
 */
function firstArgs(src: string): Array<{ literal?: string; raw?: string }> {
	const out: Array<{ literal?: string; raw?: string }> = []
	for (const m of src.matchAll(CONSOLE_CALL)) {
		const at = (m.index ?? 0) + m[0].length
		const lit = readLiteral(src, at)
		if (lit) {
			const after = src.slice(lit[1]).trimStart()[0]
			if (after === ',' || after === ')') {
				out.push({ literal: lit[0] })
				continue
			}
		}
		out.push({ raw: src.slice(at, at + 60).split('\n')[0] })
	}
	return out
}

export function consoleTags(source: string): Set<string> {
	return new Set(firstArgs(source).flatMap((a) => (a.literal === undefined ? [] : [a.literal])))
}

export function nonLiteralConsoleFirstArgs(source: string): string[] {
	return firstArgs(source).flatMap((a) => (a.raw === undefined ? [] : [a.raw]))
}

function argText(a: unknown): string {
	if (typeof a === 'string') return a
	if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}\n${inspect(a, { depth: 4 })}`
	return inspect(a, { depth: 4 })
}

export function leakingCalls(calls: unknown[][], secrets: string[]): string[] {
	const out: string[] = []
	for (const call of calls) {
		const text = call.map(argText).join(' | ')
		if (secrets.some((s) => text.includes(s))) out.push(text.slice(0, 200))
	}
	return out
}

export function untaggedCalls(calls: unknown[][], tags: Set<string>, allowed: (first: unknown) => boolean = () => false): string[] {
	return calls
		.filter((c) => !(typeof c[0] === 'string' && tags.has(c[0])) && !allowed(c[0]))
		.map((c) => argText(c[0]).slice(0, 120))
}
