#!/usr/bin/env node
/**
 * run-unlinkability-gate.mjs -- D-11's ONE control, at the property level
 * (56-32): two page loads present DIFFERENT peer ids to the network, and a
 * reload within one tab presents the SAME one.
 *
 * Usage, from `apps/VoteTorrentPublic`:
 *   node test/browser/run-unlinkability-gate.mjs                 # the gate
 *   node test/browser/run-unlinkability-gate.mjs --prove-linkable  # the control: must FAIL
 *
 * WHAT IS MEASURED, AND WHERE. A plain libp2p node in this process plays the
 * gateway: it listens on a loopback websocket and records the peer id of every
 * connection that reaches it. A real Chromium loads a real `vite build` of the
 * page (built into a temporary directory, never the shared `dist/`) whose
 * `config.json` names only that node. The page's own peer boot dials it as a
 * bootstrap node, so the recorded id is exactly what a network observer sees.
 * Nothing is read from the page: no peer id is exposed by it and none is needed.
 *
 * Four loads, in order:
 *   A1  tab 1, first load
 *   A2  tab 1, reload               -> must equal A1 (D-11: same tab reuses)
 *   B   tab 2, same browser context  -> must differ from A1 (a second load is unlinkable)
 *   C   a new browser context        -> must differ from A1 and B
 * The address names a made-up election on a made-up network, so the boot dials
 * the gateway, finds no strand and stops; the dial is all this gate needs, and
 * no store is created (56-26).
 *
 * THE CONTROL (`--prove-linkable`) swaps the page's `sessionStorage` for
 * `localStorage` with an init script before any page script runs, which is the
 * exact regression D-11 guards against (a persisted key). Tab 2 then presents
 * tab 1's id, so the gate's B != A1 assertion must fail. If the control passes,
 * the gate discriminates nothing.
 *
 * The page's dial is local-only: `--host-resolver-rules` maps a made-up name
 * to 127.0.0.1, because libp2p's browser gater refuses `localhost` itself. The
 * same gater refuses plain `ws` too, so the gateway serves `/tls/ws` from a
 * throwaway self-signed certificate (openssl, one day, deleted afterwards) and
 * Chromium is told to accept that one key only
 * (`--ignore-certificate-errors-spki-list`, the mesh-read gate's recipe).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { X509Certificate, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { identify } from '@libp2p/identify';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const ALIAS = 'gateway.unlinkability.test';
const DIAL_WAIT_MS = 20_000;
const PROVE_LINKABLE = process.argv.includes('--prove-linkable');

/** @param {string} cmd @param {string[]} args @param {string} cwd */
function run(cmd, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, FORCE_COLOR: '0' } });
		child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
		child.on('error', reject);
	});
}

async function main() {
	const outDir = mkdtempSync(path.join(process.env.VT_GATE_TMP ?? tmpdir(), 'vt-unlinkability-'));
	const certDir = mkdtempSync(path.join(process.env.VT_GATE_TMP ?? tmpdir(), 'vt-unlinkability-cert-'));
	/** @type {any} */ let gateway;
	/** @type {any} */ let server;
	/** @type {any} */ let browser;
	try {
		await run('yarn', ['vite', 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], APP_ROOT);

		const keyPath = path.join(certDir, 'key.pem');
		const certPath = path.join(certDir, 'cert.pem');
		await run(
			'openssl',
			['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', `/CN=${ALIAS}`, '-addext', `subjectAltName=DNS:${ALIAS}`],
			certDir,
		);
		const cert = readFileSync(certPath);
		const spkiPin = createHash('sha256')
			.update(/** @type {Buffer} */ (new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })))
			.digest('base64');

		gateway = await createLibp2p({
			addresses: { listen: ['/ip4/127.0.0.1/tcp/0/tls/ws'] },
			transports: [webSockets({ https: { cert, key: readFileSync(keyPath) } })],
			connectionEncrypters: [noise()],
			streamMuxers: [/** @type {any} */ (yamux())],
			connectionGater: { denyDialMultiaddr: async () => false },
			services: { identify: identify() },
		});
		/** @type {string[]} */
		const seen = [];
		gateway.addEventListener('connection:open', (/** @type {any} */ e) => {
			const id = e.detail?.remotePeer?.toString();
			// Every connection is recorded, a repeat id included: the reload's
			// connection carries the SAME id as the load before it, by design.
			if (id) seen.push(id);
		});
		const port = gateway
			.getMultiaddrs()
			.map((/** @type {any} */ m) => m.toString())
			.map((/** @type {string} */ a) => a.match(/\/tcp\/(\d+)\/tls\/ws/)?.[1])
			.find(Boolean);
		if (!port) throw new Error('the gateway produced no websocket port');
		const bootAddr = `/dns4/${ALIAS}/tcp/${port}/tls/ws/p2p/${gateway.peerId.toString()}`;
		writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({ bootstrapNodes: [bootAddr] }));

		server = await serveDist(outDir, 0);
		const url = `${server.url}/?network=unlinkabilitynet${Date.now()}&election=el-unlinkability`;

		browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${ALIAS} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${spkiPin}`] });

		/** @param {() => Promise<unknown>} act @returns {Promise<string>} */
		const nextPeer = async (act) => {
			const before = seen.length;
			await act();
			const t0 = Date.now();
			while (seen.length === before && Date.now() - t0 < DIAL_WAIT_MS) await new Promise((r) => setTimeout(r, 100));
			if (seen.length === before) throw new Error(`no connection reached the gateway within ${DIAL_WAIT_MS} ms`);
			return seen[before];
		};

		const ctx1 = await browser.newContext();
		if (PROVE_LINKABLE) {
			await ctx1.addInitScript(() => {
				Object.defineProperty(window, 'sessionStorage', { value: window.localStorage, configurable: true });
			});
		}
		const tab1 = await ctx1.newPage();
		if (process.env.VT_GATE_DEBUG) {
			await ctx1.addInitScript(() => window.localStorage.setItem('debug', 'libp2p:bootstrap,libp2p:connection-manager:dial-queue,libp2p:websockets*'));
			tab1.on('console', (/** @type {any} */ m) => console.log(`[page:${m.type()}] ${m.text().slice(0, 300)}`));
		}
		const a1 = await nextPeer(() => tab1.goto(url));
		const a2 = await nextPeer(() => tab1.reload());
		const tab2 = await ctx1.newPage();
		const b = await nextPeer(() => tab2.goto(url));
		const ctx2 = await browser.newContext();
		const tab3 = await ctx2.newPage();
		const c = await nextPeer(() => tab3.goto(url));

		const short = (/** @type {string} */ id) => `${id.slice(0, 12)}…${id.slice(-4)}`;
		console.log(`A1 ${short(a1)}  A2 ${short(a2)}  B ${short(b)}  C ${short(c)}${PROVE_LINKABLE ? '  (control: sessionStorage -> localStorage)' : ''}`);
		/** @type {string[]} */
		const failures = [];
		if (a1 !== a2) failures.push('a reload in the same tab presented a DIFFERENT peer id (D-11: the tab must reuse it)');
		if (a1 === b) failures.push('a second tab presented the SAME peer id as the first (two loads are linkable)');
		if (c === a1 || c === b) failures.push('a new browser context presented an earlier peer id');
		if (failures.length > 0) {
			for (const f of failures) console.log(`FAIL ${f}`);
			console.log('UNLINKABILITY: FAIL');
			return 1;
		}
		console.log('UNLINKABILITY: PASS (reload reuses, every other load is new)');
		return 0;
	} finally {
		await browser?.close().catch(() => {});
		await server?.close().catch(() => {});
		await gateway?.stop().catch(() => {});
		rmSync(outDir, { recursive: true, force: true });
		rmSync(certDir, { recursive: true, force: true });
	}
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(`UNLINKABILITY: ERROR ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
		process.exit(2);
	},
);
