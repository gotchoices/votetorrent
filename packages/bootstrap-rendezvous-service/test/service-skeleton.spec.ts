import { expect } from 'chai'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	DEFAULT_MAX_UPLOAD_BYTES,
	ServiceConfigError,
	assertLoopbackOrOptedIn,
	loadServiceConfig
} from '../src/config.js'

/**
 * service-skeleton.spec.ts — the package's structural gate.
 *
 * Three of the four blocks below assert a *refusal*, and each one is paired
 * with a positive control so a mistake that made everything throw could not
 * pass as a green suite.
 */

/** The three required keys and nothing else — every default under test is a
 * real default, not a value this helper supplied. */
function baseEnv (): Record<string, string | undefined> {
	return {
		BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN: 'test-upload-token',
		BOOTSTRAP_RENDEZVOUS_DATA_DIR: '/tmp/bootstrap-rendezvous-data',
		BOOTSTRAP_RENDEZVOUS_DIST_DIR: '/tmp/bootstrap-rendezvous-dist'
	}
}

// Resolved from this file's own URL, never from process.cwd(), so the guards
// below are independent of how mocha was invoked.
const testDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(testDir, '..')
const srcDir = join(packageRoot, 'src')

function collectSourceFiles (dir: string): string[] {
	const found: string[] = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) {
			found.push(...collectSourceFiles(full))
		} else if (entry.endsWith('.ts')) {
			found.push(full)
		}
	}
	return found
}

describe('loadServiceConfig defaults', () => {
	it('supplies every optional knob from the module defaults', () => {
		const config = loadServiceConfig(baseEnv())
		expect(config.bindHost).to.equal('127.0.0.1')
		expect(config.port).to.equal(8787)
		expect(config.maxUploadBytes).to.equal(8388608)
		expect(config.maxUploadBytes).to.equal(DEFAULT_MAX_UPLOAD_BYTES)
		expect(config.graceWindowMinutes).to.equal(60)
		expect(config.sweepIntervalSeconds).to.equal(60)
		expect(config.allowNonLoopbackBind).to.equal(false)
		expect(config.logMode).to.equal('production')
	})

	it('carries the required keys through verbatim', () => {
		const config = loadServiceConfig(baseEnv())
		expect(config.uploadToken).to.equal('test-upload-token')
		expect(config.dataDir).to.equal('/tmp/bootstrap-rendezvous-data')
		expect(config.distDir).to.equal('/tmp/bootstrap-rendezvous-dist')
	})

	it('cannot be talked into development logging by a framework convention', () => {
		// The negative control that matters: production stays production no
		// matter what conventional variables the surrounding shell happens to
		// carry. Only the explicit opt-in may change logMode.
		const config = loadServiceConfig({ ...baseEnv(), NODE_ENV: 'development' })
		expect(config.logMode).to.equal('production')
	})
})

describe('loadServiceConfig rejections', () => {
	it('refuses a missing upload token, naming the key', () => {
		const env = baseEnv()
		delete env.BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN
		expect(() => loadServiceConfig(env)).to.throw(ServiceConfigError)
		try {
			loadServiceConfig(env)
			expect.fail('expected loadServiceConfig to throw for a missing upload token')
		} catch (err) {
			expect(err).to.be.instanceOf(ServiceConfigError)
			expect((err as ServiceConfigError).key).to.equal('BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN')
		}
	})

	it('refuses a whitespace-only required key', () => {
		const env = { ...baseEnv(), BOOTSTRAP_RENDEZVOUS_DATA_DIR: '   ' }
		try {
			loadServiceConfig(env)
			expect.fail('expected loadServiceConfig to throw for a whitespace-only data dir')
		} catch (err) {
			expect((err as ServiceConfigError).key).to.equal('BOOTSTRAP_RENDEZVOUS_DATA_DIR')
		}
	})

	it('refuses a non-numeric port, naming the key', () => {
		try {
			loadServiceConfig({ ...baseEnv(), BOOTSTRAP_RENDEZVOUS_PORT: 'abc' })
			expect.fail('expected loadServiceConfig to throw for a non-numeric port')
		} catch (err) {
			expect(err).to.be.instanceOf(ServiceConfigError)
			expect((err as ServiceConfigError).key).to.equal('BOOTSTRAP_RENDEZVOUS_PORT')
		}
	})

	it('refuses a zero upload ceiling, naming the key', () => {
		try {
			loadServiceConfig({ ...baseEnv(), BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES: '0' })
			expect.fail('expected loadServiceConfig to throw for a zero upload ceiling')
		} catch (err) {
			expect(err).to.be.instanceOf(ServiceConfigError)
			expect((err as ServiceConfigError).key).to.equal('BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES')
		}
	})

	it('refuses an unrecognised opt-in value rather than defaulting it off', () => {
		try {
			loadServiceConfig({ ...baseEnv(), BOOTSTRAP_RENDEZVOUS_DEV_LOGGING: 'yes' })
			expect.fail('expected loadServiceConfig to throw for an unrecognised opt-in value')
		} catch (err) {
			expect(err).to.be.instanceOf(ServiceConfigError)
			expect((err as ServiceConfigError).key).to.equal('BOOTSTRAP_RENDEZVOUS_DEV_LOGGING')
		}
	})

	it('positive control: a well-formed environment loads', () => {
		expect(() => loadServiceConfig(baseEnv())).to.not.throw()
	})

	it('positive control: port 0 is accepted so an ephemeral port can be bound', () => {
		const config = loadServiceConfig({ ...baseEnv(), BOOTSTRAP_RENDEZVOUS_PORT: '0' })
		expect(config.port).to.equal(0)
	})

	it('positive control: the opt-in flag is case-insensitive', () => {
		const config = loadServiceConfig({ ...baseEnv(), BOOTSTRAP_RENDEZVOUS_DEV_LOGGING: 'TRUE' })
		expect(config.logMode).to.equal('development')
	})
})

describe('non-loopback bind refusal', () => {
	it('refuses a non-loopback bind host and names the opt-in variable', () => {
		let thrown: unknown
		try {
			loadServiceConfig({ ...baseEnv(), BOOTSTRAP_RENDEZVOUS_BIND_HOST: '0.0.0.0' })
			expect.fail('expected loadServiceConfig to refuse a non-loopback bind host')
		} catch (err) {
			thrown = err
		}
		expect(thrown).to.be.instanceOf(ServiceConfigError)
		const message = (thrown as Error).message
		expect(message).to.contain('refusing to bind non-loopback host')
		expect(message).to.contain('BOOTSTRAP_RENDEZVOUS_ALLOW_NON_LOOPBACK')
		expect((thrown as ServiceConfigError).key).to.equal('BOOTSTRAP_RENDEZVOUS_ALLOW_NON_LOOPBACK')
	})

	it('positive control: every loopback spelling loads with no opt-in at all', () => {
		for (const host of ['127.0.0.1', '::1', 'localhost']) {
			const config = loadServiceConfig({ ...baseEnv(), BOOTSTRAP_RENDEZVOUS_BIND_HOST: host })
			expect(config.bindHost).to.equal(host)
			expect(config.allowNonLoopbackBind).to.equal(false)
		}
	})

	it('positive control: the explicit opt-in permits a non-loopback bind host', () => {
		const config = loadServiceConfig({
			...baseEnv(),
			BOOTSTRAP_RENDEZVOUS_BIND_HOST: '0.0.0.0',
			BOOTSTRAP_RENDEZVOUS_ALLOW_NON_LOOPBACK: 'true'
		})
		expect(config.bindHost).to.equal('0.0.0.0')
		expect(config.allowNonLoopbackBind).to.equal(true)
	})

	it('assertLoopbackOrOptedIn is directly callable and refuses the same way', () => {
		expect(() => assertLoopbackOrOptedIn('192.168.1.10', false)).to.throw(/refusing to bind non-loopback host/)
		expect(() => assertLoopbackOrOptedIn('192.168.1.10', true)).to.not.throw()
		expect(() => assertLoopbackOrOptedIn('127.0.0.1', false)).to.not.throw()
	})
})

describe('package guards', () => {
	const manifestPath = join(packageRoot, 'package.json')
	const manifestText = readFileSync(manifestPath, 'utf8')
	const manifest = JSON.parse(manifestText) as {
		name?: string
		private?: boolean
		type?: string
		scripts?: Record<string, string>
		dependencies?: Record<string, string>
		devDependencies?: Record<string, string>
	}

	it('is a private ESM workspace member with the mandated script names', () => {
		expect(manifest.name).to.equal('@votetorrent/bootstrap-rendezvous-service')
		expect(manifest.private).to.equal(true)
		expect(manifest.type).to.equal('module')
		const scripts = manifest.scripts ?? {}
		for (const script of ['clean', 'build', 'test']) {
			expect(scripts, `package.json scripts must declare ${script} for the root workspace sweep`).to.have.property(script)
		}
	})

	it('declares no HTTP server or client framework', () => {
		const declared = {
			...(manifest.dependencies ?? {}),
			...(manifest.devDependencies ?? {})
		}
		for (const banned of ['express', 'fastify', 'axios', 'node-fetch']) {
			expect(Object.keys(declared), `${banned} must not be declared — this service uses node:http only`).to.not.include(banned)
		}
	})

	it('disambiguates every "relay" reference from the libp2p circuit relay', () => {
		const files = [...collectSourceFiles(srcDir), manifestPath]
		const offenders: string[] = []
		for (const file of files) {
			const lines = readFileSync(file, 'utf8').split('\n')
			lines.forEach((line, index) => {
				const lower = line.toLowerCase()
				if (lower.includes('relay') && !lower.includes('not the libp2p')) {
					offenders.push(`${file}:${index + 1}: ${line.trim()}`)
				}
			})
		}
		expect(offenders, 'every "relay" occurrence must sit on a line that also says NOT the libp2p').to.deep.equal([])
	})

	it('adds no fourth copy of the canonical-datetime guard pattern', () => {
		const needle = '\\d{4}-\\d{2}-\\d{2}'
		const offenders = collectSourceFiles(srcDir).filter((file) => readFileSync(file, 'utf8').includes(needle))
		expect(
			offenders,
			'import assertCanonicalBootstrapDatetime from @votetorrent/vote-engine/bootstrap instead of re-declaring the pattern'
		).to.deep.equal([])
	})

	it('derives the logging mode from no framework convention', () => {
		const configSource = readFileSync(join(srcDir, 'config.ts'), 'utf8')
		expect(configSource).to.not.contain('NODE_ENV')
	})
})
