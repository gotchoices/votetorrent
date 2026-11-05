/**
 * serve-dist.test.mjs — unit test for `scripts/lib/serve-dist.mjs` (T-53-08-05).
 *
 * Serves a temporary fixture directory over real HTTP and asserts, over a
 * real socket (never by calling the request handler in-process), the five
 * cases the plan's own action text names: the `extname('/')` trap served as
 * `text/html`, a `.css` file served as `text/css`, `/favicon.ico` answering
 * 204 with an empty body, a missing file answering 404, and a traversal
 * request answering 403 — proven alongside its negative half (the SAME file
 * read successfully when served from inside the root), so the 403 is
 * containment and not a blanket refusal.
 *
 * A sixth case (WR-15) covers the containment gap the lexical `path.relative`
 * check cannot see: a symlink whose lexical path sits INSIDE the served root
 * but whose target resolves OUTSIDE it. The lexical check alone passes this
 * request straight through to `readFile`, which follows the symlink and
 * serves the outside file's bytes — proven here by a request path that never
 * contains `..` at all, only a symlink name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { serveDist } from '../scripts/lib/serve-dist.mjs';

/** A port unlikely to collide with any dev/preview/gate port named in this repo's port policy note. */
const TEST_PORT = 58_321;

test('serve-dist: index.html at "/" is served as text/html (the extname(\'/\') trap)', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'serve-dist-'));
	try {
		await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>fixture</title>');
		const handle = await serveDist(dir, TEST_PORT);
		try {
			const res = await fetch(`${handle.url}/`);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get('content-type'), 'text/html');
			assert.match(await res.text(), /fixture/);
		} finally {
			await handle.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('serve-dist: a .css file is served as text/css', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'serve-dist-'));
	try {
		await writeFile(path.join(dir, 'app.css'), 'body { color: red; }');
		const handle = await serveDist(dir, TEST_PORT + 1);
		try {
			const res = await fetch(`${handle.url}/app.css`);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get('content-type'), 'text/css');
			assert.match(await res.text(), /color: red/);
		} finally {
			await handle.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 56-06 note: a consumer app that ships real favicon assets (D-20) must
// assert delivery of its OWN DECLARED paths (favicon.svg, favicon-32x32.png,
// etc — see apps/VoteTorrentPublic/test/browser/run-public-assets-gate.mjs),
// never `/favicon.ico` itself — this server special-cases that one path to
// a hard-coded 204 unconditionally, so it can never 404 here and a rung
// built on it would be permanently, vacuously green.
test('serve-dist: /favicon.ico answers 204 with an empty body', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'serve-dist-'));
	try {
		const handle = await serveDist(dir, TEST_PORT + 2);
		try {
			const res = await fetch(`${handle.url}/favicon.ico`);
			assert.equal(res.status, 204);
			const body = await res.text();
			assert.equal(body, '');
		} finally {
			await handle.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('serve-dist: a .png file is served as image/png', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'serve-dist-'));
	try {
		// A minimal-but-structurally-valid 1x1 PNG (signature + IHDR only,
		// same minimal shape the D-20 asset-shape test's own fixture uses) —
		// this test only asserts the response's content-type header, not that
		// the bytes decode as a real image.
		const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		await writeFile(path.join(dir, 'icon.png'), pngBytes);
		const handle = await serveDist(dir, TEST_PORT + 6);
		try {
			const res = await fetch(`${handle.url}/icon.png`);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get('content-type'), 'image/png');
		} finally {
			await handle.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('serve-dist: a missing file answers 404', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'serve-dist-'));
	try {
		const handle = await serveDist(dir, TEST_PORT + 3);
		try {
			const res = await fetch(`${handle.url}/does-not-exist.js`);
			assert.equal(res.status, 404);
		} finally {
			await handle.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('serve-dist: a traversal request escaping the served root answers 403, while the same file served from inside the root answers 200 (the negative control)', async () => {
	// Layout:
	//   <parent>/
	//     secret.txt          <- OUTSIDE the served root
	//     served-root/
	//       index.html
	//       secret.txt        <- INSIDE the served root, byte-identical name
	const parent = await mkdtemp(path.join(tmpdir(), 'serve-dist-'));
	try {
		const servedRoot = path.join(parent, 'served-root');
		await mkdir(servedRoot);
		await writeFile(path.join(parent, 'secret.txt'), 'outside the root');
		await writeFile(path.join(servedRoot, 'secret.txt'), 'inside the root');
		await writeFile(path.join(servedRoot, 'index.html'), '<!doctype html>');

		const handle = await serveDist(servedRoot, TEST_PORT + 4);
		try {
			// Positive (attack) half: the traversal sequence is sent with its
			// separators percent-encoded (%2f) so it survives as ONE opaque
			// path segment through the HTTP client's own URL construction and
			// is only reassembled into `../secret.txt` by serve-dist's OWN
			// decodeURIComponent call, after any URL-level dot-segment
			// collapsing has already run — see serve-dist.mjs's header for why
			// a plain, unencoded `/../` never reaches this server unresolved.
			const traversalUrl = `${handle.url}/..%2fsecret.txt`;
			const attackRes = await fetch(traversalUrl);
			assert.equal(attackRes.status, 403, 'a resolved path escaping the served root must answer 403');

			// Negative half: the SAME filename, served from INSIDE the root,
			// reads successfully — proving the 403 above is containment, not a
			// blanket refusal of anything named "secret.txt" or containing "..".
			const insideRes = await fetch(`${handle.url}/secret.txt`);
			assert.equal(insideRes.status, 200);
			assert.equal(await insideRes.text(), 'inside the root');
		} finally {
			await handle.close();
		}
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('serve-dist: a symlink inside the served root pointing OUTSIDE it answers 403, never the target\'s bytes (WR-15)', async () => {
	// Layout:
	//   <parent>/
	//     secret.txt              <- OUTSIDE the served root
	//     served-root/
	//       index.html
	//       escape-link -> ../secret.txt   <- a symlink whose LEXICAL path is
	//                                          inside served-root; only its
	//                                          resolved target sits outside it
	const parent = await mkdtemp(path.join(tmpdir(), 'serve-dist-symlink-'));
	try {
		const servedRoot = path.join(parent, 'served-root');
		await mkdir(servedRoot);
		await writeFile(path.join(parent, 'secret.txt'), 'outside the root, via a symlink');
		await writeFile(path.join(servedRoot, 'index.html'), '<!doctype html>');
		await symlink(path.join('..', 'secret.txt'), path.join(servedRoot, 'escape-link'));

		const handle = await serveDist(servedRoot, TEST_PORT + 5);
		try {
			// The request path itself contains no ".." at all -- "escape-link"
			// lexically resolves to servedRoot/escape-link, which IS inside
			// rootDir. Only readFile()'s own symlink-following at the OS level
			// reaches outside. A containment check that stops at path.relative
			// on the lexical resolution cannot see this.
			const res = await fetch(`${handle.url}/escape-link`);
			assert.equal(res.status, 403, 'a symlink resolving outside the served root must answer 403, not serve the target file');
			const body = await res.text();
			assert.doesNotMatch(body, /outside the root/, 'the response body must never contain the escaped target\'s bytes');
		} finally {
			await handle.close();
		}
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});
