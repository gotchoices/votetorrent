/**
 * @format
 *
 * Camera dependency allowlist for the Authority. The user ruled on 2026-11-23 that the Authority
 * scans the join-code QR with the camera, through the same two VisionCamera 5 packages (same exact
 * version) as the Voter. Any other dependency key that matches the camera/QR-scanning pattern fails,
 * so a second camera or QR-scanning native module cannot arrive without changing this file on purpose.
 * `qrcode-generator` (drawing the invite QR) and `jsqr` (a test decoder) do not match the pattern.
 *
 * Scoped strictly to package.json dependency keys, as in the Voter's copy of this guard.
 */
import pkg from '../package.json';
import voterPkg from '../../VoteTorrentVoter/package.json';

const CAMERA_DEP_PATTERN = /camera|vision-camera|barcode|qr-scanner|qrcode-scanner/i;

const ALLOWED_CAMERA_DEPS = ['react-native-vision-camera', 'react-native-vision-camera-barcode-scanner'] as const;

/** Keys matching the camera pattern that are not on the allowlist (exact names), sorted. */
function cameraDepOffenders(deps: Record<string, string>): string[] {
	const allowed: readonly string[] = ALLOWED_CAMERA_DEPS;
	return Object.keys(deps)
		.filter((name) => CAMERA_DEP_PATTERN.test(name) && !allowed.includes(name))
		.sort();
}

describe('Authority camera dependency allowlist', () => {
	const allDeps = { ...pkg.dependencies, ...(pkg.devDependencies ?? {}) } as Record<string, string>;

	test('package.json has no camera/QR-scanning package outside the allowlist', () => {
		expect(cameraDepOffenders(allDeps)).toEqual([]);
	});

	test('exactly the two VisionCamera packages are declared', () => {
		const matching = Object.keys(allDeps)
			.filter((name) => CAMERA_DEP_PATTERN.test(name))
			.sort();
		expect(matching).toEqual([...ALLOWED_CAMERA_DEPS].sort());
	});

	test('both are runtime dependencies on one exact version, the same as the Voter, with the nitro-image peer', () => {
		const deps = pkg.dependencies as Record<string, string>;
		const voter = voterPkg.dependencies as Record<string, string>;
		const versions = ALLOWED_CAMERA_DEPS.map((name) => deps[name]);
		expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
		expect(versions[1]).toBe(versions[0]);
		for (const name of [...ALLOWED_CAMERA_DEPS, 'react-native-nitro-image', 'react-native-nitro-modules']) {
			expect({ name, version: deps[name] }).toEqual({ name, version: voter[name] });
		}
	});

	test('negative control: matching is by exact name, not by prefix', () => {
		const synthetic = {
			'react-native-camera-kit': '1.0.0',
			'expo-camera': '1.0.0',
			'react-native-qrcode-scanner': '1.0.0',
			'@acme/barcode-reader': '1.0.0',
			'qrcode-generator': '1.0.0',
			'react-native-vision-camera': '1.0.0',
		};
		expect(cameraDepOffenders(synthetic)).toEqual(
			['@acme/barcode-reader', 'expo-camera', 'react-native-camera-kit', 'react-native-qrcode-scanner'].sort(),
		);
	});
});
