/**
 * metro.noble-sha256.js — the Metro resolver step that sends `@noble/hashes/sha2.js` imports to
 * polyfills/noble-sha2-native.js (native one-shot sha256, see that file and
 * polyfills/native-backends.js). metro.config.js applies it to every resolution.
 *
 * Redirected: a resolution that lands on some copy's `@noble/hashes/sha2.js`, from any module
 * except
 *   - noble's own packages (`@noble/curves` hashes inside its signature math; left exactly as
 *     published),
 *   - react-native-quick-crypto (the shim imports it; a redirect there could form a cycle),
 *   - the shim itself (it re-exports the real module).
 * and only when that copy's version equals the app's own @noble/hashes, the copy the shim
 * re-exports. Any other version is left alone, so a dependency pinned to a different noble
 * never silently gets this app's.
 *
 * BYTE-IDENTICAL in both apps.
 */
const fs = require('fs');
const path = require('path');

const SHA2_SUFFIX = path.join('@noble', 'hashes', 'sha2.js');
const NOBLE_DIR = path.sep + path.join('node_modules', '@noble') + path.sep;
const QUICK_CRYPTO_DIR = path.sep + path.join('node_modules', 'react-native-quick-crypto') + path.sep;

function packageVersion(dir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
	} catch {
		return null;
	}
}

/**
 * Returns `redirect(originModulePath, resolution)`: the shim's resolution, or `resolution`
 * unchanged. `redirect.shimPath` and `redirect.appVersion` are exposed for tests and logs.
 */
function createNobleSha256Redirect(projectRoot) {
	const shimPath = path.resolve(projectRoot, 'polyfills/noble-sha2-native.js');
	const appCopy = path.dirname(require.resolve('@noble/hashes/sha2.js', { paths: [path.dirname(shimPath)] }));
	const appVersion = packageVersion(appCopy);
	const versions = new Map();

	function redirect(originModulePath, resolution) {
		if (!resolution || resolution.type !== 'sourceFile' || !resolution.filePath.endsWith(SHA2_SUFFIX)) return resolution;
		const origin = originModulePath || '';
		if (origin === shimPath || origin.includes(NOBLE_DIR) || origin.includes(QUICK_CRYPTO_DIR)) return resolution;
		const copy = path.dirname(resolution.filePath);
		if (!versions.has(copy)) versions.set(copy, packageVersion(copy));
		if (appVersion === null || versions.get(copy) !== appVersion) return resolution;
		return { type: 'sourceFile', filePath: shimPath };
	}
	redirect.shimPath = shimPath;
	redirect.appVersion = appVersion;
	return redirect;
}

module.exports = { createNobleSha256Redirect };
