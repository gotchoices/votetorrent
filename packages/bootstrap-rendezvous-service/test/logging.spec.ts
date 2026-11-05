import { expect } from 'chai'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServiceLogger, errorClass, type LogMode, type ServiceLogger } from '../src/logging.js'
import { createRendezvousStores } from '../src/store.js'
import { startSweeper } from '../src/sweeper.js'

/**
 * logging.spec.ts — the production-silence gate, the exact development line
 * formats, and the cross-plan store/sweeper contract shape.
 *
 * Every line assertion below is exact string equality on purpose: it proves not
 * only that the expected fields are present, but that no extra field can ride
 * along.
 */

function collect (mode: LogMode): { logger: ServiceLogger, lines: string[] } {
	const lines: string[] = []
	const logger = createServiceLogger({ mode, sink: (line) => lines.push(line) })
	return { logger, lines }
}

describe('createServiceLogger production mode', () => {
	it('emits nothing at all for requests and sweeps', () => {
		const { logger, lines } = collect('production')
		logger.request('redeem', 'used', 12)
		logger.sweep({ ciphertextDropped: 1, recordsDropped: 2, recordsRetained: 3 })
		expect(lines).to.have.lengthOf(0)
	})

	it('positive control: a fatal startup error still reaches the operator', () => {
		const { logger, lines } = collect('production')
		logger.fatal('config-invalid', 'boom')
		expect(lines).to.have.lengthOf(1)
		expect(lines[0]).to.equal('bootstrap-rendezvous fatal event=config-invalid message=boom')
	})
})

describe('createServiceLogger development mode', () => {
	it('emits exactly one identifier-free line per event, in the locked format', () => {
		const { logger, lines } = collect('development')
		logger.fatal('config-invalid', 'boom')
		logger.request('redeem', 'used', 12)
		logger.sweep({ ciphertextDropped: 1, recordsDropped: 2, recordsRetained: 3 })
		expect(lines).to.have.lengthOf(3)
		expect(lines[0]).to.equal('bootstrap-rendezvous fatal event=config-invalid message=boom')
		expect(lines[1]).to.equal('bootstrap-rendezvous request route=redeem outcome=used latency_ms=12')
		expect(lines[2]).to.equal('bootstrap-rendezvous sweep ciphertext_dropped=1 records_dropped=2 records_retained=3')
	})

	it('rounds the latency before formatting it', () => {
		const { logger, lines } = collect('development')
		logger.request('upload', 'ok', 12.6)
		expect(lines).to.have.lengthOf(1)
		expect(lines[0]).to.equal('bootstrap-rendezvous request route=upload outcome=ok latency_ms=13')
	})
})

describe('errorClass', () => {
	it('reduces a foreign error to its class name and drops everything else', () => {
		const reduced = errorClass(new TypeError('secret at /var/lib/rendezvous/abc'))
		expect(reduced).to.equal('TypeError')
		expect(reduced).to.not.contain('secret')
		expect(reduced).to.not.contain('/var')
	})

	it('falls back to Error for values that are not errors at all', () => {
		expect(errorClass(undefined)).to.equal('Error')
		expect(errorClass('a string')).to.equal('Error')
		expect(errorClass(null)).to.equal('Error')
	})
})

describe('store and sweeper contract shape', () => {
	// This block is the cross-plan gate. Every assertion here is true of the
	// stub AND of the real implementations that replace them, so it survives
	// the later waves and is exactly the check that catches a drift between
	// the contract declared in this plan and the one that ships.
	const storeMethodNames = [
		'putRecord',
		'getRecord',
		'markRecordUsed',
		'deleteRecord',
		'listRecordIds',
		'putCiphertext',
		'getCiphertext',
		'deleteCiphertext'
	] as const

	it('createRendezvousStores resolves to the ten-member store contract', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-store-'))
		const stores = await createRendezvousStores(dataDir)
		expect(typeof stores.dataDir).to.equal('string')
		expect(typeof stores.claimsDir).to.equal('string')
		for (const name of storeMethodNames) {
			expect(typeof stores[name], `stores.${name} must be a function`).to.equal('function')
		}
	})

	it('startSweeper returns a handle whose stop() is safe to call', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-sweeper-'))
		const store = await createRendezvousStores(dataDir)
		const { logger } = collect('development')
		const handle = startSweeper({ store, graceWindowMinutes: 60, sweepIntervalSeconds: 60, logger })
		expect(() => handle.stop()).to.not.throw()
	})
})
