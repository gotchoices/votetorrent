/**
 * admin-change-one-prompt.realschema.test.ts — 66.1 gap G-1: one administration-change Confirm is ONE biometric
 * prompt, measured where a prompt happens.
 *
 * Each call of the native `signWithDeviceKey` raises one BiometricPrompt (Android) or one Face ID / Touch ID sheet
 * (iOS): the device key is per-use (D-10), so there is no way to get two signatures out of one authentication. This
 * suite runs the app's own `createDeviceSigner` over a platform-faithful fake of that native call, hands the signer to
 * the REAL AuthorityEngine on the real schema (the screens pass it to `proposeAdmin` the same way), and counts native
 * calls. On device (UAT 66.1 tests 4, 9 and 15) a Confirm that promotes cost two; this suite reads 2 on that engine.
 *
 * The founder is a P-256 device user, as on a phone, so every signature also passes the schema's P-256 CHECKs.
 */

jest.mock('react-native', () => {
	const actual: Record<string, unknown> = jest.requireActual('react-native')
	const attestationNativeFake = {
		signWithDeviceKey: jest.fn(),
	}
	const actualTurboModuleRegistry = actual.TurboModuleRegistry as { getEnforcing: (name: string) => unknown }
	const turboModuleRegistryProxy = new Proxy(actualTurboModuleRegistry, {
		get(target, prop, receiver) {
			if (prop === 'getEnforcing') {
				return (name: string) => (name === 'AttestationNative' ? attestationNativeFake : target.getEnforcing(name))
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	let platformOS = 'android'
	const actualPlatform = actual.Platform as Record<string, unknown>
	const platformProxy = new Proxy(actualPlatform, {
		get(target, prop, receiver) {
			if (prop === 'OS') return platformOS
			return Reflect.get(target, prop, receiver)
		},
	})
	return new Proxy(actual, {
		get(target, prop, receiver) {
			if (prop === 'TurboModuleRegistry') return turboModuleRegistryProxy
			if (prop === 'Platform') return platformProxy
			if (prop === '__setPlatformOS') return (os: string) => { platformOS = os }
			if (prop === '__attestationNativeFake') return attestationNativeFake
			return Reflect.get(target, prop, receiver)
		},
	})
})

jest.mock('../../../engines/device-user', () => ({
	getDeviceUser: jest.fn(),
	isRecoveryInProgress: jest.fn().mockResolvedValue(false),
}))

import { p256 } from '@noble/curves/nist.js'
import { UserKeyType, adminChangeEffectiveAt } from '@votetorrent/vote-core'
import type { AdminInit, OfficerSelection, Proposal, User } from '@votetorrent/vote-core'
import { addTestAuthority, createTestNetwork } from '@votetorrent/vote-engine/test/fixtures/test-context'
import { createDeviceSigner } from '../../../engines/device-signer'
import { getDeviceUser, isRecoveryInProgress } from '../../../engines/device-user'
import { makeFakeNativeP256Signer, type NativeSignPlatform } from '../../../engines/__fixtures__/fake-native-p256-signer'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake, __setPlatformOS: setPlatformOS } = require('react-native') as {
	__attestationNativeFake: { signWithDeviceKey: jest.Mock }
	__setPlatformOS: (os: string) => void
}

const mockGetDeviceUser = getDeviceUser as jest.MockedFunction<typeof getDeviceUser>

jest.setTimeout(120_000)

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

type AdminDetailsLike = {
	admin: { officers: Array<{ userId: string; authorityId: string; title: string; scopes: string[] }>; thresholdPolicies: AdminInit['thresholdPolicies'] }
	pending?: { effectiveAt: string; promoted: boolean }
}

async function foundOnDevice(platform: NativeSignPlatform) {
	const priv = p256.utils.randomSecretKey()
	const pub = hex(p256.getPublicKey(priv, true))
	const founder: Partial<User> = {
		id: `founder-${platform}`,
		name: 'Founder',
		activeKeys: [{ key: pub, type: UserKeyType.p256, expiration: Date.now() + 86_400_000 }],
	}
	const net = await createTestNetwork({ user: founder })
	const auth = await addTestAuthority(net)
	mockGetDeviceUser.mockResolvedValue(net.user)
	nativeFake.signWithDeviceKey.mockImplementation(makeFakeNativeP256Signer(priv, platform).signWithDeviceKey)
	return auth
}

describe.each<NativeSignPlatform>(['android', 'ios'])('administration change Confirm costs one prompt (G-1) on %s', platform => {
	beforeEach(() => {
		setPlatformOS(platform)
		nativeFake.signWithDeviceKey.mockReset()
		mockGetDeviceUser.mockReset()
		;(isRecoveryInProgress as jest.Mock).mockResolvedValue(false)
	})

	it('a title edit that is promoted at once is exactly one native sign call; the Cancel is exactly one more', async () => {
		const auth = await foundOnDevice(platform)
		const engine = auth.authorityEngine as unknown as {
			getAdminDetails(): Promise<AdminDetailsLike>
			proposeAdmin(p: Proposal<AdminInit>, s: Awaited<ReturnType<typeof createDeviceSigner>>): Promise<void>
			cancelAdminChange(t: { effectiveAt: string; userId: string }, s: Awaited<ReturnType<typeof createDeviceSigner>>): Promise<void>
			lastPromotionOutcome?: { status?: string }
		}
		const current = await engine.getAdminDetails()
		const officers: OfficerSelection[] = current.admin.officers.map(o => ({
			existing: { ...o, title: o.userId === auth.user.id ? 'Chair Two' : o.title, scopes: [...o.scopes] },
		})) as OfficerSelection[]
		const effectiveAt = adminChangeEffectiveAt(Date.now())

		// The screen's Confirm: one signer, one proposeAdmin.
		const sign = await createDeviceSigner('Founder')
		await engine.proposeAdmin(
			{ proposed: { officers, effectiveAt, thresholdPolicies: current.admin.thresholdPolicies }, signers: [auth.user.id] },
			sign,
		)

		expect(nativeFake.signWithDeviceKey).toHaveBeenCalledTimes(1)
		expect(engine.lastPromotionOutcome?.status).toBe('promoted')
		const pending = (await engine.getAdminDetails()).pending
		expect(pending?.effectiveAt).toBe(effectiveAt)
		expect(pending?.promoted).toBe(true)

		// Cancel change (66.1-06/-09): still one prompt.
		await engine.cancelAdminChange({ effectiveAt, userId: auth.user.id }, await createDeviceSigner('Founder'))
		expect(nativeFake.signWithDeviceKey).toHaveBeenCalledTimes(2)
		expect((await engine.getAdminDetails()).pending).toBeUndefined()
	})
})
