/**
 * saved-vote-copy-hygiene.test.ts - Phase 63 plan 14 (D-12, D-21).
 *
 * Gates the saved-vote lines on Home and Timeline: exact en wording, es translated, no promise of
 * sending, no claim of sending, no phase numbers. Asserts ONLY against the imported `resources`,
 * never a source file, so it cannot trip over its own comments. Forbidden patterns are described
 * in words here and built by concatenation where a literal is needed.
 */
import {resources} from '../src/i18n/index';

const enBallot = resources.en.ballot as unknown as Record<string, string>;
const esBallot = resources.es.ballot as unknown as Record<string, string>;
const enTimeline = resources.en.timeline as unknown as Record<string, string>;
const esTimeline = resources.es.timeline as unknown as Record<string, string>;

const enHome = resources.en.home as unknown as Record<string, string>;
const esHome = resources.es.home as unknown as Record<string, string>;

const EN_VALUES = [enBallot['savedVote.status'], enBallot['savedVote.viewCta'], enTimeline['voting.viewSubmissionCta']];
const ES_VALUES = [esBallot['savedVote.status'], esBallot['savedVote.viewCta'], esTimeline['voting.viewSubmissionCta']];

describe('saved-vote copy (D-12, D-21)', () => {
	it('C1: exact en wording', () => {
		expect(enBallot['savedVote.status']).toBe('Vote saved — not sent');
		expect(enBallot['savedVote.viewCta']).toBe('View saved vote');
		expect(enTimeline['voting.viewSubmissionCta']).toBe('View saved vote');
	});

	it('C2: es exists, is non-empty and differs from en', () => {
		expect(ES_VALUES.every(v => typeof v === 'string' && v.length > 0)).toBe(true);
		EN_VALUES.forEach((v, i) => expect(ES_VALUES[i]).not.toBe(v));
		expect(esBallot['savedVote.status']).toContain('no enviado');
	});

	it('C3: no digits, no phase or plan word, no decision id', () => {
		for (const v of [...EN_VALUES, ...ES_VALUES]) {
			expect(v).not.toMatch(/\d/);
			expect(v).not.toMatch(/\b(phase|fase|plan)\b/i);
			expect(v).not.toMatch(/\bD-\d/);
		}
	});

	it('C4: no promise of sending', () => {
		for (const v of EN_VALUES) expect(v).not.toMatch(/\b(will|soon|automatically|later|when)\b/i);
		for (const v of ES_VALUES) expect(v).not.toMatch(/(se enviará|pronto|automáticamente|más tarde|cuando)/i);
	});

	it('C5: no claim that a vote was sent', () => {
		for (const v of EN_VALUES) expect(v).not.toMatch(/\b(was|has been|have been) (sent|submitted)\b/i);
		for (const v of ES_VALUES) expect(v).not.toMatch(/(fue enviad|ha sido enviad)/i);
		expect(enBallot['savedVote.status']).toContain('not sent');
	});

	it('C6: the reused receipt keys are present (non-vacuity)', () => {
		for (const k of ['receipt.stale', 'receipt.unreadable', 'receipt.revisionUnknown']) {
			expect(enBallot[k]).toEqual(expect.any(String));
			expect(enBallot[k].length).toBeGreaterThan(0);
			expect(esBallot[k]).toEqual(expect.any(String));
			expect(esBallot[k].length).toBeGreaterThan(0);
		}
		expect(enBallot['receipt.stale']).toBe('The election changed after you voted. Please vote again.');
	});

	it('C7: the old Timeline label is gone', () => {
		const old = 'View ' + 'submission';
		for (const v of Object.values(enTimeline)) expect(v).not.toBe(old);
	});

	it('C8: the old voted pill key and copy are gone', () => {
		const key = 'voted' + 'Cta';
		expect(key in enHome).toBe(false);
		expect(key in esHome).toBe(false);
		const old = 'You ' + 'voted';
		for (const ns of [enHome, enBallot, enTimeline]) {
			for (const v of Object.values(ns)) expect(v).not.toBe(old);
		}
	});
});
