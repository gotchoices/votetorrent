import { expect } from 'chai'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	DEFAULT_BIND_HOST,
	DEFAULT_GRACE_WINDOW_MINUTES,
	DEFAULT_MAX_UPLOAD_BYTES,
	DEFAULT_PORT,
	DEFAULT_SWEEP_INTERVAL_SECONDS
} from '../src/config.js'
import { BOOTSTRAP_RENDEZVOUS_ROUTES } from '../src/server.js'
// The SHARED parser, imported rather than reimplemented: the smoke script runs
// the same code over the same document, so the two can never disagree about
// what a runnable step is.
import { OperatorStepError, extractOperatorSteps } from '../scripts/operator-steps.mjs'

/**
 * operator-docs.spec.ts — the gate that keeps `OPERATOR.md` mechanically true.
 *
 * A document that cannot drift is worth far more than a document that was
 * accurate once. Prose review cannot see a variable name that the service never
 * reads, a default that was right last month, an endpoint that does not exist,
 * or a deployment step that was deleted from the middle of a list. Each of those
 * is a red test here, naming the offending token.
 *
 * **Nothing below transcribes a value.** The defaults are the imported
 * `DEFAULT_*` constants, the endpoints are the imported route table, and the
 * variable names are extracted from `src/config.ts` itself. A transcribed
 * expectation would drift in lockstep with the document it is supposed to
 * police, which is the failure mode this file exists to prevent.
 *
 * Every path is resolved from this file's own URL through `fileURLToPath`, never
 * from `process.cwd()`, so the suite is independent of how mocha was invoked.
 */

const testDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(testDir, '..')
const repoRoot = join(packageRoot, '..', '..')
const srcDir = join(packageRoot, 'src')

const OPERATOR_MD_PATH = join(packageRoot, 'OPERATOR.md')
const README_PATH = join(packageRoot, 'README.md')
const CONFIG_TS_PATH = join(srcDir, 'config.ts')
const SMOKE_SCRIPT_PATH = join(repoRoot, 'scripts', 'run-bootstrap-operator-smoke.sh')
const DASHBOARD_PACKAGE_JSON_PATH = join(repoRoot, 'apps', 'VoteTorrentDashboard', 'package.json')

const operatorMd = readFileSync(OPERATOR_MD_PATH, 'utf8')
const readmeMd = readFileSync(README_PATH, 'utf8')
const configTs = readFileSync(CONFIG_TS_PATH, 'utf8')
const smokeScript = readFileSync(SMOKE_SCRIPT_PATH, 'utf8')

/** Every `BOOTSTRAP_RENDEZVOUS_`-prefixed token, wherever it appears. */
const PREFIXED_TOKEN = /BOOTSTRAP_RENDEZVOUS_[A-Z0-9_]+/g

/**
 * The authoritative set of keys the service actually parses.
 *
 * `src/config.ts` does not index the environment with string literals — it
 * declares one `ENV_*` constant per key and indexes with the constant, which is
 * better code and means a naive `env['…']` scan finds nothing at all. So the set
 * is built in two halves: the declared constants, filtered to those that are
 * genuinely *read out of the environment* somewhere in the same module. A
 * constant that is declared but never used to read `env` is not a parsed key and
 * would be a documentation trap if it were treated as one.
 */
function parsedEnvironmentKeys (source: string): { keys: string[], unusedConstants: string[] } {
	const declaration = /export const (ENV_[A-Z0-9_]+)\s*=\s*'([A-Za-z0-9_]+)'/g
	const keys: string[] = []
	const unusedConstants: string[] = []
	let match: RegExpExecArray | null
	while ((match = declaration.exec(source)) !== null) {
		const constantName = match[1] as string
		const literal = match[2] as string
		// The three shapes config.ts uses to read the environment:
		//   env[ENV_X]            direct index
		//   requireString(env, ENV_X, …)  / parseInteger(env, ENV_X, …)
		const readsEnvironment =
			source.includes(`env[${constantName}]`) ||
			source.includes(`env, ${constantName},`) ||
			source.includes(`env, ${constantName})`)
		if (readsEnvironment) {
			keys.push(literal)
		} else {
			unusedConstants.push(constantName)
		}
	}
	return { keys, unusedConstants }
}

function collectTypeScriptSources (dir: string): string[] {
	const found: string[] = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) {
			found.push(...collectTypeScriptSources(full))
		} else if (entry.endsWith('.ts')) {
			found.push(full)
		}
	}
	return found
}

/** The text of one `## ` section, heading excluded, up to the next `## `. */
function sectionBody (markdown: string, heading: string): string {
	const lines = markdown.split('\n')
	const start = lines.findIndex((line) => line.trim() === heading)
	if (start === -1) return ''
	const rest = lines.slice(start + 1)
	const end = rest.findIndex((line) => line.startsWith('## '))
	return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** Table rows whose FIRST cell is exactly the given name in backticks. Anything
 * else — a troubleshooting row that merely quotes the name inside a message —
 * must not be mistaken for the variable's own row. */
function tableRowsForVariable (markdown: string, variable: string): string[] {
	const pattern = new RegExp('^\\|\\s*`' + variable + '`\\s*\\|')
	return markdown.split('\n').filter((line) => pattern.test(line))
}

function uniqueMatches (text: string, pattern: RegExp): string[] {
	const found = text.match(pattern) ?? []
	return [...new Set(found)].sort()
}

describe('operator docs: environment variable parity', () => {
	const { keys: parsedKeys, unusedConstants } = parsedEnvironmentKeys(configTs)

	it('extracts a non-empty, complete parsed-key set from the configuration module', () => {
		// Positive control FIRST: an extractor that matched nothing would make
		// every parity assertion below pass vacuously.
		expect(parsedKeys.length, 'no environment keys were extracted from src/config.ts').to.be.greaterThan(0)
		expect(unusedConstants, 'ENV_* constants declared but never used to read the environment').to.deep.equal([])
		// Twelve today. A thirteenth key is perfectly legitimate — but it means
		// this number and the document's table change in the SAME commit, which
		// is exactly the coupling being enforced.
		expect(parsedKeys.length, `parsed keys: ${parsedKeys.join(', ')}`).to.equal(12)
	})

	it('documents every key the service parses, in the environment-variable section', () => {
		const section = sectionBody(operatorMd, '## Environment variables')
		expect(section.length, 'the "## Environment variables" section is missing or empty').to.be.greaterThan(200)
		// Report every missing name at once rather than failing on the first.
		const missing = parsedKeys.filter((key) => !section.includes(key))
		expect(missing, 'parsed keys absent from the environment-variable section').to.deep.equal([])
	})

	it('names no variable the service does not parse, anywhere in the document', () => {
		// The direction that matters most: an operator who exports a name the
		// service never reads gets a silently ignored setting, which is worse
		// than an undocumented one.
		const documented = uniqueMatches(operatorMd, PREFIXED_TOKEN)
		const unknown = documented.filter((token) => !parsedKeys.includes(token))
		expect(unknown, 'names in OPERATOR.md that the service never parses').to.deep.equal([])
	})

	it('names no variable in src/ that the configuration module does not parse', () => {
		// `BOOTSTRAP_RENDEZVOUS_ROUTES` is the exported route table's identifier,
		// not an environment key. It is the only code identifier sharing the
		// prefix, and it is allow-listed here by name rather than by pattern so a
		// second one cannot slip in unnoticed.
		const CODE_IDENTIFIERS = ['BOOTSTRAP_RENDEZVOUS_ROUTES']
		const offenders: string[] = []
		for (const file of collectTypeScriptSources(srcDir)) {
			for (const token of uniqueMatches(readFileSync(file, 'utf8'), PREFIXED_TOKEN)) {
				if (parsedKeys.includes(token) || CODE_IDENTIFIERS.includes(token)) continue
				offenders.push(`${file}: ${token}`)
			}
		}
		// A refusal message naming a variable the config module never parses
		// would send an operator chasing a setting that does not exist.
		expect(offenders, 'src/ names an environment variable that is never parsed').to.deep.equal([])
	})
})

describe('operator docs: documented defaults match the compiled constants', () => {
	const expectedDefaults: { variable: string, value: string }[] = [
		{ variable: 'BOOTSTRAP_RENDEZVOUS_BIND_HOST', value: DEFAULT_BIND_HOST },
		{ variable: 'BOOTSTRAP_RENDEZVOUS_PORT', value: String(DEFAULT_PORT) },
		{ variable: 'BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES', value: String(DEFAULT_MAX_UPLOAD_BYTES) },
		{ variable: 'BOOTSTRAP_RENDEZVOUS_GRACE_WINDOW_MINUTES', value: String(DEFAULT_GRACE_WINDOW_MINUTES) },
		{ variable: 'BOOTSTRAP_RENDEZVOUS_SWEEP_INTERVAL_SECONDS', value: String(DEFAULT_SWEEP_INTERVAL_SECONDS) },
		// The three opt-in flags have no exported constant — `parseOptIn`
		// returns false for an absent value — so their documented default is
		// asserted against the literal the parser implements.
		{ variable: 'BOOTSTRAP_RENDEZVOUS_ALLOW_NON_LOOPBACK', value: 'false' },
		{ variable: 'BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST', value: 'false' },
		{ variable: 'BOOTSTRAP_RENDEZVOUS_DEV_LOGGING', value: 'false' }
	]

	for (const { variable, value } of expectedDefaults) {
		it(`documents ${variable} as ${value}`, () => {
			const rows = tableRowsForVariable(operatorMd, variable)
			// Assert the row was FOUND before asserting its contents, so a
			// missing row fails as "row not found" and not as a baffling value
			// mismatch against the empty string.
			expect(rows.length, `expected exactly one table row whose first cell is \`${variable}\``).to.equal(1)
			expect(rows[0], `documented default for ${variable}`).to.contain(value)
		})
	}

	it('locates rows discriminatingly rather than matching everything', () => {
		// Positive control for the lookup itself: the port row must NOT contain
		// the byte ceiling. A lookup that returned the whole document would pass
		// every assertion above.
		const portRow = tableRowsForVariable(operatorMd, 'BOOTSTRAP_RENDEZVOUS_PORT')[0] ?? ''
		expect(portRow).to.contain(String(DEFAULT_PORT))
		expect(portRow).to.not.contain(String(DEFAULT_MAX_UPLOAD_BYTES))
	})
})

describe('operator docs: runnable steps', () => {
	// Extracted in a hook rather than at registration time, so a document the
	// parser REFUSES surfaces as a named failing suite carrying the refusal
	// message, instead of as an unhandled error during file load.
	let steps: { n: number, slug: string, background: boolean, script: string, line: number }[] = []
	before(() => {
		steps = extractOperatorSteps(operatorMd)
	})

	it('parses eight steps numbered 1..8 with the documented slugs in order', () => {
		expect(steps.map((step) => step.n)).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8])
		expect(steps.map((step) => step.slug)).to.deep.equal([
			'install',
			'build-engine',
			'build-dashboard',
			'verify-dashboard-build',
			'build-service',
			'preflight',
			'start',
			'verify-serving'
		])
	})

	it('marks exactly one step as long-running, and it is the start step', () => {
		const background = steps.filter((step) => step.background)
		expect(background.map((step) => step.slug)).to.deep.equal(['start'])
	})

	it('builds the dashboard with the workspace name that workspace actually has', () => {
		const buildStep = steps.find((step) => step.slug === 'build-dashboard')
		expect(buildStep, 'no build-dashboard step').to.not.equal(undefined)
		const dashboardName = JSON.parse(readFileSync(DASHBOARD_PACKAGE_JSON_PATH, 'utf8')).name as string
		// Renaming that workspace must break this suite rather than a deploy.
		expect(buildStep?.script.trim()).to.equal(`yarn workspace ${dashboardName} build`)
	})

	it('orders the dashboard build before the preflight, and the preflight before the start', () => {
		const indexOf = (slug: string): number => steps.findIndex((step) => step.slug === slug)
		// This ordering is what makes the stale-build trap unreachable: the
		// build happens, then the gate runs, then the port is bound.
		expect(indexOf('build-dashboard')).to.be.lessThan(indexOf('preflight'))
		expect(indexOf('preflight')).to.be.lessThan(indexOf('start'))
	})

	it('refuses a step set with a gap, naming the missing number', () => {
		// The negative control that proves the parser is load-bearing. A parser
		// that accepted a gap would let a deleted step vanish from the
		// deployment without a single test noticing.
		const synthetic = [
			'```bash',
			'# operator-step: 1 install',
			'yarn install',
			'```',
			'```bash',
			'# operator-step: 2 build-engine',
			'yarn build',
			'```',
			'```bash',
			'# operator-step: 4 start',
			'node dist/main.js',
			'```'
		].join('\n')
		let thrown: unknown = null
		try {
			extractOperatorSteps(synthetic)
		} catch (err) {
			thrown = err
		}
		expect(thrown, 'a gapped step set was accepted').to.be.instanceOf(OperatorStepError)
		expect((thrown as Error).message).to.contain('expected step 3')
	})
})

describe('operator docs: endpoint parity', () => {
	const routePaths = BOOTSTRAP_RENDEZVOUS_ROUTES.map((route) => route.path)

	/**
	 * Deliberately-documented non-routes. Kept to one entry, and it is not a
	 * path at all: the bare reserved prefix, which the document names when it
	 * explains that anything else under it is a JSON 404.
	 */
	const ALLOWED_NON_ROUTES = ['/bootstrap/']

	it('names no endpoint the route table does not have', () => {
		const documented = uniqueMatches(operatorMd, /\/bootstrap\/[A-Za-z0-9_-]*/g)
		const unknown = documented.filter((path) => !routePaths.includes(path) && !ALLOWED_NON_ROUTES.includes(path))
		expect(unknown, 'endpoint paths in OPERATOR.md that the route table does not serve').to.deep.equal([])
	})

	it('documents every endpoint the route table serves', () => {
		const missing = routePaths.filter((path) => !operatorMd.includes(path))
		expect(missing, 'routes the service serves but the document never mentions').to.deep.equal([])
	})

	it('invents no health endpoint', () => {
		// There is no GET API and no health route. A document that promised one
		// would send an operator to build a monitor around a 404.
		expect(operatorMd).to.not.contain('/health')
		expect(operatorMd).to.not.contain('/healthz')
	})
})

describe('operator docs: document hygiene', () => {
	const documents: { name: string, text: string }[] = [
		{ name: 'OPERATOR.md', text: operatorMd },
		{ name: 'README.md', text: readmeMd }
	]

	it('reads two substantial documents', () => {
		// Positive control for every substring assertion below: an empty or
		// truncated file would otherwise satisfy the negative checks silently.
		for (const { name, text } of documents) {
			expect(text.length, `${name} is empty or truncated`).to.be.greaterThan(1000)
		}
	})

	it('carries no internal planning identifier', () => {
		const patterns: { label: string, pattern: RegExp }[] = [
			{ label: 'decision identifier', pattern: /\bD-[0-9]{2}\b/ },
			{ label: 'plan file identifier', pattern: /\b[0-9]{2}-[0-9]{2}-[A-Z]{2,}/ },
			{ label: 'phase reference', pattern: /Phase [0-9]/ }
		]
		for (const { name, text } of documents) {
			for (const { label, pattern } of patterns) {
				const offending = text.split('\n').filter((line) => pattern.test(line))
				expect(offending, `${name} carries a ${label}`).to.deep.equal([])
			}
		}
	})

	it('disambiguates itself from the peer-to-peer relay in both documents', () => {
		for (const { name, text } of documents) {
			expect(/not the libp2p/i.test(text), `${name} lacks the not-the-libp2p disambiguation`).to.equal(true)
		}
	})

	it('carries the load-bearing operator sentences verbatim', () => {
		expect(operatorMd).to.contain('yarn workspace votetorrent-dashboard build')
		// The unscoped workspace name is the single most likely typo, and a
		// scoped one would fail at deploy time rather than here.
		expect(operatorMd).to.not.contain('@votetorrent/votetorrent-dashboard')
		expect(operatorMd).to.contain('at-most-once')
		expect(operatorMd).to.contain('refusing to bind non-loopback host')
		expect(operatorMd).to.contain('ALLOW_NON_LOOPBACK')
	})

	it('discloses the transitive peer-to-peer dependency in plain words', () => {
		const section = sectionBody(operatorMd, '## What is in node_modules, and why libp2p is there')
		expect(section.length, 'the node_modules disclosure section is missing').to.be.greaterThan(400)
		expect(section, 'the disclosure does not name the package it comes from').to.contain(
			'@optimystic/db-p2p-storage-fs'
		)
		// Pinned as an exact SENTENCE rather than a keyword smell test: the claim
		// an operator needs is that this thing joins nothing. Line wrapping is
		// normalised away so re-flowing a paragraph is not a false failure,
		// while changing a word still is.
		const flattened = section.replace(/\s+/g, ' ')
		expect(flattened, 'the disclosure does not state, in one sentence, that nothing is joined').to.contain(
			'This service joins no network, discovers no peers, dials nothing, and opens no sockets other than the one port it listens on — the libp2p modules it drags in are evaluated as definitions and never invoked.'
		)
	})

	it('caps the smoke script at six allowed improvisations', () => {
		const lines = smokeScript.split('\n')
		const start = lines.findIndex((line) => line.includes('ALLOWED IMPROVISATIONS'))
		expect(start, 'the smoke script has no ALLOWED IMPROVISATIONS block').to.be.greaterThan(-1)
		const entries: string[] = []
		for (let index = start + 1; index < lines.length; index += 1) {
			const line = lines[index] as string
			if (!line.startsWith('#')) break
			if (/^#\s+[0-9]+\.\s/.test(line)) entries.push(line)
		}
		// A smoke that is free to improvise proves nothing about the document,
		// so the allow-list is capped and the cap is enforced rather than
		// trusted.
		expect(entries.length, `allowed improvisations:\n${entries.join('\n')}`).to.be.greaterThan(0)
		expect(entries.length, `allowed improvisations:\n${entries.join('\n')}`).to.be.at.most(6)
	})
})
