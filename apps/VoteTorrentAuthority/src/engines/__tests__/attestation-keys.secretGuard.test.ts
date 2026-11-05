/**
 * WR-10 (Phase 47 review): the committed-secret guard on
 * `attestation-keys.generated.ts`.
 *
 * SETUP.md used to tell an operator to base64-encode the Play Console
 * response-encryption and response-verification keys and put them into
 * `apps/VoteTorrentAuthority/src/engines/attestation-keys.generated.ts` — a
 * GIT-TRACKED file — while also saying "NEVER commit the real key values into
 * git". That combination is a known-bad secret-handling shape: a tracked file,
 * edited in place with a real symmetric decryption key, protected by nothing
 * but operator discipline.
 *
 * This project's own history says that discipline fails. `proof-flags.generated.ts`
 * (the very file SETUP.md cited as the pattern to follow) regularly shows up
 * modified in `git status` whenever a run script's EXIT trap does not fire.
 * The same accident here commits a live decryption key.
 *
 * This test is the mechanical control that replaces the discipline: the
 * TRACKED file's key constants must be empty, always. An operator who
 * provisions real keys locally will see this test go red, which is the point —
 * the red test is the signal that the working tree now holds a secret and must
 * not be committed.
 *
 * It reads the file as TEXT rather than importing the constants, so it fails
 * on what is actually on disk (and therefore what `git add` would stage),
 * not on what some build step might have substituted.
 */

import * as fs from 'fs';
import * as path from 'path';

const KEYS_PATH = path.join(__dirname, '../attestation-keys.generated.ts');

/** Every `export const NAME = '...'` string literal in the file, by name. */
function stringConstants(source: string): Record<string, string> {
	const out: Record<string, string> = {};
	const pattern = /export const (\w+)\s*(?::\s*[^=]+)?=\s*'([^']*)'/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source)) !== null) {
		out[match[1]!] = match[2]!;
	}
	return out;
}

/**
 * Names of the arrays in this file that legitimately hold long literals: the
 * lowercase-hex signing-certificate digests. They are PUBLIC values, not
 * secrets.
 */
const KNOWN_DIGEST_ARRAYS = [
	'PUBLIC_DEBUG_CERT_SHA256_DIGESTS',
	'EXPECTED_APP_CERT_SHA256_DIGESTS',
];

/**
 * Blanks the two known digest arrays out of the source so the long-literal
 * sweep below can be broad instead of narrow (47-REVIEW IN-04).
 *
 * The sweep used to require at least one uppercase letter, '+', '/' or '='
 * purely so the 64-char lowercase-hex digests in this same file would not trip
 * it. That left a real blind spot: a base64 value that happens to contain only
 * lowercase letters and digits evaded it entirely. Excluding the digests BY
 * NAME instead lets the pattern match any long literal, whatever its alphabet.
 */
function withoutKnownDigestArrays(src: string): string {
	let out = src;
	for (const name of KNOWN_DIGEST_ARRAYS) {
		out = out.replace(
			new RegExp(`export const ${name}[^=]*=\\s*\\[[^\\]]*\\]`, 'g'),
			`export const ${name} = []`
		);
	}
	return out;
}

describe('WR-10 committed-secret guard: attestation-keys.generated.ts', () => {
	const source = fs.readFileSync(KEYS_PATH, 'utf8');
	const constants = stringConstants(source);

	it('finds the two Play Console key constants (non-vacuity)', () => {
		// If either name disappears, the guard below would pass vacuously.
		expect(Object.keys(constants)).toContain('PLAY_CONSOLE_DECRYPTION_KEY_BASE64');
		expect(Object.keys(constants)).toContain('PLAY_CONSOLE_VERIFICATION_KEY_BASE64');
	});

	it.each(['PLAY_CONSOLE_DECRYPTION_KEY_BASE64', 'PLAY_CONSOLE_VERIFICATION_KEY_BASE64'])(
		'%s is EMPTY in the tracked file — real key material must never be committed',
		(name) => {
			expect(constants[name]).toBe('');
		}
	);

	it('the file carries no base64-looking literal long enough to be a key', () => {
		// Belt-and-suspenders against a real value landing under a DIFFERENT
		// constant name, or being pasted into a comment. A 32-byte AES key is 44
		// base64 characters. The only long literals that legitimately live here
		// are the cert digests, and they are excluded BY NAME rather than by an
		// alphabet restriction (IN-04) — so this pattern now matches an
		// all-lowercase base64 value too.
		const redacted = withoutKnownDigestArrays(source);
		const suspicious = redacted.match(/'[A-Za-z0-9+/=]{40,}'/g) ?? [];
		expect(suspicious).toEqual([]);
	});

	it('the digest-array exclusion is live and narrow (non-vacuity for the sweep)', () => {
		const redacted = withoutKnownDigestArrays(source);
		// Live: the real digests are gone, so the sweep is not merely passing
		// because the pattern cannot see them.
		expect(source).toMatch(/'[0-9a-f]{64}'/);
		expect(redacted).not.toMatch(/'[0-9a-f]{64}'/);
		// Narrow: only the two arrays are removed, not the constants the primary
		// guard reads.
		expect(redacted).toContain('PLAY_CONSOLE_DECRYPTION_KEY_BASE64');
		expect(redacted).toContain('PLAY_CONSOLE_VERIFICATION_KEY_BASE64');
		// Each name must actually have been recognised, or its exclusion silently
		// did nothing and the sweep would go red on a legitimate public digest.
		for (const name of KNOWN_DIGEST_ARRAYS) {
			expect(redacted).toContain(`export const ${name} = []`);
		}
	});

	it('an all-lowercase base64 value would now be caught (the IN-04 blind spot)', () => {
		// The previous pattern required an uppercase letter, '+', '/' or '=', so
		// a key whose base64 happened to be all lowercase and digits slipped
		// through. Asserted against a synthetic source, not the real file.
		const lowercaseKey = 'a'.repeat(30) + '1234567890abcd';
		const synthetic = `export const SOMETHING = '${lowercaseKey}';\n`;
		expect(withoutKnownDigestArrays(synthetic).match(/'[A-Za-z0-9+/=]{40,}'/g)).toEqual([
			`'${lowercaseKey}'`,
		]);
		expect(synthetic.match(/'[A-Za-z0-9+/]*[A-Z+/=][A-Za-z0-9+/]{40,}={0,2}'/g)).toBeNull();
	});
});
