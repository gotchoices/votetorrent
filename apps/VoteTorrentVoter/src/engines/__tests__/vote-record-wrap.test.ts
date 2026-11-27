/**
 * vote-record-wrap.test.ts - D-13 seam proof (Phase 63 plan 07): the vote alias, auth-required
 * options built in one place, the keyAlias downgrade guard, the native ABI argument positions, the
 * resolver/override, and the setter-reference gate (with a planted-fixture self-test).
 *
 * Native arguments are asserted BY POSITION INDEX, never with a whole-argument-list
 * `toHaveBeenCalledWith`, so a trailing argument appended later does not break this suite.
 */

const mockGetEnforcingState = { shouldThrow: false }

jest.mock('react-native', () => {
	const actual: Record<string, unknown> = jest.requireActual('react-native')
	const attestationNativeFake = {
		wrapSecret: jest.fn(),
		unwrapSecret: jest.fn(),
	}
	const actualTurboModuleRegistry = actual.TurboModuleRegistry as { getEnforcing: (name: string) => unknown }
	const turboModuleRegistryProxy = new Proxy(actualTurboModuleRegistry, {
		get(target, prop, receiver) {
			if (prop === 'getEnforcing') {
				return (name: string) => {
					if (name !== 'AttestationNative') return target.getEnforcing(name)
					if (mockGetEnforcingState.shouldThrow) throw new Error('AttestationNative TurboModule is not registered')
					return attestationNativeFake
				}
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	return new Proxy(actual, {
		get(target, prop, receiver) {
			if (prop === 'TurboModuleRegistry') return turboModuleRegistryProxy
			if (prop === '__attestationNativeFake') return attestationNativeFake
			return Reflect.get(target, prop, receiver)
		},
	})
})

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
	isValidWrapKeyAlias,
	MAX_AUTH_WINDOW_SECONDS,
	VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1,
	type SecretWrapPrompt,
	type WrappedSecret,
} from '@votetorrent/attestation-native'
import { createInMemorySecretWrapperForTests } from '../__fixtures__/in-memory-secret-wrapper'
import {
	VOTE_RECORD_AUTH_WINDOW_SECONDS,
	VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1,
	createNativeVoteRecordWrapProvider,
	createVoteRecordWrapProvider,
	resolveVoteRecordWrapProvider,
	setVoteRecordWrapProviderForTests,
	voteRecordWrapOptions,
	type VoteRecordWrapProvider,
} from '../vote-record-wrap'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake } = require('react-native') as {
	__attestationNativeFake: { wrapSecret: jest.Mock; unwrapSecret: jest.Mock }
}

const PROMPT: SecretWrapPrompt = { title: 'Title', subtitle: 'Subtitle', negativeButton: 'Cancel' }

function b64(bytes: Uint8Array): string {
	let s = ''
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
	return btoa(s)
}

describe('fixture: createInMemorySecretWrapperForTests', () => {
	const aad = new Uint8Array([1, 2, 3])
	it('wraps and unwraps, counting one prompt per call', async () => {
		const w = createInMemorySecretWrapperForTests()
		const wrapped = await w.wrapSecret(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1, new Uint8Array([5, 6]), { requireAuth: true, aad, prompt: PROMPT })
		expect(wrapped.keyAlias).toBe(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1)
		expect(wrapped.securityLevel).toBe('test-stub')
		expect(w.promptCount).toBe(1)
		const out = await w.unwrapSecret(wrapped, { requireAuth: true, aad, prompt: PROMPT })
		expect(Array.from(out)).toEqual([5, 6])
		expect(w.promptCount).toBe(2)
	})

	it('enforces the 4,096 B cap', async () => {
		const w = createInMemorySecretWrapperForTests()
		const opts = { requireAuth: true, aad, prompt: PROMPT }
		await expect(w.wrapSecret(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1, new Uint8Array(4097).fill(1), opts)).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		})
		await expect(w.wrapSecret(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1, new Uint8Array(4096).fill(1), opts)).resolves.toBeDefined()
	})

	it('models prompt, policy, missing key and AAD semantics', async () => {
		const w = createInMemorySecretWrapperForTests()
		const alias = VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1
		await expect(w.wrapSecret(alias, new Uint8Array([1]), { requireAuth: true, aad })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
		const wrapped = await w.wrapSecret(alias, new Uint8Array([1]), { requireAuth: true, aad, prompt: PROMPT })
		await expect(w.wrapSecret(alias, new Uint8Array([1]), { requireAuth: false, aad })).rejects.toMatchObject({
			code: 'WRAP_KEY_POLICY_MISMATCH',
		})
		await expect(
			w.unwrapSecret({ ...wrapped, keyAlias: 'VOTETORRENT_OTHER_WRAP_KEY_V1' }, { requireAuth: true, aad, prompt: PROMPT }),
		).rejects.toMatchObject({ code: 'NO_WRAP_KEY' })
		await expect(w.unwrapSecret(wrapped, { requireAuth: true, aad: new Uint8Array([9]), prompt: PROMPT })).rejects.toMatchObject({
			code: 'UNWRAP_TAG_MISMATCH',
		})
	})

	it('failNextCall fails exactly one call', async () => {
		const w = createInMemorySecretWrapperForTests()
		const opts = { requireAuth: true, aad, prompt: PROMPT }
		const wrapped = await w.wrapSecret(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1, new Uint8Array([1]), opts)
		w.failNextCall('unwrap', 'CANCELED')
		await expect(w.unwrapSecret(wrapped, opts)).rejects.toMatchObject({ code: 'CANCELED' })
		await expect(w.unwrapSecret(wrapped, opts)).resolves.toBeDefined()
	})
})

describe('vote record wrap seam', () => {
	afterEach(() => setVoteRecordWrapProviderForTests(undefined))

	it('alias is the literal, valid, and distinct from the identity alias', () => {
		expect(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1).toBe('VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1')
		expect(isValidWrapKeyAlias(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1)).toBe(true)
		expect(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1).not.toBe(VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1)
	})

	it('VOTE_RECORD_AUTH_WINDOW_SECONDS is an integer in 0..MAX_AUTH_WINDOW_SECONDS and is pinned to 10 (R-5)', () => {
		expect(Number.isInteger(VOTE_RECORD_AUTH_WINDOW_SECONDS)).toBe(true)
		expect(VOTE_RECORD_AUTH_WINDOW_SECONDS).toBeGreaterThanOrEqual(0)
		expect(VOTE_RECORD_AUTH_WINDOW_SECONDS).toBeLessThanOrEqual(MAX_AUTH_WINDOW_SECONDS)
		// 63-18 updates this pin if it applies the R-5 fallback (flip to 0).
		expect(VOTE_RECORD_AUTH_WINDOW_SECONDS).toBe(10)
	})

	it('voteRecordWrapOptions returns exactly { requireAuth: true, aad, prompt, authWindowSeconds }', () => {
		const aad = new Uint8Array([1])
		expect(voteRecordWrapOptions(aad, PROMPT)).toEqual({
			requireAuth: true,
			aad,
			prompt: PROMPT,
			authWindowSeconds: VOTE_RECORD_AUTH_WINDOW_SECONDS,
		})
	})

	it('provider wraps and unwraps under the vote alias with requireAuth true', async () => {
		const fixture = createInMemorySecretWrapperForTests()
		const provider = createVoteRecordWrapProvider(fixture)
		const aad = new Uint8Array([4, 4])
		const wrapped = await provider.wrap(new Uint8Array([7, 8, 9]), aad, PROMPT)
		expect(fixture.calls).toEqual([{ op: 'wrap', keyAlias: VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1, requireAuth: true, promptTitle: 'Title' }])
		const out = await provider.unwrap(wrapped, aad, PROMPT)
		expect(Array.from(out)).toEqual([7, 8, 9])
		expect(fixture.calls[1]!.requireAuth).toBe(true)
		expect(fixture.promptCount).toBe(2)
	})

	it('unwrap refuses a wrapped key naming the identity alias before any wrapper call', async () => {
		const fixture = createInMemorySecretWrapperForTests()
		const provider = createVoteRecordWrapProvider(fixture)
		const bad: WrappedSecret = {
			v: 1,
			alg: 'AES-256-GCM',
			keyAlias: VOTETORRENT_VOTER_IDENTITY_WRAP_KEY_V1,
			ivBase64: b64(new Uint8Array(12)),
			ciphertextBase64: b64(new Uint8Array(48)),
			securityLevel: 'test-stub',
		}
		await expect(provider.unwrap(bad, new Uint8Array([1]), PROMPT)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
		expect(fixture.unwrapCalls).toBe(0)
	})

	describe('native path (TurboModule faked)', () => {
		beforeEach(() => {
			nativeFake.wrapSecret.mockReset()
			nativeFake.unwrapSecret.mockReset()
		})

		it('wrap reaches native with the alias, requireAuth true and the prompt copy', async () => {
			nativeFake.wrapSecret.mockImplementation(async (alias: string, ptB64: string) => ({
				ciphertextBase64: b64(new Uint8Array(atob(ptB64).length + 16).fill(7)),
				ivBase64: b64(new Uint8Array(12).fill(1)),
				keyAlias: alias,
				securityLevel: 'tee',
			}))
			await createNativeVoteRecordWrapProvider().wrap(new Uint8Array([1, 2, 3]), new Uint8Array([9]), PROMPT)
			const args = nativeFake.wrapSecret.mock.calls[0]!
			expect(args[0]).toBe(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1)
			expect(args[3]).toBe(true)
			expect(args[4]).toBe('Title')
			expect(args[5]).toBe('Subtitle')
			expect(args[6]).toBe('Cancel')
			expect(args).toHaveLength(8)
			expect(args[7]).toBe(10)
		})

		it('unwrap reaches native with the alias, requireAuth true and the prompt title', async () => {
			nativeFake.unwrapSecret.mockResolvedValue({ plaintextBase64: b64(new Uint8Array([1, 2])) })
			const wrapped: WrappedSecret = {
				v: 1,
				alg: 'AES-256-GCM',
				keyAlias: VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1,
				ivBase64: b64(new Uint8Array(12)),
				ciphertextBase64: b64(new Uint8Array(18)),
				securityLevel: 'tee',
			}
			await createNativeVoteRecordWrapProvider().unwrap(wrapped, new Uint8Array([9]), PROMPT)
			const args = nativeFake.unwrapSecret.mock.calls[0]!
			expect(args[0]).toBe(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1)
			expect(args[4]).toBe(true)
			expect(args[5]).toBe('Title')
			expect(args).toHaveLength(9)
			expect(args[8]).toBe(10)
		})
	})

	it('resolver returns the override while set, then a memoised non-override instance', () => {
		const override: VoteRecordWrapProvider = createVoteRecordWrapProvider(createInMemorySecretWrapperForTests())
		setVoteRecordWrapProviderForTests(override)
		expect(resolveVoteRecordWrapProvider()).toBe(override)
		setVoteRecordWrapProviderForTests(undefined)
		const a = resolveVoteRecordWrapProvider()
		expect(a).not.toBe(override)
		expect(resolveVoteRecordWrapProvider()).toBe(a)
	})
})

describe('auth window model (D-14, R-4): one prompt versus two', () => {
	const alias = VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1
	const aad = new Uint8Array([4, 4])
	const windowed = { requireAuth: true, aad, prompt: PROMPT, authWindowSeconds: 10 }
	let t: number
	const clocked = () => createInMemorySecretWrapperForTests({ nowMs: () => t })

	beforeEach(() => {
		t = 1_000_000
	})

	it('F1 two-prompt world: a fresh fixture prompts on the provider wrap', async () => {
		const fx = clocked()
		await createVoteRecordWrapProvider(fx).wrap(new Uint8Array([1]), aad, PROMPT)
		expect(fx.promptCount).toBe(1)
	})

	it('F2 one-prompt world (A1): an external authentication opens the window, so the wrap is unprompted', async () => {
		const fx = clocked()
		fx.noteExternalAuthentication()
		t += 500
		await createVoteRecordWrapProvider(fx).wrap(new Uint8Array([1]), aad, PROMPT)
		expect(fx.promptCount).toBe(0)
	})

	it('F3 R-4: an unwrap inside the window is unprompted; after the window lapses it prompts (D-13 reopen)', async () => {
		const fx = clocked()
		const provider = createVoteRecordWrapProvider(fx)
		fx.noteExternalAuthentication()
		t += 500
		const wrapped = await provider.wrap(new Uint8Array([1]), aad, PROMPT)
		t += 2000
		await provider.unwrap(wrapped, aad, PROMPT)
		expect(fx.promptCount).toBe(0)
		t += 11_000
		await provider.unwrap(wrapped, aad, PROMPT)
		expect(fx.promptCount).toBe(1)
	})

	it('F4 boundary: exactly the window after the last authentication, the call is prompted', async () => {
		const fx = clocked()
		fx.noteExternalAuthentication()
		t += 10_000 - 1
		await fx.wrapSecret(alias, new Uint8Array([1]), windowed)
		expect(fx.promptCount).toBe(0)
		t += 1 // now exactly 10_000 ms after the external authentication
		await fx.wrapSecret(alias, new Uint8Array([1]), windowed)
		expect(fx.promptCount).toBe(1)
	})

	it('F5 per-use alias with a clock: every requireAuth call is prompted even 1 ms after an authentication', async () => {
		const fx = clocked()
		const perUse = { requireAuth: true, aad, prompt: PROMPT }
		await fx.wrapSecret(alias, new Uint8Array([1]), perUse)
		t += 1
		await fx.wrapSecret(alias, new Uint8Array([1]), perUse)
		fx.noteExternalAuthentication()
		t += 1
		await fx.wrapSecret(alias, new Uint8Array([1]), perUse)
		expect(fx.promptCount).toBe(3)
	})

	it('F6 policy: the window is part of the alias policy, on wrap and on unwrap', async () => {
		const fx = clocked()
		const provider = createVoteRecordWrapProvider(fx)
		const wrapped = await provider.wrap(new Uint8Array([1]), aad, PROMPT)
		expect(fx.aliasPolicy(alias)).toEqual({ requireAuth: true, authWindowSeconds: 10 })
		const perUse = { requireAuth: true, aad, prompt: PROMPT, authWindowSeconds: 0 }
		await expect(fx.wrapSecret(alias, new Uint8Array([1]), perUse)).rejects.toMatchObject({ code: 'WRAP_KEY_POLICY_MISMATCH' })
		await expect(fx.unwrapSecret(wrapped, perUse)).rejects.toMatchObject({ code: 'WRAP_KEY_POLICY_MISMATCH' })

		const other = clocked()
		await other.wrapSecret(alias, new Uint8Array([1]), perUse)
		await expect(other.wrapSecret(alias, new Uint8Array([1]), windowed)).rejects.toMatchObject({ code: 'WRAP_KEY_POLICY_MISMATCH' })
		expect(other.aliasPolicy('VOTETORRENT_NEVER_WRAP_KEY_V1')).toBeUndefined()
	})

	it('F7 validation mirror: bad windows reject INVALID_ARGUMENT before any call is counted', async () => {
		const fx = clocked()
		const base = { aad, prompt: PROMPT }
		await expect(fx.wrapSecret(alias, new Uint8Array([1]), { ...base, requireAuth: false, authWindowSeconds: 5 })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		})
		await expect(fx.wrapSecret(alias, new Uint8Array([1]), { ...base, requireAuth: true, authWindowSeconds: 61 })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		})
		await expect(fx.wrapSecret(alias, new Uint8Array([1]), { ...base, requireAuth: true, authWindowSeconds: 1.5 })).rejects.toMatchObject({
			code: 'INVALID_ARGUMENT',
		})
		expect(fx.calls.length).toBe(0)
	})

	it('F8 cancel: a cancelled prompted call counts a prompt but opens no window', async () => {
		const fx = clocked()
		fx.failNextCall('wrap', 'CANCELED')
		await expect(fx.wrapSecret(alias, new Uint8Array([1]), windowed)).rejects.toMatchObject({ code: 'CANCELED' })
		expect(fx.promptCount).toBe(1)
		t += 100
		await fx.wrapSecret(alias, new Uint8Array([1]), windowed)
		expect(fx.promptCount).toBe(2)
	})

	it('F9 noteExternalAuthentication without a clock throws and names the missing clock', () => {
		const fx = createInMemorySecretWrapperForTests()
		expect(() => fx.noteExternalAuthentication()).toThrow(/nowMs clock/)
	})

	it('back-compat: with no clock a windowed provider wrap then 2 unwraps counts 3 prompts (the per-call upper bound)', async () => {
		const fx = createInMemorySecretWrapperForTests()
		const provider = createVoteRecordWrapProvider(fx)
		const wrapped = await provider.wrap(new Uint8Array([1]), aad, PROMPT)
		await provider.unwrap(wrapped, aad, PROMPT)
		await provider.unwrap(wrapped, aad, PROMPT)
		expect(fx.promptCount).toBe(3)
	})
})

describe('setter-reference gate', () => {
	const SRC_ROOT = resolve(__dirname, '../..')
	const TOKEN = 'setVoteRecord' + 'WrapProviderForTests'
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'vote-record-wrap-gate-'))
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	function strip(src: string): string {
		const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' '))
		return noBlock.replace(/\/\/.*$/gm, '')
	}

	function scan(root: string): Array<{ file: string; line: number }> {
		const out: Array<{ file: string; line: number }> = []
		const stack = [root]
		while (stack.length > 0) {
			const d = stack.pop() as string
			for (const entry of readdirSync(d)) {
				const p = join(d, entry)
				if (statSync(p).isDirectory()) {
					if (entry !== 'node_modules') stack.push(p)
					continue
				}
				if (!/\.(ts|tsx)$/.test(entry)) continue
				if (/\.test\.(ts|tsx)$/.test(entry)) continue
				if (entry === 'vote-record-wrap.ts') continue
				strip(readFileSync(p, 'utf8'))
					.split('\n')
					.forEach((text, idx) => {
						if (text.includes(TOKEN)) out.push({ file: p, line: idx + 1 })
					})
			}
		}
		return out
	}

	it('no production file under src references the setter', () => {
		expect(scan(SRC_ROOT)).toEqual([])
	})

	it('catches the token in code at the right file and line, and ignores it in a comment', () => {
		mkdirSync(join(dir, 'nested'))
		writeFileSync(join(dir, 'nested', 'bad.ts'), `const a = 1\n${TOKEN}(undefined)\n`)
		writeFileSync(join(dir, 'ok.ts'), `// ${TOKEN}\n/* ${TOKEN} */\nconst b = 2\n`)
		const found = scan(dir)
		expect(found).toEqual([{ file: join(dir, 'nested', 'bad.ts'), line: 2 }])
	})
})
