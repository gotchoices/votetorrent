#!/usr/bin/env node
/**
 * serve-dist.mjs — a static file server over a BUILT directory, for the
 * shared browser-gate runner (D-19/D-24). `vite dev` is never a gate (see
 * `run-ui-gates.mjs`'s own header); this module is what serves a real
 * `vite build` output instead.
 *
 * Path containment (T-53-08-05, ASVS V5/V12): every request path is decoded
 * from `new URL(req.url, 'http://localhost')`'s `pathname` and resolved
 * against `rootDir`. That URL parsing step already collapses literal `..`
 * segments (and percent-encoded `%2e%2e` forms — the WHATWG URL "double-dot
 * path segment" rule matches both), which is what makes a NAIVE decode-then-
 * resolve safe against the obvious case. The real gap this containment check
 * exists for is a request that hides its `..` from that same URL parser by
 * percent-encoding the SEPARATOR rather than the dots — `..%2f..%2f..%2fetc`
 * survives the URL parser's dot-segment collapse as one opaque path segment
 * (it does not equal the literal string `..`, so the collapse rule does not
 * fire), and only becomes `../../../etc` once THIS module's own
 * `decodeURIComponent` call runs on the extracted pathname, after the URL
 * parser has already finished normalising. The `path.relative` containment
 * check below is what catches that second, later escape — proven by
 * `test/serve-dist.test.mjs`'s traversal case, which sends the `%2f`-encoded
 * form for exactly this reason: a plain `../` in a request URL never reaches
 * this server unresolved, because the client-side `new URL()`/`fetch()` call
 * that builds the request already collapses it before the bytes go out.
 *
 * That lexical containment check alone is NOT sufficient (WR-15): it runs on
 * the resolved-but-unfollowed request path, so a symlink whose LEXICAL
 * location sits inside `rootDir` but whose TARGET resolves outside it sails
 * straight through -- the request path itself need contain no `..` at all.
 * `readFile`/`stat` then follow that symlink at the OS level and would serve
 * the outside file's bytes. This module closes that gap with a SECOND
 * containment check, run on the `realpath()` of the resolved path (which
 * follows symlinks), after `stat` confirms the entry exists and before
 * `readFile` ever touches it -- proven by `test/serve-dist.test.mjs`'s
 * symlink-escape case.
 *
 * `serveDist(rootDir, port)` takes the port as a required parameter with no
 * default — the runner owns port policy. A bound port is a loud failure,
 * never a silent fallback: this module attaches an `error` listener to the
 * HTTP server BEFORE calling `listen`, and rejects the returned promise with
 * the underlying `EADDRINUSE` (or other) error rather than retrying,
 * incrementing, or passing `0` to let the OS choose. A runner that quietly
 * served on a different port would be a runner whose log claims to have
 * gated a page nobody asked for.
 */
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Content-type map keyed off the RESOLVED file's extension, never the
 * request path — `extname('/')` is `''`, which would serve `index.html` as
 * `application/octet-stream` and make a browser download the page instead of
 * rendering it (the one idea carried forward from
 * `.planning/spikes/090-shared-ui-extraction/token-probe.mjs`, per D-04).
 *
 * @type {Readonly<Record<string, string>>}
 */
const CONTENT_TYPES = Object.freeze({
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.woff2': 'font/woff2',
	'.map': 'application/json',
});

/**
 * @param {string} rootDir absolute path of the directory to serve
 * @param {number} port the port to bind — required, no default
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export function serveDist(rootDir, port) {
	return new Promise((resolvePromise, rejectPromise) => {
		const server = createServer((req, res) => {
			handleRequest(rootDir, req, res).catch((err) => {
				if (!res.headersSent) {
					res.writeHead(500, { 'content-type': 'text/plain' });
				}
				res.end(`serve-dist internal error: ${String(err?.message ?? err)}`);
			});
		});

		// Attach the error listener BEFORE listen() — an EADDRINUSE (or any
		// other bind-time failure) must reject this promise, never silently
		// retry a different port.
		server.once('error', (err) => {
			rejectPromise(err);
		});

		server.listen(port, '127.0.0.1', () => {
			const address = server.address();
			const actualPort = typeof address === 'object' && address ? address.port : port;
			resolvePromise({
				url: `http://127.0.0.1:${actualPort}`,
				port: actualPort,
				close: () =>
					new Promise((resolveClose) => {
						server.close(() => resolveClose());
					}),
			});
		});
	});
}

/**
 * @param {string} rootDir
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleRequest(rootDir, req, res) {
	const url = new URL(req.url ?? '/', 'http://localhost');
	const pathname = decodeURIComponent(url.pathname);

	if (pathname === '/favicon.ico') {
		res.writeHead(204);
		res.end();
		return;
	}

	// Resolve against rootDir, then require the result to remain INSIDE
	// rootDir. path.relative's result is checked for the two ways a resolved
	// path can escape: starting with a `..` segment, or being absolute
	// (which happens on Windows when the two paths sit on different drives).
	// A result that resolves to rootDir itself (the empty relative path — a
	// request for `/`) is inside rootDir, not outside it.
	let resolved = path.resolve(rootDir, '.' + pathname);
	const relative = path.relative(rootDir, resolved);
	const escapesRoot = relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative);
	if (escapesRoot) {
		res.writeHead(403, { 'content-type': 'text/plain' });
		res.end('forbidden: path escapes the served root');
		return;
	}

	let stats;
	try {
		stats = await stat(resolved);
	} catch {
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end('not found');
		return;
	}

	if (stats.isDirectory()) {
		resolved = path.join(resolved, 'index.html');
	}

	// Second containment check (WR-15), run on the REALPATH (symlinks
	// followed) of both sides. The check above only proves the LEXICAL
	// request path resolves inside rootDir; a symlink at `resolved` (or at
	// any ancestor of it) can still point somewhere else entirely, and
	// `readFile` below would happily follow it. `rootDir` is realpath'd too
	// rather than assumed already-canonical, so a symlinked ancestor of the
	// served root itself cannot produce a false-positive escape report. A
	// realpath() failure here (the entry doesn't exist, or a symlink is
	// dangling) is treated as 404, matching the not-found case below rather
	// than surfacing as an unrelated 500.
	let rootReal;
	let realResolved;
	try {
		rootReal = await realpath(rootDir);
		realResolved = await realpath(resolved);
	} catch {
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end('not found');
		return;
	}
	const realRelative = path.relative(rootReal, realResolved);
	const realEscapesRoot = realRelative.startsWith('..' + path.sep) || realRelative === '..' || path.isAbsolute(realRelative);
	if (realEscapesRoot) {
		res.writeHead(403, { 'content-type': 'text/plain' });
		res.end('forbidden: resolved target escapes the served root');
		return;
	}

	let body;
	try {
		body = await readFile(resolved);
	} catch {
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end('not found');
		return;
	}

	const contentType = CONTENT_TYPES[path.extname(resolved)] ?? 'application/octet-stream';
	res.writeHead(200, { 'content-type': contentType });
	res.end(body);
}
