import { expect } from 'chai'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * source-guards.spec.ts — the enforcement mechanism for two NEGATIVE
 * requirements that no behavioural test can express.
 *
 * **These guards are the only enforcement those two decisions have.** Deleting
 * one, weakening a pattern, or quietly removing a file from the scanned set
 * silently reopens a locked decision, and nothing else in the suite will notice.
 *
 * - The shipped filesystem bootstrap transport must never be wrapped as this
 *   service's store. Its redeem path calls the envelope parser on everything it
 *   reads and throws on anything that is not a valid envelope. A sealed
 *   ciphertext blob is not one, so wrapping that class would make every
 *   redemption throw.
 * - The distributed storage layer is out. The storage package's `exports` map
 *   declares only `"."`, so the barrel import is FORCED and the libp2p module
 *   graph is dragged in transitively whether we like it or not. The guarantee is
 *   therefore about RUNTIME behaviour — measured with a handle census — and not
 *   about an absent import.
 *
 * The scanner is comment-immune ON PURPOSE: both module headers in `src/`
 * explain in prose why those classes are not used, so a naive text scan would
 * flag the service's own documentation and make this gate self-invalidating.
 * `stripComments` is therefore itself under test below; without that self-test
 * the gate could pass while being blind.
 */

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const SRC_DIR = join(PACKAGE_ROOT, 'src')

/**
 * Removes `/* ... *\/` blocks and `// ...` line tails, while leaving string and
 * template literals intact — a `'https://…'` must not be mistaken for a comment
 * and truncate the rest of the line's real code.
 */
function stripComments (source: string): string {
	let out = ''
	let i = 0
	while (i < source.length) {
		const ch = source[i] as string
		const next = source[i + 1]
		if (ch === '/' && next === '*') {
			const end = source.indexOf('*/', i + 2)
			i = end === -1 ? source.length : end + 2
			out += ' '
			continue
		}
		if (ch === '/' && next === '/') {
			const end = source.indexOf('\n', i + 2)
			i = end === -1 ? source.length : end
			out += ' '
			continue
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			const quote = ch
			out += ch
			i++
			while (i < source.length) {
				const c = source[i] as string
				out += c
				i++
				if (c === '\\') {
					if (i < source.length) { out += source[i] as string; i++ }
					continue
				}
				if (c === quote) break
				if (quote !== '`' && c === '\n') break
			}
			continue
		}
		out += ch
		i++
	}
	return out
}

async function collectSourceFiles (dir: string): Promise<string[]> {
	const found: string[] = []
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) found.push(...await collectSourceFiles(full))
		else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(full)
	}
	return found.sort()
}

interface ScannedFile { path: string, label: string, stripped: string }

let scanned: ScannedFile[] = []

before(async () => {
	const files = await collectSourceFiles(SRC_DIR)
	expect(files.length, 'the scanner found no source files — it would pass vacuously').to.be.greaterThan(0)
	scanned = await Promise.all(files.map(async (path) => ({
		path,
		label: relative(PACKAGE_ROOT, path),
		stripped: stripComments(await readFile(path, 'utf8'))
	})))
})

function assertAbsent (tokens: readonly string[]): void {
	const hits: string[] = []
	for (const file of scanned) {
		for (const token of tokens) {
			if (file.stripped.includes(token)) hits.push(`${file.label} references ${token}`)
		}
	}
	expect(hits, hits.join('; ')).to.deep.equal([])
}

describe('source-guards scanner self-test', () => {
	it('ignores a banned name that appears only inside a block comment', () => {
		const fixture = "/* FilesystemBootstrapTransport is deliberately not used */\nconst x = 1\n"
		expect(stripComments(fixture)).to.not.include('FilesystemBootstrapTransport')
	})

	it('ignores a banned name that appears only inside a line comment', () => {
		const fixture = 'const x = 1 // never import FileRawStorage here\n'
		expect(stripComments(fixture)).to.not.include('FileRawStorage')
	})

	it('flags the same name when it appears outside a comment', () => {
		const fixture = "import { FileRawStorage } from '@optimystic/db-p2p-storage-fs'\n"
		expect(stripComments(fixture)).to.include('FileRawStorage')
	})

	it('does not mistake a URL inside a string literal for a line comment', () => {
		const fixture = "const u = 'https://example.test/x'; const banned = KvRawStorage\n"
		const stripped = stripComments(fixture)
		expect(stripped).to.include('https://example.test/x')
		expect(stripped).to.include('KvRawStorage')
	})

	it('keeps code that follows a block comment on the same line', () => {
		expect(stripComments('const a = 1; /* note */ const b = FileRawStorage')).to.include('FileRawStorage')
	})
})

describe('source-guards D-24: the filesystem bootstrap transport is never wrapped', () => {
	it('no src file references it — its redeem path parses every blob it reads and would throw on sealed ciphertext', () => {
		assertAbsent([
			'FilesystemBootstrapTransport',
			'filesystem-bootstrap-transport',
			'parseSnapshot',
			'verifySnapshot'
		])
	})
})

describe('source-guards: only the KV half of the storage package is used', () => {
	it('no src file references the raw/file-storage half', () => {
		assertAbsent(['FileRawStorage', 'KvRawStorage', 'file-storage', 'FileStoreDriver'])
	})

	it('positive control: at least one src file imports FileKVStore from the barrel', () => {
		const importers = scanned.filter((f) =>
			/import\s*\{\s*FileKVStore\s*\}\s*from\s*'@optimystic\/db-p2p-storage-fs'/.test(f.stripped)
		)
		expect(importers.map((f) => f.label)).to.deep.equal(['src/store.ts'])
	})
})

describe('source-guards: no P2P construction in the service source', () => {
	it("none of these appear in src — they ARE present transitively in node_modules via the forced barrel import, so this covers the service's own code only", () => {
		assertAbsent(['libp2p', 'CadreNode', '@libp2p/', 'gossipsub', 'kad-dht', 'multiaddr'])
	})
})

describe('source-guards: the barrel import is forced, not chosen', () => {
	it('a deep specifier is rejected, carrying the literal ERR_PACKAGE_PATH_NOT_EXPORTED', async () => {
		let thrown: unknown
		try {
			await import('@optimystic/db-p2p-storage-fs/dist/src/file-kv-store.js')
		} catch (err) {
			thrown = err
		}
		expect(thrown, 'the deep import resolved — the exports map must have changed').to.not.equal(undefined)
		// In-process the ts-node ESM loader re-wraps the resolver's error and drops
		// its `code`, moving the literal to the head of the message. Assert the
		// literal either way, and pin the exact `code` in the clean child below.
		const err = thrown as NodeJS.ErrnoException
		const carrier = err.code ?? err.message
		expect(carrier).to.match(/^ERR_PACKAGE_PATH_NOT_EXPORTED/)
	})

	it('in a clean process with no loader in the way, err.code is exactly ERR_PACKAGE_PATH_NOT_EXPORTED', async function () {
		this.timeout(60000)
		const code = [
			'let out = { code: null, resolved: false }',
			'try {',
			"  await import('@optimystic/db-p2p-storage-fs/dist/src/file-kv-store.js')",
			'  out.resolved = true',
			'} catch (err) { out.code = err.code ?? null }',
			"process.stdout.write('DEEP' + JSON.stringify(out))"
		].join('\n')
		const { stdout } = await execFileAsync(
			process.execPath,
			['--input-type=module', '-e', code],
			{ cwd: PACKAGE_ROOT }
		)
		const marker = stdout.indexOf('DEEP')
		expect(marker, `child produced no marker: ${stdout}`).to.not.equal(-1)
		const out = JSON.parse(stdout.slice(marker + 'DEEP'.length)) as { code: string | null, resolved: boolean }
		expect(out.resolved).to.equal(false)
		expect(out.code).to.equal('ERR_PACKAGE_PATH_NOT_EXPORTED')
	})

	it('positive control: the bare barrel specifier imports and exposes FileKVStore', async () => {
		const mod = await import('@optimystic/db-p2p-storage-fs')
		expect(typeof mod.FileKVStore).to.equal('function')
	})
})

describe('source-guards D-21: importing the storage graph binds nothing', () => {
	const PREFIXES = ['tcp', 'udp', 'pipe', 'connect', 'dns', 'childprocess']

	/** An inline copy of the census filter, deliberately NOT imported from the
	 * store module — a static import of it would load the very module whose
	 * import is under measurement and make the baseline inert. */
	function census (): string[] {
		return process.getActiveResourcesInfo()
			.filter((name) => PREFIXES.some((p) => name.toLowerCase().startsWith(p)))
			.sort()
	}

	it('in-process: the baseline is taken strictly before the first dynamic import of the store', async () => {
		const before = census()
		const mod = await import('../src/store.js')
		expect(typeof mod.createRendezvousStores).to.equal('function')
		expect(census()).to.deep.equal(before)
	})

	it('in a FRESH process where the store import is provably first, the graph binds no socket, dials nothing and starts no node — this does NOT prove the dependency tree is small, and it does NOT claim the graph is inert in every sense (see the benign-resource note below)', async function () {
		this.timeout(180000)
		// Two things must be warmed BEFORE the baseline or the measurement is about
		// the harness rather than the subject:
		//   1. `./src/claim.ts` — the sibling module that imports only
		//      `node:fs/promises` and `node:path`. Loading it first pays the
		//      TypeScript loader's one-time cost.
		//   2. `process.stdin` / `stdout` / `stderr` — a named-export sync inside the
		//      dependency graph touches the `process.stdin` getter, which lazily
		//      constructs a Socket and therefore a PipeWrap. That is stdio, not a
		//      network handle; materialising it up front keeps it out of the delta.
		//
		// FORBIDDEN is the load-bearing list: every async resource type that would
		// mean a socket was bound, a peer was dialled, a TLS session was started or a
		// process was spawned. Measured with `async_hooks`, which sees construction
		// even when the resource is unref'd and therefore invisible to
		// `getActiveResourcesInfo`.
		const code = [
			"import ah from 'node:async_hooks'",
			"await import('./src/claim.ts')",
			"void process.stdin; process.stdout.write('warm\\n'); process.stderr.write('warm\\n')",
			"const PREFIXES = ['tcp','udp','pipe','connect','dns','childprocess']",
			'const census = () => process.getActiveResourcesInfo().filter(n => PREFIXES.some(p => n.toLowerCase().startsWith(p))).sort()',
			'const seen = new Set()',
			'ah.createHook({ init (_id, type) { if (type !== \'PROMISE\') seen.add(type) } }).enable()',
			'const before = census()',
			"await import('./src/store.ts')",
			'const after = census()',
			"process.stdout.write('CENSUS' + JSON.stringify({ before, after, seen: [...seen].sort() }))"
		].join('\n')
		const { stdout } = await execFileAsync(
			process.execPath,
			['--import', './register-ts-node.mjs', '--input-type=module', '-e', code],
			{ cwd: PACKAGE_ROOT, env: { ...process.env, TS_NODE_PROJECT: './tsconfig.test.json' }, maxBuffer: 16 * 1024 * 1024 }
		)
		const marker = stdout.indexOf('CENSUS')
		expect(marker, `child produced no census marker: ${stdout}`).to.not.equal(-1)
		const result = JSON.parse(stdout.slice(marker + 'CENSUS'.length)) as { before: string[], after: string[], seen: string[] }

		const FORBIDDEN = [
			'TCPWRAP', 'TCPSERVERWRAP', 'TCPSOCKETWRAP', 'TCPCONNECTWRAP',
			'UDPWRAP', 'UDPSENDWRAP', 'CONNECTWRAP', 'TLSWRAP', 'PIPECONNECTWRAP',
			'PROCESSWRAP', 'HTTPCLIENTREQUEST', 'HTTPINCOMINGMESSAGE',
			'HTTP2SESSION', 'HTTP2STREAM', 'SHUTDOWNWRAP', 'WRITEWRAP',
			'GETADDRINFOREQWRAP', 'GETNAMEINFOREQWRAP', 'QUERYWRAP'
		]
		const offenders = result.seen.filter((t) => FORBIDDEN.includes(t))
		expect(offenders, `the storage graph created ${offenders.join(', ')} at import`).to.deep.equal([])
		expect(result.after, 'the storage graph grew the active network-handle census at import').to.deep.equal(result.before)

		// Recorded honestly rather than suppressed: the import DOES construct a
		// `DNSCHANNEL`. That is Node's own `node:dns/promises` module body calling
		// `bindDefaultResolver()`, which happens for ANY importer of that builtin and
		// issues no query — `GETADDRINFOREQWRAP`/`QUERYWRAP`, the resources an actual
		// lookup would create, are in FORBIDDEN above and are asserted absent.
		// `MESSAGEPORT` belongs to the TypeScript loader thread, i.e. the harness.
		// Attribution measured separately: the channel comes from the storage barrel's
		// transitive graph, not from the vote-engine bootstrap subpath.
		expect(result.seen).to.not.include('QUERYWRAP')
	})
})
