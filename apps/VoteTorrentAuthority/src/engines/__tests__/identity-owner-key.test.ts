/**
 * identity-owner-key.ts: the cadre-core 1.18 adapter that keeps the Authority's owner key equal to its
 * identity key. cadre-core's two helpers are mocked by shape; what is pinned here is the adapter's own
 * contract: derived lazily (building the node never throws), derived once, a signer over the same
 * key, and cadre-core's own wireOwnKeyIfOwner left as it is.
 */
const mockKeyPair = jest.fn((key: { id: string }) => ({ publicKeyB64: `pub-${key.id}`, privateKeyB64: `priv-${key.id}` }));
jest.mock(
	'@serfab/cadre-core',
	() => ({
		ed25519KeyPairFromLibp2p: (key: { id: string }) => mockKeyPair(key),
		softwareOwnerSigner: (privateKeyB64: string) => ({ publicKey: privateKeyB64.replace(/^priv-/, 'pub-'), approve: jest.fn() }),
	}),
	{ virtual: true },
);

import { withIdentityOwnerKey } from '../identity-owner-key';

describe('withIdentityOwnerKey', () => {
	beforeEach(() => mockKeyPair.mockClear());

	it('derives nothing until asked, so building the node cannot throw', () => {
		mockKeyPair.mockImplementationOnce(() => { throw new Error('not Ed25519'); });
		const node = withIdentityOwnerKey({ wireOwnKeyIfOwner: jest.fn() }, { id: 'a' } as never);
		expect(mockKeyPair).not.toHaveBeenCalled();
		expect(() => node.getIdentityOwnerKey()).toThrow('not Ed25519');
	});

	it('returns the identity key pair, derived once', () => {
		const node = withIdentityOwnerKey({ wireOwnKeyIfOwner: jest.fn() }, { id: 'a' } as never);
		expect(node.getIdentityOwnerKey()).toEqual({ publicKeyB64: 'pub-a', privateKeyB64: 'priv-a' });
		expect(node.getIdentityOwnerKey()).toBe(node.getIdentityOwnerKey());
		expect(mockKeyPair).toHaveBeenCalledTimes(1);
	});

	it('gives a signer over the same key', () => {
		const node = withIdentityOwnerKey({ wireOwnKeyIfOwner: jest.fn() }, { id: 'b' } as never);
		expect(node.getIdentityOwnerSigner().publicKey).toBe(node.getIdentityOwnerKey().publicKeyB64);
	});

	it('leaves the node\'s own wireOwnKeyIfOwner in place', () => {
		const wire = jest.fn();
		const node = withIdentityOwnerKey({ wireOwnKeyIfOwner: wire }, { id: 'c' } as never);
		expect(node.wireOwnKeyIfOwner).toBe(wire);
	});
});
