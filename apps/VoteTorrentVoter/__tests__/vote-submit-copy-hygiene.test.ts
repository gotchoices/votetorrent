/**
 * vote-submit-copy-hygiene.test.ts - Phase 63 plan 13 (D-01, D-04, D-05, D-06, D-07, D-09, D-20, D-21).
 *
 * Gates the Review/Submit copy: the R-1 not-registered line, the D-09 prompt, no phase numbers
 * or decision ids, en/es parity and real translation, and no claim that a vote was sent or
 * submitted. It also proves that the old false "submitted" claim is gone from en, es and every
 * non-test source file, scanning raw text so a comment cannot carry it back. Forbidden patterns are described in words only; the searched literals are
 * assembled by concatenation so the gate never trips over its own text.
 */
import fs from 'fs';
import path from 'path';
import {resources} from '../src/i18n/index';

const en = resources.en.ballot as unknown as Record<string, string>;
const es = resources.es.ballot as unknown as Record<string, string>;

const REQUIRED_SUBMIT_KEYS = [
	'submit.signPrompt.title',
	'submit.signPrompt.subtitle',
	'submit.signPrompt.negativeButton',
	'submit.recordPrompt.title',
	'submit.recordPrompt.subtitle',
	'submit.recordPrompt.negativeButton',
	'submit.checking',
	'submit.saving',
	'submit.localNote',
	'submit.blankHeading',
	'submit.blankRequiredTag',
	'submit.allBlank',
	'submit.staleReplace',
	'submit.reason.electionUnavailable',
	'submit.reason.windowClosed',
	'submit.reason.ballotUnconfirmed',
	'submit.reason.noBallots',
	'submit.reason.unsupportedQuestion',
	'submit.reason.dependentQuestion',
	'submit.reason.selectionInvalid',
	'submit.reason.requiredUnanswered',
	'submit.reason.belowMinimum',
	'submit.reason.deviceCheckFailed',
	'submit.reason.notRegistered',
	'submit.reason.registrationAmbiguous',
	'submit.reason.unreadableKey',
	'submit.reason.alreadySaved',
	'submit.failure.canceled',
	'submit.failure.biometricUnavailable',
	'submit.failure.signFailed',
	'submit.failure.signatureInvalid',
	'submit.failure.buildFailed',
	'submit.failure.keyInvalidated',
	'submit.failure.sealFailed',
	'submit.failure.storeFailed',
	'submit.failure.storeUnreadable',
	'submit.failure.unexpected',
	// Android twins of the four biometric-named keys (base key = Face ID on iOS).
	'submit.recordPrompt.subtitle.android',
	'submit.failure.canceled.android',
	'submit.failure.biometricUnavailable.android',
	'submit.failure.keyInvalidated.android',
];

describe('submit copy', () => {
	it('G6: lists 41 keys and no untracked extra submit key exists', () => {
		expect(REQUIRED_SUBMIT_KEYS).toHaveLength(41);
		const present = Object.keys(en).filter(k => k.startsWith('submit.')).sort();
		expect(present).toEqual([...REQUIRED_SUBMIT_KEYS].sort());
		const presentEs = Object.keys(es).filter(k => k.startsWith('submit.')).sort();
		expect(presentEs).toEqual([...REQUIRED_SUBMIT_KEYS].sort());
	});

	it.each(REQUIRED_SUBMIT_KEYS)('G1: %s exists, is non-empty and is translated', key => {
		expect(typeof en[key]).toBe('string');
		expect(en[key].trim().length).toBeGreaterThan(0);
		expect(typeof es[key]).toBe('string');
		expect(es[key].trim().length).toBeGreaterThan(0);
		expect(es[key]).not.toBe(en[key]);
	});

	it('G2 (R-1): the not-registered line is the exact required text', () => {
		expect(en['submit.reason.notRegistered']).toBe(
			'This phone is not registered to vote in this election, or its voting key has changed. Register this phone again.',
		);
	});

	it('G3 (D-09): the vote prompt copy is exact and every prompt value is non-empty', () => {
		expect(en['submit.signPrompt.title']).toBe('Confirm your vote');
		expect(en['submit.signPrompt.subtitle']).toBe('Sign your vote with your device key');
		for (const key of REQUIRED_SUBMIT_KEYS.filter(k => k.includes('Prompt.'))) {
			expect(en[key].trim().length).toBeGreaterThan(0);
			expect(es[key].trim().length).toBeGreaterThan(0);
		}
	});

	const all = REQUIRED_SUBMIT_KEYS.flatMap(k => [
		[`en ${k}`, en[k]],
		[`es ${k}`, es[k]],
	]);

	it.each(all)('G4: %s carries no digit, phase word or decision id', (_n, value) => {
		expect(value).not.toMatch(/\d/);
		expect(value).not.toMatch(/\b(phase|fase|plan)\b/i);
		expect(value).not.toMatch(/\bD-\d/);
	});

	it.each(all)('G5: %s makes no false sent or submitted claim', (_n, value) => {
		expect(value).not.toMatch(/\b(was|has been|have been) (sent|submitted)\b/i);
		expect(value).not.toMatch(/(fue enviad|ha sido enviad)/i);
	});

	it('G5: every failure line opens with the not-saved sentence in its language', () => {
		for (const key of REQUIRED_SUBMIT_KEYS.filter(k => k.startsWith('submit.failure.'))) {
			expect(en[key].startsWith('Your vote was not saved.')).toBe(true);
			expect(es[key].startsWith('Tu voto no se guardó.')).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------------------------
// D-10: no false "submitted" claim anywhere in the bundle or the source.
// ---------------------------------------------------------------------------------------------

const CONFIRM_KEY = 'submitted' + 'Confirmation';
const WAS_SUBMITTED = new RegExp('was ' + 'submitted', 'i');

function falseClaimHits(text: string): string[] {
	const hits: string[] = [];
	if (text.includes(CONFIRM_KEY)) {
		hits.push('key');
	}
	if (WAS_SUBMITTED.test(text)) {
		hits.push('was-submitted');
	}
	return hits;
}

function walkNonTestSources(root: string): string[] {
	const out: string[] = [];
	const visit = (dir: string) => {
		for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
			if (entry.name === 'node_modules') {
				continue;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(full);
			} else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
				out.push(full);
			}
		}
	};
	visit(root);
	return out.sort();
}

/**
 * Spike 102 made sending real: these keys say a vote WENT OUT, and are rendered only once the
 * election's strand has recorded it (SendVoteCard: a `sent` status comes from a committed block or a
 * replicated VoteBlockVoter row; the receipt's status line switches only when every ballot is sent).
 * F1b pins them to those two files, so the claim cannot leak onto a screen that has not checked.
 * Plan 65-12 adds a third: SavedVoteNotice (Home and Timeline) renders `send.allSent` only for a
 * `sent` status from `readSavedVoteStatus`, which requires every marker ballot in vote-sent-store,
 * and only vote-send-flow writes that store, with the committed block's cid.
 */
const SENT_STATE_KEYS = ['send.allSent', 'receipt.statusSent'];
const SENT_STATE_FILES = [
	'components/SavedVoteNotice.tsx',
	'screens/ballot/SendVoteCard.tsx',
	'screens/ballot/VoteReceiptScreen.tsx',
];

describe('no false submitted claim (D-10)', () => {
	it('F1b: a "sent" claim is rendered only by the surfaces that show a recorded vote', () => {
		const srcRoot = path.join(__dirname, '../src');
		const users: Record<string, string[]> = {};
		for (const file of walkNonTestSources(srcRoot)) {
			const rel = path.relative(srcRoot, file);
			if (rel === 'i18n/index.ts') {
				continue;
			}
			const text = fs.readFileSync(file, 'utf8');
			for (const key of SENT_STATE_KEYS) {
				if (text.includes(key)) {
					(users[key] ??= []).push(rel);
				}
			}
		}
		for (const key of SENT_STATE_KEYS) {
			for (const rel of users[key] ?? []) {
				expect(SENT_STATE_FILES).toContain(rel);
			}
		}
		expect(users['send.allSent']).toEqual(['components/SavedVoteNotice.tsx', 'screens/ballot/SendVoteCard.tsx']);
		expect(users['receipt.statusSent']).toEqual(['screens/ballot/VoteReceiptScreen.tsx']);
	});

	it('F1: no bundle key or value claims a vote went out', () => {
		const report: {keys: string[]; values: string[]} = {keys: [], values: []};
		for (const lang of ['en', 'es'] as const) {
			const namespaces = resources[lang] as unknown as Record<string, Record<string, string>>;
			for (const [ns, bundle] of Object.entries(namespaces)) {
				for (const [key, value] of Object.entries(bundle)) {
					if (ns === 'ballot' && SENT_STATE_KEYS.includes(key)) {
						continue;
					}
					if (key === CONFIRM_KEY) {
						report.keys.push(`${lang}.${ns}.${key}`);
					}
					const claim =
						lang === 'en'
							? WAS_SUBMITTED.test(value) ||
								// Only the ballot namespace: registration really is submitted to the authority.
								(ns === 'ballot' && /\b(has been|have been) (sent|submitted)\b/i.test(value))
							: ns === 'ballot' && /(fue enviad|ha sido enviad)/i.test(value);
					if (claim) {
						report.values.push(`${lang}.${ns}.${key}: ${value}`);
					}
				}
			}
		}
		expect(report).toEqual({keys: [], values: []});
	});

	it('F2: no non-test source file carries the claim or the key, comments included', () => {
		const srcRoot = path.join(__dirname, '../src');
		const files = walkNonTestSources(srcRoot);
		expect(files.length).toBeGreaterThan(0);
		expect(files).toContain(path.join(srcRoot, 'screens/ballot/ReviewSubmitScreen.tsx'));
		expect(files).toContain(path.join(srcRoot, 'i18n/index.ts'));
		const report: Record<string, string[]> = {};
		for (const file of files) {
			const hits = falseClaimHits(fs.readFileSync(file, 'utf8'));
			if (hits.length > 0) {
				report[path.relative(srcRoot, file)] = hits;
			}
		}
		expect(report).toEqual({});
	});

	it('F3: the checker catches planted claims and passes clean text', () => {
		expect(falseClaimHits('Your ballot was ' + 'submitted')).toEqual(['was-submitted']);
		expect(falseClaimHits("t('" + CONFIRM_KEY + "')")).toEqual(['key']);
		expect(falseClaimHits('Your vote was not saved.')).toEqual([]);
	});

	it('F4: the ballot namespace was read and lacks the old key', () => {
		expect(Object.keys(en)).toContain('submit.signPrompt.title');
		expect(Object.keys(en)).not.toContain(CONFIRM_KEY);
		expect(Object.keys(es)).not.toContain(CONFIRM_KEY);
	});
});
