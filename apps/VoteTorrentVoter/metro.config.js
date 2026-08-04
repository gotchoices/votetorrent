/**
 * Bare-RN Metro config for bundling @serfab/cadre-core + @optimystic/db-p2p + libp2p
 * into apps/VoteTorrentVoter (React Native 0.78, bare — NOT Expo).
 *
 * Phase 44 (D-02/D-04): ported verbatim from apps/VoteTorrentAuthority/metro.config.js
 * (Spike 002 artifact, hardened across Phases 17/40) — only the path-constant DERIVATION
 * is shared (both apps live one level under apps/, so workspaceRoot/superRoot resolve to
 * the same monorepo roots via __dirname; no literal path changed). Do NOT re-derive this
 * file — it encodes ~3 spike sessions of Hermes/Metro fixes (see 44-RESEARCH.md "Don't
 * Hand-Roll" + Pitfall 2/3).
 *
 * The two load-bearing pieces vs. a bare-default config:
 *   1. extraNodeModules shims for Node builtins (os/crypto/stream/buffer) + empty stubs (net/tls).
 *   2. The @libp2p/crypto BROWSER-FIELD rewrite in resolveRequest — MANDATORY, or the first
 *      generateKeyPair('Ed25519') throws "undefined cannot be used as a constructor".
 */
const path = require("path");
const fs = require("fs");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
// The portal:./vendor/ consumption model was retired repo-wide (Phase 40) — the
// @serfab/@optimystic packages are consumed PUBLISHED from node_modules. No vendor/
// extraNodeModules alias is needed here.
//
// A `superRoot` (= ../../.., i.e. the ser/ parent holding every sibling checkout) used to be
// listed in watchFolders alongside workspaceRoot, described as "a harmless watch root". It was
// not harmless. ser/ has no .git or .watchmanconfig, so watchman took ser/ ITSELF as the watch
// root and crawled every sibling project — ~879k files vs ~316k for this repo alone — which
// hung Metro at "waiting for watchman (query)". Nothing ever resolved through it (the vendor/
// model it existed for is gone), so it is removed. Do not re-add it: if an out-of-tree package
// is ever needed again, add that ONE directory, never the whole parent.
const emptyShim = path.resolve(projectRoot, "polyfills/empty.js");

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
	watchFolders: [workspaceRoot],
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
			// Node builtins libp2p / optimystic / quereus pull transitively:
			"node:os": path.resolve(projectRoot, "polyfills/node-os.js"),
			"node:stream": require.resolve("readable-stream"),
			"node:buffer": require.resolve("buffer"),
			"node:crypto": path.resolve(projectRoot, "polyfills/node-crypto.js"),
			"node:net": emptyShim,
			"node:tls": emptyShim,
			// Published @serfab/cadre-core@0.8.1 added a server-only push-notification seam
			// (push-notifier.js) that cadre-node.js reaches via a dynamic
			// `await import('./push-notifier.js')` inside a function that only runs when
			// FCM/APNs credentials are configured (never true for this RN client). Metro still
			// needs to statically RESOLVE every module reachable via `import()` to bundle it
			// into RN's single monolithic output (dynamic import is not code-split on RN), so
			// its transitive `node:http2` import (push-notifier-apns.js) must resolve to
			// SOMETHING at bundle time even though the code path never executes on-device.
			// Empty stub mirrors the existing net/tls precedent for Node builtins that are
			// imported but never actually called from an RN code path.
			"node:http2": emptyShim,
			http2: emptyShim,
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

// 44-09 (D-04, closes 44-UAT.md Test 1 Defect 2): tslib's package.json `exports` map has
// NO `require` condition — only `module`/`import`/`default`, where the RN-platform-relevant
// `import` branch's nested `default` points at the ESM `tslib.es6.mjs` (confirmed by reading
// node_modules/tslib/package.json directly). Under `unstable_enablePackageExports: true`
// (MANDATORY for cadre-core's own exports map — do NOT disable), Metro's exports-conditions
// resolution steers EVERY `require("tslib")` in the tree — CJS consumers like the engine's
// @peculiar/asn1-* build's `tslib_1.__decorate(...)` and other transitive `require("tslib")`
// callers (e.g. tsyringe's esm5 build's `__extends(`) — to that ESM variant. The CJS interop
// wrapper Metro/Hermes produces for the .mjs does not expose the helpers the same way, so
// `tslib_1.<helper>` reads `undefined` and throws `Cannot read property '<helper>' of
// undefined` during eager module eval (inlineRequires:false, see below) — this is what
// aborted on-device boot before AppRegistry.registerComponent (44-UAT.md Test 1 Defect 2).
// Fix: force EVERY `require("tslib")` / `import ... from "tslib"` to resolve to the
// concrete CJS UMD build (`tslib/tslib.js`), which exports all helpers as plain functions
// on the module object regardless of how the caller destructures them. This is
// package/symbol-agnostic on purpose — it closes the defect no matter which consumer or
// helper trips first. Do NOT delete this branch; removing it reopens the on-device red-box.
const tslibUmdPath = require.resolve("tslib/tslib.js", { paths: nodeModulesPaths });

// Wrap resolveRequest to apply the @multiformats/multiaddr/convert redirect, the tslib
// CJS UMD redirect, and the @libp2p/crypto browser rewrite.
const upstreamResolveRequest = merged.resolver.resolveRequest;
merged.resolver.resolveRequest = (context, moduleName, platform) => {
	if (moduleName === "@multiformats/multiaddr/convert") {
		return { type: "sourceFile", filePath: multiaddrConvertV12 };
	}
	if (moduleName === "tslib") {
		return { type: "sourceFile", filePath: tslibUmdPath };
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

// Metro's `inlineRequires` transform defers evaluation of side-effect-free, `const`-only
// ESM modules until their first property read. Published @serfab/cadre-core@0.8.1's
// `control-schema.js` is exactly this shape — a single `export const CONTROL_SCHEMA = \`...\``
// with NO imports — so under Hermes (dev bundle, lazy=true) its module body was never
// evaluated before `ControlDatabase.loadSchema()` read `CONTROL_SCHEMA`, yielding `undefined`
// and crashing quereus 4.3.1's lexer (`isAtEnd` → `.length` of undefined), blocking EVERY
// CadreNode boot on-device. This did NOT reproduce on Node because Node evaluates the static
// ESM import eagerly. Forcing `inlineRequires: false` makes the top-of-module require eager
// so the schema module evaluates before loadSchema runs. We WRAP the default
// getTransformOptions (rather than replacing it) so experimentalImportSupport and every other
// RN 0.78 default is preserved — only inlineRequires is flipped.
const upstreamGetTransformOptions = merged.transformer.getTransformOptions;
merged.transformer.getTransformOptions = async (entryPoints, options, getDependenciesOf) => {
	const base = upstreamGetTransformOptions
		? await upstreamGetTransformOptions(entryPoints, options, getDependenciesOf)
		: {};
	return {
		...base,
		transform: {
			...(base.transform || {}),
			inlineRequires: false,
		},
	};
};

module.exports = merged;
