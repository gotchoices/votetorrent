/**
 * Source-shape guard over packages/attestation-native/ios/AttestationNativeModule.swift (62-127).
 *
 * The four iOS device-key methods must resolve their Keychain tag from the `keyAlias` argument
 * through the single `deviceKeyTag(for:)` mapping, as Android does. Before 62-127 every one of them
 * used the one fixed tag and ignored the alias. This reads the Swift as text (no iOS toolchain
 * needed) and fails if any of the four methods names the fixed tag again.
 *
 * The forbidden token is assembled from pieces so this file's own text can never match it.
 * ATTESTATION_SWIFT_PATH lets the negative control point the guard at a scratch copy.
 */
import * as fs from 'fs';
import * as path from 'path';

const SWIFT =
	process.env.ATTESTATION_SWIFT_PATH ??
	path.resolve(__dirname, '../../../../../packages/attestation-native/ios/AttestationNativeModule.swift');

const FIXED_TAG_REF = ['Self', 'voteKey' + 'Tag'].join('.');
const METHODS = ['provisionDeviceKey', 'getCurrentDeviceKey', 'produceAttestation', 'signWithDeviceKey'];

function methodBody(src: string, name: string): string {
	const start = src.indexOf(`func ${name}(`);
	if (start < 0) throw new Error(`method ${name} not found`);
	const rest = src.slice(start + 1);
	const next = rest.search(/\n {2}(?:private )?func /);
	return next < 0 ? rest : rest.slice(0, next);
}

describe('iOS device-key methods resolve the Keychain tag from keyAlias (62-127)', () => {
	const src = fs.readFileSync(SWIFT, 'utf8');

	for (const name of METHODS) {
		it(`${name} maps the alias through deviceKeyTag(for:) and never the fixed tag`, () => {
			const body = methodBody(src, name);
			expect(body).toContain('deviceKeyTag(for: keyAlias)');
			expect(body.includes(FIXED_TAG_REF)).toBe(false);
		});

		it(`${name} rejects an invalid alias INVALID_ARGUMENT before any Keychain call`, () => {
			const body = methodBody(src, name);
			const mapAt = body.indexOf('deviceKeyTag(for: keyAlias)');
			const rejectAt = body.indexOf('"INVALID_ARGUMENT"');
			expect(rejectAt).toBeGreaterThan(mapAt);
			const keychainAt = body.search(/loadKey\(|probeKeyLiveness\(|deleteKey\(|createSecureEnclaveKey\(|signWith\(|generateKey/);
			expect(keychainAt).toBeGreaterThan(rejectAt);
		});
	}

	it('the legacy alias set is exactly the two aliases in use, mapped to the existing tag', () => {
		const set = src.match(/legacyDeviceKeyAliases: Set<String> = \[([^\]]*)\]/);
		expect(set).not.toBeNull();
		const aliases = [...set![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
		expect(aliases).toEqual(['VOTETORRENT_AUTHORITY_SIGNING_KEY_V1', 'VOTETORRENT_DEVICE_KEY_V1']);
		const fn = src.slice(src.indexOf('func deviceKeyTag(for'));
		const fnBody = fn.slice(0, fn.search(/\n {2}(?:@objc|\/\/\/|\/\/ MARK)/));
		expect(fnBody).toContain('legacyDeviceKeyAliases.contains(alias)');
		expect(fnBody.includes(FIXED_TAG_REF)).toBe(true);
		expect(fnBody).toContain('org.votetorrent.devicekey.');
	});
});
