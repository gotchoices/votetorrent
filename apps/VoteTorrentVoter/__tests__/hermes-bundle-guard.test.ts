/**
 * @format
 *
 * Phase 44 plan 44-09 — regression guards for the two layered Metro/Hermes
 * bundling defects diagnosed on-device in 44-UAT.md Test 1 (Cold Start Smoke
 * Test), in the newly-wired @peculiar ASN.1/X.509 attestation dependency
 * subtree.
 *
 * These are config-reading guards (mirroring dependency-versions.test.ts's
 * philosophy) — no metro/tslib mocking, so the assertions track reality, not
 * a stale snapshot of the fix.
 *
 * Defect 1 (44-UAT.md Test 1): Metro returned HTTP 500 — TransformError
 *   "Export namespace should be first transformed by
 *   @babel/plugin-transform-export-namespace-from" on
 *   @peculiar/utils/build/esm/encoding/index.js (`export * as binary from
 *   './binary.js'`). FIXED in commit 7f430ae by adding the plugin to
 *   babel.config.js. This plan does NOT redo that fix — only guards it.
 *
 * Defect 2 (44-UAT.md Test 1, closed by 44-09): after the babel fix the
 *   bundle served 200 but Hermes red-boxed at eager module eval with
 *   "Cannot read property '__extends' of undefined" (and other tslib
 *   helpers, e.g. '__decorate'). Root cause: tslib's package.json `exports`
 *   map has no `require` condition, so under
 *   `unstable_enablePackageExports: true` a CJS `require("tslib")` gets
 *   steered to the ESM `tslib.es6.mjs` variant, whose interop object does
 *   not expose the helpers the way CJS consumers expect. metro.config.js
 *   now forces every `require("tslib")` to resolve to the concrete CJS UMD
 *   (`tslib/tslib.js`), which does.
 */

import path from 'path';
import fs from 'fs';

const APP_DIR = path.resolve(__dirname, '..');

describe('hermes bundle guard — Defect 1 (babel export-namespace plugin)', () => {
  it('babel.config.js lists @babel/plugin-transform-export-namespace-from', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const babelConfig = require(path.join(APP_DIR, 'babel.config.js'));
    expect(Array.isArray(babelConfig.plugins)).toBe(true);
    expect(babelConfig.plugins).toContain('@babel/plugin-transform-export-namespace-from');
  });
});

describe('hermes bundle guard — Defect 2 (tslib CJS UMD resolution)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const metroConfig = require(path.join(APP_DIR, 'metro.config.js'));

  it('exposes a resolver.resolveRequest function (carries the multiaddr + libp2p-crypto rewrites)', () => {
    expect(typeof metroConfig.resolver.resolveRequest).toBe('function');
  });

  it('keeps unstable_enablePackageExports enabled (mandatory for cadre-core exports map)', () => {
    expect(metroConfig.resolver.unstable_enablePackageExports).toBe(true);
  });

  it('redirects moduleName "tslib" to a real CJS UMD module exporting __decorate and __extends as functions', () => {
    // Minimal stub context: if the redirect branch is NOT hit, the fallthrough
    // upstreamResolveRequest call would receive this stub and echo the module
    // name back as a bogus "sourceFile" path — the file-existence check below
    // would then fail, so this assertion is mechanism-agnostic (it does not
    // assume the specific resolveRequest branch, only the observable output).
    const stubContext = {
      resolveRequest: (_context: unknown, name: string) => ({
        type: 'sourceFile',
        filePath: name,
      }),
    };

    const resolved = metroConfig.resolver.resolveRequest(stubContext, 'tslib', 'android');

    expect(resolved).toBeTruthy();
    expect(resolved.type).toBe('sourceFile');
    expect(fs.existsSync(resolved.filePath)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const resolvedModule = require(resolved.filePath);
    expect(typeof resolvedModule.__decorate).toBe('function');
    expect(typeof resolvedModule.__extends).toBe('function');
  });

  it('leaves the pre-existing @multiformats/multiaddr/convert redirect intact', () => {
    const stubContext = {
      resolveRequest: (_context: unknown, name: string) => ({
        type: 'sourceFile',
        filePath: name,
      }),
    };
    const resolved = metroConfig.resolver.resolveRequest(
      stubContext,
      '@multiformats/multiaddr/convert',
      'android',
    );
    expect(resolved.type).toBe('sourceFile');
    expect(resolved.filePath).toContain('multiaddr-v12');
    expect(fs.existsSync(resolved.filePath)).toBe(true);
  });
});
