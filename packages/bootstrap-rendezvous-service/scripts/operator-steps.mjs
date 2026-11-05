#!/usr/bin/env node
/**
 * operator-steps.mjs — the single parser for `OPERATOR.md`'s marked runnable
 * blocks.
 *
 * **This parser is the contract between the deployment document and the smoke
 * script.** The deployment procedure has exactly one definition and it lives in
 * `OPERATOR.md`; nothing else in this repository is allowed to hold a second
 * copy of it. `scripts/run-bootstrap-operator-smoke.sh` executes the document's
 * own fenced blocks through `--emit`, and `test/operator-docs.spec.ts` asserts
 * their shape through `extractOperatorSteps`. One parser, two consumers, zero
 * drift: a step that is wrong in the document is wrong in the run, which is the
 * entire point — a deployment document is only true if somebody runs it.
 *
 * ## What a runnable step is
 *
 * A fenced code block whose language tag is `bash` and whose FIRST line is a
 * marker comment:
 *
 *     # operator-step: <n> <slug>
 *     # operator-step: <n> <slug> background
 *
 * `<n>` is a positive integer, `<slug>` is lowercase letters and hyphens, and
 * the optional trailing `background` token marks a step that does not return
 * (the long-running service process). The marker line is metadata: it is
 * stripped from the emitted script body so a caller can pipe the remainder
 * straight into `bash`.
 *
 * A `bash` fence with no marker is ordinary documentation and is ignored — that
 * is how the environment block, which carries placeholder secrets, stays
 * un-runnable by construction.
 *
 * ## The refusals, and why the gap check is the one that matters
 *
 * A malformed marker, a duplicate step number, a marker in a non-`bash` fence
 * and a marker outside a fence entirely are all `OperatorStepError`s naming the
 * offending line. The refusal that earns its keep is the **gap check**: the set
 * of step numbers must be exactly `1..length`. An editor who deletes a step from
 * the middle of the document and renumbers nothing must break the build, not
 * silently shorten the deployment — a deployment that quietly lost its dashboard
 * build step still passes every prose review ever written.
 *
 * ## CLI
 *
 *   --check        parse and exit 0, or print the refusal and exit 1
 *   --list         one tab-separated `n<TAB>slug<TAB>background` row per step
 *   --emit <n>     that step's script body, with no marker line, on stdout
 *   --file <path>  override the document (default: ../OPERATOR.md, resolved
 *                  from this file's own URL and never from process.cwd())
 *
 * An unknown flag exits 2 with usage on stderr.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** A document that cannot be read as a deployment procedure. */
export class OperatorStepError extends Error {
	constructor (message) {
		super(message)
		this.name = 'OperatorStepError'
	}
}

/** Resolved from this module's own URL so importing it from a spec, or running
 * it from any working directory, reads the same document. */
const DEFAULT_DOCUMENT_URL = new URL('../OPERATOR.md', import.meta.url)

/** Anything that *looks* like a marker, so a malformed one is a loud failure
 * rather than a silently-skipped step. */
const MARKER_PREFIX = /^#\s*operator-step\b/
/** The well-formed marker. */
const MARKER = /^#\s*operator-step:\s+([0-9]+)\s+([a-z][a-z-]*)((?:\s+background)?)\s*$/

function isFenceDelimiter (trimmed) {
	return trimmed.startsWith('```')
}

/** Trims leading and trailing blank lines so `--emit` prints the command and
 * nothing else. */
function joinScript (lines) {
	const body = [...lines]
	while (body.length > 0 && body[0].trim() === '') body.shift()
	while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
	return body.join('\n')
}

/**
 * Parses the runnable steps out of a markdown document.
 *
 * @param {string} markdown
 * @returns {{ n: number, slug: string, background: boolean, script: string, line: number }[]}
 *   sorted ascending by `n`.
 */
export function extractOperatorSteps (markdown) {
	const lines = String(markdown).split('\n')
	const steps = []
	const seenAtLine = new Map()

	let fenceTag = null
	let fenceOpenedAt = 0
	let body = []
	let pending = null

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]
		const trimmed = line.trim()
		const lineNumber = index + 1

		if (fenceTag === null) {
			if (isFenceDelimiter(trimmed)) {
				fenceTag = trimmed.slice(3).trim().toLowerCase()
				fenceOpenedAt = lineNumber
				body = []
				pending = null
				continue
			}
			if (MARKER_PREFIX.test(trimmed)) {
				throw new OperatorStepError(
					`line ${lineNumber}: a runnable-step marker appears outside a fenced code block — ${JSON.stringify(line)}. A step is only runnable when its marker is the first line of a \`\`\`bash fence.`
				)
			}
			continue
		}

		if (isFenceDelimiter(trimmed)) {
			if (pending !== null) {
				steps.push({ ...pending, script: joinScript(body) })
			}
			fenceTag = null
			pending = null
			body = []
			continue
		}

		if (MARKER_PREFIX.test(trimmed)) {
			if (fenceTag !== 'bash') {
				throw new OperatorStepError(
					`line ${lineNumber}: a runnable-step marker appears inside a \`\`\`${fenceTag === '' ? '(untagged)' : fenceTag} fence — ${JSON.stringify(line)}. Only a bash fence may carry one, because only a bash fence is executed.`
				)
			}
			if (body.length > 0) {
				throw new OperatorStepError(
					`line ${lineNumber}: a runnable-step marker must be the FIRST line of its fence (this one is preceded by ${body.length} line(s) opened at line ${fenceOpenedAt}) — ${JSON.stringify(line)}.`
				)
			}
			const match = MARKER.exec(trimmed)
			if (match === null) {
				throw new OperatorStepError(
					`line ${lineNumber}: malformed runnable-step marker ${JSON.stringify(line)}. Expected \`# operator-step: <n> <slug>\` with an optional trailing \` background\`, where <n> is a positive integer and <slug> is lowercase letters and hyphens.`
				)
			}
			const n = Number.parseInt(match[1], 10)
			if (!Number.isInteger(n) || n < 1) {
				throw new OperatorStepError(
					`line ${lineNumber}: runnable-step number must be a positive integer — ${JSON.stringify(line)}.`
				)
			}
			if (seenAtLine.has(n)) {
				throw new OperatorStepError(
					`line ${lineNumber}: runnable step ${n} is declared twice (first at line ${seenAtLine.get(n)}) — ${JSON.stringify(line)}. Two steps sharing a number means one of them never runs.`
				)
			}
			seenAtLine.set(n, lineNumber)
			pending = { n, slug: match[2], background: match[3].trim() === 'background', line: lineNumber }
			continue
		}

		body.push(line)
	}

	if (fenceTag !== null) {
		throw new OperatorStepError(`unterminated fenced code block opened at line ${fenceOpenedAt}.`)
	}

	steps.sort((left, right) => left.n - right.n)

	if (steps.length === 0) {
		throw new OperatorStepError(
			'no runnable steps found. A deployment document with no executable step cannot be validated by following it.'
		)
	}

	// The gap check. A deleted or renumbered step must break here rather than
	// silently shorten the deployment.
	for (let index = 0; index < steps.length; index += 1) {
		const expected = index + 1
		const step = steps[index]
		if (step.n !== expected) {
			throw new OperatorStepError(
				`runnable steps must be numbered 1..${steps.length} with no gap — expected step ${expected} but found step ${step.n} (${step.slug}) at line ${step.line}. A step deleted from the middle of the document must break this parser, not silently shorten the deployment.`
			)
		}
	}

	return steps
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = 'usage: operator-steps.mjs [--file <path>] (--check | --list | --emit <n>)'

function fail (message) {
	process.stderr.write(`operator-steps.mjs: ${message}\n`)
}

function main (argv) {
	let file = null
	let mode = null
	let emitNumber = null

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (argument === '--file') {
			index += 1
			file = argv[index]
			if (file === undefined) {
				fail(`--file requires a path\n${USAGE}`)
				return 2
			}
			continue
		}
		if (argument === '--check' || argument === '--list') {
			mode = argument.slice(2)
			continue
		}
		if (argument === '--emit') {
			index += 1
			const raw = argv[index]
			emitNumber = Number.parseInt(raw ?? '', 10)
			if (!Number.isInteger(emitNumber)) {
				fail(`--emit requires a step number (received: ${JSON.stringify(raw)})\n${USAGE}`)
				return 2
			}
			mode = 'emit'
			continue
		}
		fail(`unknown argument ${JSON.stringify(argument)}\n${USAGE}`)
		return 2
	}

	if (mode === null) {
		fail(`no mode selected\n${USAGE}`)
		return 2
	}

	const documentPath = file === null ? fileURLToPath(DEFAULT_DOCUMENT_URL) : file

	let markdown
	try {
		markdown = readFileSync(documentPath, 'utf8')
	} catch (err) {
		// Never a foreign error's message: it can carry paths this process was
		// handed. The class name is enough to tell ENOENT from EACCES.
		fail(`could not read ${documentPath} (${(err && err.name) || 'Error'})`)
		return 1
	}

	let steps
	try {
		steps = extractOperatorSteps(markdown)
	} catch (err) {
		if (err instanceof OperatorStepError) {
			fail(`${documentPath}: ${err.message}`)
			return 1
		}
		fail(`${documentPath}: ${(err && err.name) || 'Error'}`)
		return 1
	}

	if (mode === 'check') {
		return 0
	}

	if (mode === 'list') {
		for (const step of steps) {
			process.stdout.write(`${step.n}\t${step.slug}\t${step.background ? 'background' : ''}\n`)
		}
		return 0
	}

	const step = steps.find((candidate) => candidate.n === emitNumber)
	if (step === undefined) {
		fail(`no runnable step numbered ${emitNumber} in ${documentPath} (found 1..${steps.length})`)
		return 1
	}
	process.stdout.write(`${step.script}\n`)
	return 0
}

// Self-start only when this module is the process entrypoint, so importing it
// from a spec never runs the CLI. Same guard `src/main.ts` uses.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	// A reader that closes the pipe early (`--list | head`) must not turn into an
	// unhandled EPIPE crash that looks like a parse failure.
	process.stdout.on('error', (error) => {
		if (error && error.code === 'EPIPE') return
		throw error
	})
	process.exitCode = main(process.argv.slice(2))
}
