/**
 * @format
 *
 * Phase 59 plan 59-09 (D-23) — the mechanical enforcement of D-23's no-client-side-persisted-
 * identity invariant, modelled directly on `no-inline-mock-imports.test.ts`'s `fs`-walk /
 * `stripComments` / offender-array shape. Scoped to an EXPLICIT file list (not a whole-tree walk)
 * so it can never drift into flagging unrelated, legitimate persistence elsewhere in the app
 * (`RegistrationDraftProvider`, `BallotSelectionProvider`, `device-user.ts` all persist by
 * design, outside this plan's scope).
 *
 * Every matcher below runs against COMMENT-STRIPPED source, and the planted-fixture self-test
 * proves each matcher can actually fire (this repo has tripped the self-tripping-checker trap
 * three times in Phase 53 alone — a checker whose own comment quotes the literal pattern it
 * greps for is permanently green).
 */
import * as fs from 'fs';
import * as path from 'path';

const APP_ROOT = path.resolve(__dirname, '..');

/** The exact three files D-23's derivation touches — deliberately narrow. */
const TARGET_FILES = [
	'src/engines/registration-status.ts',
	'src/components/TimelineRegistrationPanel.tsx',
	'src/screens/timeline/TimelineScreen.tsx',
].map(rel => path.join(APP_ROOT, rel));

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function readStripped(file: string): string {
	return stripComments(fs.readFileSync(file, 'utf8'));
}

// Matches the import FORM (an `import ... from '...async-storage...'` statement, or a
// `require('...async-storage...')` call) — mirrors `no-inline-mock-imports.test.ts`'s own
// `mockData` matcher shape, never a bare substring.
const ASYNC_STORAGE_IMPORT_RE = /import\s[^;]*?from\s+['"][^'"]*async-storage['"]|require\(\s*['"][^'"]*async-storage['"]\s*\)/;
// Matches a persistence WRITE method call on any `*Storage*`-named identifier — the call FORM
// (`identifier.method(`), not a bare substring.
const ASYNC_STORAGE_WRITE_CALL_RE = /\b\w*[Ss]torage\w*\.(setItem|multiSet|mergeItem|multiMerge)\s*\(/;

// The secp256k1 device-user accessor this module must never import (F1 in `59-09-PLAN.md`): the
// wrong key silently reads "not registered" forever, with no error anywhere.
const DEVICE_USER_ACCESSOR_RE = /\bgetOrCreateDeviceUser\b/;
const DEVICE_USER_KEY_IDENTIFIER_RE = /\bdeviceUserKey\b/;

// The P-256 provisioning accessor `registration-status.ts` MUST call — this proves the CORRECT
// key IS used, not merely that the wrong one is absent (a file could satisfy the two negative
// checks above by reading no device key at all).
const PROVISION_DEVICE_KEY_CALL_RE = /\bgetCurrentDeviceKey\s*\(/;
// 63-18: a status READ must never CREATE a key (on Android `provisionDeviceKey` mints a new one per call).
const CREATING_DEVICE_KEY_CALL_RE = /\bprovisionDeviceKey\s*\(/;

describe('no client-side identity persistence (D-23, 59-09)', () => {
	test('the scoped file list resolves and is non-empty', () => {
		const existing = TARGET_FILES.filter(f => fs.existsSync(f));
		expect(existing.length).toBe(TARGET_FILES.length);
		expect(existing.length).toBeGreaterThan(0);
	});

	test('none of the three files imports AsyncStorage or calls a persistence write method on it', () => {
		const offenders: string[] = [];
		for (const file of TARGET_FILES) {
			const text = readStripped(file);
			if (ASYNC_STORAGE_IMPORT_RE.test(text) || ASYNC_STORAGE_WRITE_CALL_RE.test(text)) {
				offenders.push(path.relative(APP_ROOT, file));
			}
		}
		expect(offenders).toEqual([]);
	});

	test('none of the three files references the secp256k1 device-user accessor or a deviceUserKey identifier', () => {
		const offenders: string[] = [];
		for (const file of TARGET_FILES) {
			const text = readStripped(file);
			if (DEVICE_USER_ACCESSOR_RE.test(text) || DEVICE_USER_KEY_IDENTIFIER_RE.test(text)) {
				offenders.push(path.relative(APP_ROOT, file));
			}
		}
		expect(offenders).toEqual([]);
	});

	test('registration-status.ts DOES call the read-only P-256 current-key accessor -- proving the correct key is used, not merely that the wrong one is absent', () => {
		const file = TARGET_FILES.find(f => f.endsWith('registration-status.ts'));
		expect(file).toBeDefined();
		const text = readStripped(file as string);
		expect(PROVISION_DEVICE_KEY_CALL_RE.test(text)).toBe(true);
		expect(CREATING_DEVICE_KEY_CALL_RE.test(text)).toBe(false);
	});

	describe('planted-fixture self-test (every matcher is proven able to fire, never vacuous)', () => {
		test('a synthetic AsyncStorage import + write call IS reported', () => {
			const synthetic = stripComments(
				["import AsyncStorage from '@react-native-async-storage/async-storage';", "AsyncStorage.setItem('planted-offender-key', 'v');"].join('\n'),
			);
			expect(ASYNC_STORAGE_IMPORT_RE.test(synthetic)).toBe(true);
			expect(ASYNC_STORAGE_WRITE_CALL_RE.test(synthetic)).toBe(true);
		});

		test('a synthetic require(...async-storage...) call IS reported by the import matcher', () => {
			const synthetic = stripComments("const AsyncStorage = require('@react-native-async-storage/async-storage');");
			expect(ASYNC_STORAGE_IMPORT_RE.test(synthetic)).toBe(true);
		});

		test('a synthetic multiSet call IS reported by the write-call matcher', () => {
			const synthetic = stripComments("someStorageHandle.multiSet([['k', 'v']]);");
			expect(ASYNC_STORAGE_WRITE_CALL_RE.test(synthetic)).toBe(true);
		});

		test('a synthetic deviceUserKey identifier IS reported', () => {
			const synthetic = stripComments('const deviceUserKey = deviceUser.activeKeys[0]!.key;');
			expect(DEVICE_USER_KEY_IDENTIFIER_RE.test(synthetic)).toBe(true);
		});

		test('a synthetic getOrCreateDeviceUser import IS reported', () => {
			const synthetic = stripComments("import {getOrCreateDeviceUser} from '../engines/device-user';");
			expect(DEVICE_USER_ACCESSOR_RE.test(synthetic)).toBe(true);
		});

		test('a same identifier mentioned ONLY inside a comment is NOT reported -- comments are stripped before matching', () => {
			const synthetic = stripComments('// this file must never call getOrCreateDeviceUser or read a deviceUserKey\nconst x = 1;');
			expect(DEVICE_USER_ACCESSOR_RE.test(synthetic)).toBe(false);
			expect(DEVICE_USER_KEY_IDENTIFIER_RE.test(synthetic)).toBe(false);
		});

		test('a synthetic getCurrentDeviceKey() call IS reported by the positive matcher (and a provisionDeviceKey() call by the creating matcher)', () => {
			const synthetic = stripComments('const {publicKey} = await producer.getCurrentDeviceKey();');
			expect(PROVISION_DEVICE_KEY_CALL_RE.test(synthetic)).toBe(true);
			expect(CREATING_DEVICE_KEY_CALL_RE.test(stripComments('await producer.provisionDeviceKey();'))).toBe(true);
		});
	});
});
