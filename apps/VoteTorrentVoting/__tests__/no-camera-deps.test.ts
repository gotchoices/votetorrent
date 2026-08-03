/**
 * @format
 *
 * Phase 43 plan 43-02 (SCAN-01, D-02) — automated source-scan gate for the "no camera native
 * module" constraint. This is the automated Jest form of SCAN-01's zero-camera-deps claim: it
 * reads this app's own `package.json` dependency KEYS (dependencies + devDependencies) and
 * asserts none match a camera/QR/vision/barcode pattern — not a one-time manual check, so the
 * claim can't silently regress if a future phase adds a camera/QR native module.
 *
 * Scoped strictly to package.json dependency keys — deliberately NOT a source-scan over
 * `src/**` `.tsx` files, because `ScanScreen.tsx`'s `FontAwesome6 name="qrcode"` icon name is a
 * legitimate, unrelated match that must not false-positive this guard.
 */
import pkg from '../package.json';

const CAMERA_DEP_PATTERN = /camera|vision-camera|barcode|qr-scanner|qrcode-scanner/i;

describe('zero camera-related native deps (SCAN-01, D-02)', () => {
	test('package.json dependencies contain no camera/QR-scanning package', () => {
		const allDeps = {...pkg.dependencies, ...(pkg.devDependencies ?? {})};
		const offenders = Object.keys(allDeps).filter(name => CAMERA_DEP_PATTERN.test(name));
		expect(offenders).toEqual([]);
	});
});
