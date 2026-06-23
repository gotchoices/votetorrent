/**
 * PROPOSED bare-RN Metro config for bundling @serfab/cadre-core + @optimystic/db-p2p + libp2p
 * into apps/VoteTorrentAuthority (React Native 0.78, bare — NOT Expo).
 *
 * Spike 002 artifact. Adapted from Sereus's Expo reference app metro.config.js onto VoteTorrent's
 * existing bare-RN base (@react-native/metro-config + mergeConfig). NOT yet validated end-to-end —
 * see README "Verdict": a green bundle is blocked by the consumption model (spike 003) until the
 * @serfab/* + @optimystic/* packages are consumed as PUBLISHED artifacts (or vendored), not
 * co-located PnP source checkouts.
 *
 * The two load-bearing pieces vs. VoteTorrent's current config:
 *   1. extraNodeModules shims for Node builtins (os/crypto/stream/buffer) + empty stubs (net/tls).
 *   2. The @libp2p/crypto BROWSER-FIELD rewrite in resolveRequest — MANDATORY, or the first
 *      generateKeyPair('Ed25519') throws "undefined cannot be used as a constructor".
 */
const path = require("path");
const fs = require("fs");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
// The portal: deps are now VENDORED in-repo at votetorrent/vendor/ (spike 014 option C) —
// no longer sibling source above the workspace. vendor/ lives under workspaceRoot, which Metro
// already watches, so no super-root watch is needed for portal resolution. superRoot is retained
// only as a harmless watch root for any remaining out-of-tree dev scenarios.
const superRoot = path.resolve(projectRoot, "../../..");
const vendorRoot = path.resolve(workspaceRoot, "vendor");
const emptyShim = path.resolve(projectRoot, "polyfills/empty.js");

// Canonical package name → in-repo vendored dir (portal targets).
// @optimystic/quereus-plugin-optimystic is PUBLISHED (patched) — it resolves from node_modules,
// so it is intentionally NOT aliased here (keeps the build free of any sibling-source path).
const portalSourceModules = {
	"@serfab/cadre-core": path.resolve(vendorRoot, "@serfab/cadre-core"),
	"@serfab/quereus-plugin-sereus": path.resolve(vendorRoot, "@serfab/quereus-plugin-sereus"),
	"@serfab/strand-proto": path.resolve(vendorRoot, "@serfab/strand-proto"),
	"@optimystic/db-core": path.resolve(vendorRoot, "@optimystic/db-core"),
	"@optimystic/db-p2p": path.resolve(vendorRoot, "@optimystic/db-p2p"),
	"@optimystic/db-p2p-storage-rn": path.resolve(vendorRoot, "@optimystic/db-p2p-storage-rn"),
};

// --- browser-field maps (load each package's `browser` field and redirect Node file
//     paths to their .browser.js variants). Metro ignores object-form browser fields when
//     unstable_enablePackageExports is on, so these rewrites are hand-applied:
//       @libp2p/crypto          — MANDATORY for Ed25519 keygen.
//       @chainsafe/libp2p-noise — MANDATORY for the Noise handshake: the node variant
//         (crypto/index.js) uses node:crypto chacha20-poly1305/diffieHellman, which the
//         polyfill cannot provide on Hermes → EncryptionFailedError on every dial.
//         The browser variant (index.browser.js) is pure-JS @noble crypto.
function loadBrowserFieldMap(nodeModulesPaths, pkgParts) {
	for (const nmRoot of nodeModulesPaths) {
		const pkgDir = path.join(nmRoot, ...pkgParts);
		const pkgJson = path.join(pkgDir, "package.json");
		if (!fs.existsSync(pkgJson)) continue;
		const map = JSON.parse(fs.readFileSync(pkgJson, "utf8")).browser;
		// WR-09 (17-REVIEW): a root may contain the package WITHOUT an object-form
		// browser field — keep scanning the remaining roots instead of bailing out.
		if (!map || typeof map !== "object") continue;
		const out = Object.create(null);
		for (const [from, to] of Object.entries(map)) {
			// WR-09: skip non-string browser entries. `false` means "exclude this
			// module in browser builds" — path.resolve(pkgDir, false) would fabricate
			// a bogus `.../false` mapping.
			if (typeof to !== "string") continue;
			out[path.resolve(pkgDir, from)] = path.resolve(pkgDir, to);
		}
		return out;
	}
	return null;
}

const nodeModulesPaths = [
	path.resolve(projectRoot, "node_modules"),
	path.resolve(workspaceRoot, "node_modules"),
];
// WR-09 (17-REVIEW): both rewrites are MANDATORY (Ed25519 keygen crash;
// EncryptionFailedError on every dial). Fail LOUDLY at config-load time
// instead of silently degrading to an empty map (`?? {}`) whose first
// symptom is a cryptic on-device runtime crash.
const libp2pCryptoMap = loadBrowserFieldMap(nodeModulesPaths, ["@libp2p", "crypto"]);
if (!libp2pCryptoMap) {
	throw new Error(
		"metro.config.js: @libp2p/crypto browser-field map could not be loaded — " +
			'MANDATORY for Ed25519 keygen ("undefined cannot be used as a constructor"). ' +
			"Check that @libp2p/crypto is installed with an object-form `browser` field."
	);
}
const noiseBrowserMap = loadBrowserFieldMap(nodeModulesPaths, ["@chainsafe", "libp2p-noise"]);
if (!noiseBrowserMap) {
	throw new Error(
		"metro.config.js: @chainsafe/libp2p-noise browser-field map could not be loaded — " +
			"MANDATORY for the Noise handshake (EncryptionFailedError on every dial). " +
			"Check that @chainsafe/libp2p-noise is installed with an object-form `browser` field."
	);
}
const libp2pCryptoBrowserMap = Object.assign(Object.create(null), libp2pCryptoMap, noiseBrowserMap);

const config = {
	projectRoot,
	watchFolders: [workspaceRoot, superRoot],
	transformer: {
		// Release (Hermes, minified) builds: PRESERVE function + class names.
		// Terser's default mangle pass renames functions/classes, which breaks
		// name-dependent runtime resolution in Quereus (SQL UDF registration /
		// CHECK-constraint evaluation in the create() INSERT path) and libp2p.
		// Symptom: the app boots fine but network creation silently fails ONLY in
		// release builds (debug doesn't minify, so it was unaffected). keep_fnames
		// + keep_classnames stop the mangler from renaming them. Dev builds ignore
		// this (no minification).
		minifierConfig: {
			keep_classnames: true,
			keep_fnames: true,
			mangle: { keep_classnames: true, keep_fnames: true },
		},
	},
	resolver: {
		nodeModulesPaths,
		// portal: deps are symlinks into the sibling monorepo source (spike 010) —
		// Metro must follow them or @optimystic/* / @serfab/* won't resolve.
		unstable_enableSymlinks: true,
		unstable_enablePackageExports: true, // already on in VoteTorrent's config; required for cadre-core's exports map

		extraNodeModules: {
			...portalSourceModules,
			// Node builtins libp2p / optimystic / quereus pull transitively:
			"node:os": path.resolve(projectRoot, "polyfills/node-os.js"),
			"node:stream": require.resolve("readable-stream"),
			"node:buffer": require.resolve("buffer"),
			"node:crypto": path.resolve(projectRoot, "polyfills/node-crypto.js"),
			"node:net": emptyShim,
			"node:tls": emptyShim,
			os: path.resolve(projectRoot, "polyfills/node-os.js"),
			stream: require.resolve("readable-stream"),
			buffer: require.resolve("buffer"),
			crypto: path.resolve(projectRoot, "polyfills/node-crypto.js"),
			net: emptyShim,
			tls: emptyShim,
		},
	},
};

const merged = mergeConfig(getDefaultConfig(projectRoot), config);

// spike 010: @multiformats/multiaddr v13 (the pinned major) dropped the `/convert`
// subpath that @chainsafe/libp2p-gossipsub still imports. v13 has no convertToString
// at all, so redirect the subpath to a v12.5.1 copy installed under an npm alias
// (no conflict with the pinned v13 — its only relative import is ./registry.js, which
// stays inside the v12 package). Mirrors sereus-chat's metro resolveRequest redirect.
const multiaddrConvertV12 = path.resolve(
	projectRoot,
	"node_modules/@multiformats/multiaddr-v12/dist/src/convert.js"
);

// Wrap resolveRequest to apply the @multiformats/multiaddr/convert redirect and the
// @libp2p/crypto browser rewrite.
const upstreamResolveRequest = merged.resolver.resolveRequest;
merged.resolver.resolveRequest = (context, moduleName, platform) => {
	if (moduleName === "@multiformats/multiaddr/convert") {
		return { type: "sourceFile", filePath: multiaddrConvertV12 };
	}
	const resolved = upstreamResolveRequest
		? upstreamResolveRequest(context, moduleName, platform)
		: context.resolveRequest(context, moduleName, platform);
	if (
		libp2pCryptoBrowserMap &&
		resolved &&
		resolved.type === "sourceFile" &&
		libp2pCryptoBrowserMap[resolved.filePath]
	) {
		return { type: "sourceFile", filePath: libp2pCryptoBrowserMap[resolved.filePath] };
	}
	return resolved;
};

module.exports = merged;
