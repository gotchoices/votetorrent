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
const path = require('path');
const fs = require('fs');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const emptyShim = path.resolve(projectRoot, 'polyfills/empty.js');

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
    const pkgJson = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJson)) continue;
    const map = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).browser;
    if (!map || typeof map !== 'object') return null;
    const out = Object.create(null);
    for (const [from, to] of Object.entries(map)) {
      out[path.resolve(pkgDir, from)] = path.resolve(pkgDir, to);
    }
    return out;
  }
  return null;
}

const nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
const libp2pCryptoBrowserMap = Object.assign(
  Object.create(null),
  loadBrowserFieldMap(nodeModulesPaths, ['@libp2p', 'crypto']) ?? {},
  loadBrowserFieldMap(nodeModulesPaths, ['@chainsafe', 'libp2p-noise']) ?? {},
);

const config = {
  projectRoot,
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths,
    unstable_enablePackageExports: true, // already on in VoteTorrent's config; required for cadre-core's exports map
    extraNodeModules: {
      // Node builtins libp2p / optimystic / quereus pull transitively:
      'node:os': path.resolve(projectRoot, 'polyfills/node-os.js'),
      'node:stream': require.resolve('readable-stream'),
      'node:buffer': require.resolve('buffer'),
      'node:crypto': path.resolve(projectRoot, 'polyfills/node-crypto.js'),
      'node:net': emptyShim,
      'node:tls': emptyShim,
      os: path.resolve(projectRoot, 'polyfills/node-os.js'),
      stream: require.resolve('readable-stream'),
      buffer: require.resolve('buffer'),
      crypto: path.resolve(projectRoot, 'polyfills/node-crypto.js'),
      net: emptyShim,
      tls: emptyShim,
    },
  },
};

const merged = mergeConfig(getDefaultConfig(projectRoot), config);

// Wrap resolveRequest to apply the @libp2p/crypto browser rewrite.
const upstreamResolveRequest = merged.resolver.resolveRequest;
merged.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolved = upstreamResolveRequest
    ? upstreamResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
  if (
    libp2pCryptoBrowserMap &&
    resolved &&
    resolved.type === 'sourceFile' &&
    libp2pCryptoBrowserMap[resolved.filePath]
  ) {
    return {type: 'sourceFile', filePath: libp2pCryptoBrowserMap[resolved.filePath]};
  }
  return resolved;
};

module.exports = merged;
