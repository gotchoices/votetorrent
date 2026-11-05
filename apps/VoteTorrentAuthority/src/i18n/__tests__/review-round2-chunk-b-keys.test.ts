/**
 * review-round2-chunk-b-keys.test.ts — the chunk-B Authority copy catalog (28 keys, en + es).
 * Renderer-free: asserts against the imported `resources` object and the source text.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resources } from '../index';

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;

const KEYS = [
	'ballotProposeRefusedLocked',
	'ballotProposeRefusedConfirmed',
	'ballotSubmitRefusedLocked',
	'ballotSubmitRefusedConfirmed',
	'ballotSubmitNeedsPropose',
	'ballotSubmittedOwnTaskHint',
	'ballotSubmittedOthersHint',
	'ballotOpenTasksLink',
	'ballotOutForConfirmationNote',
	'ballotLoadFailed',
	'registrationRequestNotFound',
	'registrationRequestLoadFailed',
	'priorRejectionsUnavailable',
	'registrationRequestChecklistIncomplete',
	'registrationRequestNoTask',
	'registrationRequestApproveFailed',
	'registrationRequestVoteFailed',
	'invitationSendFailed',
	'invitationNeedsAuthority',
	'invitationNeedsElection',
	'invitationNetworkStarting',
	'invitationNoNetwork',
	'invitationAuthorityUnresolved',
	'networkCreateFailed',
	'electionDetailsLoadFailed',
	'electionBallotsLoadFailed',
	'electionShareFailed',
	'loadRetryButton',
] as const;

const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

describe('review round 2 chunk B copy catalog', () => {
	it('lists 28 distinct keys', () => {
		expect(new Set(KEYS).size).toBe(28);
	});

	it.each(KEYS)('%s exists in en and es, translated (K-1)', key => {
		expect(typeof en[key]).toBe('string');
		expect(en[key].trim().length).toBeGreaterThan(0);
		expect(typeof es[key]).toBe('string');
		expect(es[key].trim().length).toBeGreaterThan(0);
		expect(es[key]).not.toBe(en[key]);
	});

	it.each(KEYS)('%s is declared exactly once per locale in the source (K-2)', key => {
		const matches = source.match(new RegExp(`^\\s*${key}:`, 'gm')) ?? [];
		expect(matches).toHaveLength(2);
	});

	it.each(KEYS)('%s carries no phase number, plan id or request id (K-3)', key => {
		for (const value of [en[key], es[key]]) {
			expect(value).not.toMatch(/\b(6[0-9]|phase|fase|plan)\b/i);
			expect(value).not.toMatch(/requestId/);
			expect(value).not.toMatch(/[0-9a-f]{64}/i);
		}
	});

	it('uses the catalog Spanish keyholder noun in invitationNeedsElection (K-4)', () => {
		const noun = 'custodio';
		expect(es.invitationNeedsElection.toLowerCase()).toContain(noun);
		const preExisting = Object.entries(es).filter(
			([k, v]) => !(KEYS as readonly string[]).includes(k) && /keyholder/i.test(k) && v.toLowerCase().includes(noun),
		);
		expect(preExisting.length).toBeGreaterThan(0);
	});
});
