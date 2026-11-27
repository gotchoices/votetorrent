/**
 * authority-node.binding.test.ts — the five Authority node modules (owner-trust, identity-owner-key,
 * pool-rendezvous-host, self-voucher, strand-port-adapter) moved to `@votetorrent/workflows` (phase 67
 * plan 07); the app paths under `engines/` are bindings. A binding that re-implemented logic, or a second
 * `OwnerTrustUnreadableError` class, would fork the workflow, so this pins identity with the shared exports,
 * the forwarders' cadre-core hand-off and each binding's value specifiers.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// `mock`-prefixed so jest's hoisted module factory can reference them.
const mockKeyPair = jest.fn((key: { id: string }) => ({ publicKeyB64: `pub-${key.id}`, privateKeyB64: `priv-${key.id}` }));
const mockOwnerSigner = jest.fn((privateKeyB64: string) => ({ publicKey: privateKeyB64.replace(/^priv-/, 'pub-'), approve: jest.fn() }));
const mockVerify = jest.fn();
const mockVerifyAdmission = jest.fn();
jest.mock(
	'@serfab/cadre-core',
	() => ({
		ed25519KeyPairFromLibp2p: (key: { id: string }) => mockKeyPair(key),
		softwareOwnerSigner: (privateKeyB64: string) => mockOwnerSigner(privateKeyB64),
		verifyCadrePeerVoucher: (...a: unknown[]) => mockVerify(...a),
		verifyInvitationAdmission: (...a: unknown[]) => mockVerifyAdmission(...a),
	}),
	{ virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const shared = require('@votetorrent/workflows/authority') as Record<string, unknown>;
import * as ownerTrustBinding from '../owner-trust';
import * as identityOwnerKeyBinding from '../identity-owner-key';
import * as poolRendezvousHostBinding from '../pool-rendezvous-host';
import * as selfVoucherBinding from '../self-voucher';
import * as strandPortAdapterBinding from '../strand-port-adapter';

const ENGINES = resolve(__dirname, '..');
/** `apps/VoteTorrentAuthority/src/engines/__tests__` -> repo root -> `packages/workflows/src/authority`. */
const WORKFLOWS_AUTHORITY = resolve(__dirname, '..', '..', '..', '..', '..', 'packages/workflows/src/authority');

function strip(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
}

/** Value specifiers only: `import x from`, `import {..} from`, `import '..'`, `export {..} from`, `require('..')`. */
export function valueSpecifiers(src: string): string[] {
	const text = strip(src);
	const out: string[] = [];
	for (const m of text.matchAll(/\b(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
		if (m[2] !== undefined) continue;
		out.push(m[4]!);
	}
	for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
	for (const m of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
	return out;
}

const engineText = (file: string) => readFileSync(resolve(ENGINES, file), 'utf8');
const sharedText = (file: string) => readFileSync(resolve(WORKFLOWS_AUTHORITY, file), 'utf8');
const sortedKeys = (m: object) => Object.keys(m).sort();

beforeEach(() => {
	mockKeyPair.mockClear();
	mockOwnerSigner.mockClear();
	mockVerify.mockReset();
	mockVerifyAdmission.mockReset();
});

describe('B-1 identity: the pure re-export bindings are the shared exports', () => {
	const OWNER_TRUST_VALUES = [
		'OWNER_REANCHOR_TIMEOUT_MS',
		'OWNER_TRUST_CLASSIFY_TIMEOUT_MS',
		'OwnerTrustUnreadableError',
		'classifyOwnerTrust',
		'reanchorOwnKey',
		'readOwnerTrustClassification',
	];

	it('owner-trust exports exactly the six values and each is the shared one', () => {
		expect(sortedKeys(ownerTrustBinding)).toEqual([...OWNER_TRUST_VALUES].sort());
		for (const name of OWNER_TRUST_VALUES) {
			expect((ownerTrustBinding as Record<string, unknown>)[name]).toBe(shared[name]);
		}
	});

	it('pool-rendezvous-host exports exactly hostPoolRendezvous, the shared one', () => {
		expect(sortedKeys(poolRendezvousHostBinding)).toEqual(['hostPoolRendezvous']);
		expect(poolRendezvousHostBinding.hostPoolRendezvous).toBe(shared.hostPoolRendezvous);
	});

	it('strand-port-adapter exports exactly createStrandPort, the shared one', () => {
		expect(sortedKeys(strandPortAdapterBinding)).toEqual(['createStrandPort']);
		expect(strandPortAdapterBinding.createStrandPort).toBe(shared.createStrandPort);
	});
});

describe('B-2 forwarders: identity-owner-key and self-voucher supply the app cadre-core', () => {
	it('each forwarder exports exactly one function that is not the shared one', () => {
		expect(sortedKeys(identityOwnerKeyBinding)).toEqual(['withIdentityOwnerKey']);
		expect(sortedKeys(selfVoucherBinding)).toEqual(['isSelfVouched']);
		expect(typeof identityOwnerKeyBinding.withIdentityOwnerKey).toBe('function');
		expect(typeof selfVoucherBinding.isSelfVouched).toBe('function');
		expect(identityOwnerKeyBinding.withIdentityOwnerKey).not.toBe(shared.withIdentityOwnerKey);
		expect(selfVoucherBinding.isSelfVouched).not.toBe(shared.isSelfVouched);
	});

	it('withIdentityOwnerKey derives lazily through the app cadre-core helpers', () => {
		const node = identityOwnerKeyBinding.withIdentityOwnerKey({ wireOwnKeyIfOwner: jest.fn() }, { id: 'a' } as never);
		expect(mockKeyPair).toHaveBeenCalledTimes(0);
		expect(node.getIdentityOwnerKey()).toEqual({ publicKeyB64: 'pub-a', privateKeyB64: 'priv-a' });
		expect(mockKeyPair).toHaveBeenCalledTimes(1);
		node.getIdentityOwnerSigner();
		expect(mockOwnerSigner).toHaveBeenCalledWith('priv-a');
	});

	it('isSelfVouched hands the voucher row to the app verifyCadrePeerVoucher', async () => {
		mockVerify.mockReturnValue(true);
		const node = {
			partyId: 'p',
			getTrustedOwnerStore: () => ({ has: (k: string) => k === 'owner' }),
			getControlDatabase: () => ({
				queryCadrePeers: async () => [{ peerId: 'self', stampId: 's', vouchOwner: 'owner', vouchSig: 'sig', vouchUsage: null }],
				queryCadreInviteUsages: async () => [],
				queryCadreInvites: async () => [],
			}),
		} as unknown as Parameters<typeof selfVoucherBinding.isSelfVouched>[0];
		await expect(selfVoucherBinding.isSelfVouched(node, 'self')).resolves.toBe(true);
		expect(mockVerify).toHaveBeenCalledTimes(1);
		expect(mockVerify).toHaveBeenCalledWith('p', 'self', 's', 'owner', 'sig');
	});

	it('isSelfVouched hands an invitation-admitted row to the app verifyInvitationAdmission', async () => {
		mockVerifyAdmission.mockReturnValue(false);
		const node = {
			partyId: 'p',
			getTrustedOwnerStore: () => ({ has: (k: string) => k === 'owner' }),
			getControlDatabase: () => ({
				queryCadrePeers: async () => [{ peerId: 'self', stampId: 's', vouchOwner: 'owner', vouchSig: null, vouchUsage: 'u' }],
				queryCadreInviteUsages: async () => [{ usageStampId: 'u', inviteKey: 'k' }],
				queryCadreInvites: async () => [{ key: 'k' }],
			}),
		} as unknown as Parameters<typeof selfVoucherBinding.isSelfVouched>[0];
		await expect(selfVoucherBinding.isSelfVouched(node, 'self')).resolves.toBe(false);
		expect(mockVerifyAdmission).toHaveBeenCalledTimes(1);
		expect(mockVerifyAdmission.mock.calls[0]![0]).toBe('p');
	});
});

describe('B-3 binding text: each binding value-imports only what a binding may', () => {
	it('owner-trust, pool-rendezvous-host and strand-port-adapter import only the shared package', () => {
		for (const file of ['owner-trust.ts', 'pool-rendezvous-host.ts', 'strand-port-adapter.ts']) {
			expect(valueSpecifiers(engineText(file))).toEqual(['@votetorrent/workflows/authority']);
		}
	});

	it('identity-owner-key and self-voucher import the app cadre-core plus the shared package', () => {
		for (const file of ['identity-owner-key.ts', 'self-voucher.ts']) {
			expect([...valueSpecifiers(engineText(file))].sort()).toEqual(['@serfab/cadre-core', '@votetorrent/workflows/authority']);
		}
	});
});

describe('B-4 shared text: the shared seam files never value-import cadre-core', () => {
	it('identity-owner-key.ts and self-voucher.ts have no cadre-core value specifier', () => {
		for (const file of ['identity-owner-key.ts', 'self-voucher.ts']) {
			expect(valueSpecifiers(sharedText(file))).not.toContain('@serfab/cadre-core');
		}
	});

	it('control: a planted value import of cadre-core is detected', () => {
		const planted = "import { verifyCadrePeerVoucher } from '@serfab/cadre-core';\n" + sharedText('self-voucher.ts');
		expect(valueSpecifiers(planted)).toContain('@serfab/cadre-core');
	});
});
