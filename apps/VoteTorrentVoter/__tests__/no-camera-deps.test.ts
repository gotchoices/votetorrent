/**
 * @format
 *
 * Camera dependency allowlist. This SUPERSEDES, on purpose, the Phase 43 plan 43-02 (SCAN-01,
 * D-02) zero-camera-deps guard: phase 64 D-05 ships a camera QR scanner in both Voter builds
 * through VisionCamera 5. The allowlist names exactly two packages. Any other dependency key
 * that matches the camera/QR/vision/barcode pattern still fails, so a future phase cannot add
 * a second camera or QR-scanning native module without changing this file on purpose.
 *
 * Scoped strictly to package.json dependency keys. It is deliberately NOT a source scan over
 * `src/**` `.tsx` files, because `ScanScreen.tsx`'s `FontAwesome6 name="qrcode"` icon name is a
 * legitimate, unrelated match that must not false-positive this guard.
 */
import pkg from '../package.json';

const CAMERA_DEP_PATTERN = /camera|vision-camera|barcode|qr-scanner|qrcode-scanner/i;

const ALLOWED_CAMERA_DEPS = [
	'react-native-vision-camera',
	'react-native-vision-camera-barcode-scanner',
] as const;

/** Keys matching the camera pattern that are not on the allowlist (exact names), sorted. */
function cameraDepOffenders(deps: Record<string, string>): string[] {
	const allowed: readonly string[] = ALLOWED_CAMERA_DEPS;
	return Object.keys(deps)
		.filter(name => CAMERA_DEP_PATTERN.test(name) && !allowed.includes(name))
		.sort();
}

describe('camera dependency allowlist (D-05 supersedes SCAN-01 D-02)', () => {
	test('package.json has no camera/QR-scanning package outside the allowlist', () => {
		const allDeps = {...pkg.dependencies, ...(pkg.devDependencies ?? {})};
		expect(cameraDepOffenders(allDeps)).toEqual([]);
	});

	test('exactly the two VisionCamera packages are declared', () => {
		const allDeps = {...pkg.dependencies, ...(pkg.devDependencies ?? {})};
		const matching = Object.keys(allDeps)
			.filter(name => CAMERA_DEP_PATTERN.test(name))
			.sort();
		expect(matching).toEqual([...ALLOWED_CAMERA_DEPS].sort());
	});

	test('both allowlisted packages are runtime dependencies on one exact version', () => {
		const deps = pkg.dependencies as Record<string, string>;
		const versions = ALLOWED_CAMERA_DEPS.map(name => deps[name]);
		expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
		expect(versions[1]).toBe(versions[0]);
	});

	test('negative control: matching is by exact name, not by prefix', () => {
		const synthetic = {
			'react-native-camera-kit': '1.0.0',
			'expo-camera': '1.0.0',
			'react-native-qrcode-scanner': '1.0.0',
			'vision-camera-code-scanner': '1.0.0',
			'react-native-vision-camera-worklets': '1.0.0',
			'@acme/barcode-reader': '1.0.0',
			'react-native-vision-camera': '1.0.0',
		};
		expect(cameraDepOffenders(synthetic)).toEqual(
			[
				'@acme/barcode-reader',
				'expo-camera',
				'react-native-camera-kit',
				'react-native-qrcode-scanner',
				'react-native-vision-camera-worklets',
				'vision-camera-code-scanner',
			].sort(),
		);
	});
});
