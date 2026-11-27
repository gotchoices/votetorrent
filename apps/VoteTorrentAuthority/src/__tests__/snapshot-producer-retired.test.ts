/**
 * The Authority app no longer produces a database snapshot for the dashboard. The dashboard reads
 * the officer's strand live, so the producer modules (the sealed upload client, the whole-database
 * export and the staged sign-in code store), the factory's export seam and the app context's
 * export are all gone.
 *
 * This suite keeps them gone. It walks every source file under `src/` and fails on any retired
 * identifier. The token list is assembled from string fragments only, so this file can never
 * match its own scan, and the controls below prove the matcher is neither inert nor over-eager.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname, '..');
const THIS_FILE = path.resolve(__filename);

/** Retired identifiers, built from fragments so no whole name appears in this file. */
const RETIRED_TOKENS: readonly string[] = Object.freeze([
	'export' + 'DashboardSnapshot', // the factory and app-context snapshot export
	'export' + 'DatabaseSnapshot', // the whole-database export
	'DashboardSnapshot' + 'Provider', // the snapshot-provider registration
	'purgeLegacy' + 'StagedPayload', // the old staged-payload purge
	'DashboardSign' + 'InCode', // the sign-in code mint / split stem
	'StagedSign' + 'InCode', // the staged-code read / clear / redeem stem and record type
	'stageFor' + 'FilesystemBinding', // the filesystem-binding stager
	'Bootstrap' + 'Upload', // the upload client stem
	'dashboardSignInCode' + 'Upload', // the upload copy-key stem
	'services/' + 'bootstrap' + '-upload', // module path stems
	'services/' + 'dashboard-bootstrap' + '-producer',
	'services/' + 'dashboard-signin' + '-code',
]);

/** The retired tokens that occur in `text`, in list order. */
function findRetiredTokens(text: string): string[] {
	return RETIRED_TOKENS.filter((token) => text.includes(token));
}

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js']);

function walk(dir: string, out: string[]): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(full, out);
		} else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
			if (path.resolve(full) !== THIS_FILE) out.push(full);
		}
	}
	return out;
}

describe('the dashboard snapshot producer is retired', () => {
	it('(a) the three producer modules are gone from src/services', () => {
		const servicesDir = path.join(SRC_DIR, 'services');
		const retiredModules = [
			'bootstrap' + '-upload.ts',
			'dashboard-bootstrap' + '-producer.ts',
			'dashboard-signin' + '-code.ts',
		];
		for (const name of retiredModules) {
			expect(fs.existsSync(path.join(servicesDir, name))).toBe(false);
		}
	});

	it('(c) no source file under src names a retired identifier', () => {
		const files = walk(SRC_DIR, []);
		expect(files.length).toBeGreaterThan(100);
		expect(files).not.toContain(THIS_FILE);
		const hits: string[] = [];
		for (const file of files) {
			const text = fs.readFileSync(file, 'utf8');
			for (const token of findRetiredTokens(text)) {
				hits.push(`${path.relative(SRC_DIR, file)}: ${token}`);
			}
		}
		expect(hits).toEqual([]);
	});

	describe('(d) controls', () => {
		it('a planted snapshot export name yields exactly one hit', () => {
			const planted = 'await factory.' + ('export' + 'DashboardSnapshot') + '();';
			expect(findRetiredTokens(planted)).toHaveLength(1);
		});

		it('the surviving factory seam name yields no hit', () => {
			expect(findRetiredTokens('factory.createPeerStagingTransports({ opener, decisionSigner })')).toEqual([]);
		});

		it('the real AppProvider source yields no hit', () => {
			const text = fs.readFileSync(path.join(SRC_DIR, 'providers', 'AppProvider.tsx'), 'utf8');
			expect(text.length).toBeGreaterThan(1000);
			expect(findRetiredTokens(text)).toEqual([]);
		});

		it('a planted upload copy key yields exactly one hit', () => {
			const planted = 't("' + 'dashboardSignInCode' + 'Upload' + 'Failed' + '")';
			expect(findRetiredTokens(planted)).toHaveLength(1);
		});
	});

	it('(e) the factory and the app provider no longer import the vote-engine bootstrap entry', () => {
		const bootstrapEntry = 'vote-engine/' + 'bootstrap';
		for (const rel of [path.join('engines', 'engine-factory.ts'), path.join('providers', 'AppProvider.tsx')]) {
			const text = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
			expect(text.length).toBeGreaterThan(1000);
			expect(text.includes(bootstrapEntry)).toBe(false);
		}
	});
});
