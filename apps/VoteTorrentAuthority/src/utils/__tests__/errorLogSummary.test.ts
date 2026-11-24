/**
 * errorLogSummary: the accept screens log WHY an answer failed (class, code, scrubbed message), and
 * the line never carries the invitation text, a key, a CID or a peer id. Secrets are real-shaped
 * (random keys, a real invitation share); matchers stay boolean so a failure never prints them.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { captureConsole, expectNoSecretInConsole } from '../../engines/__fixtures__/console-leak';
import { errorLogSummary, scrubLogText } from '../errorLogSummary';
import { serializeInviteShare } from '../../screens/invitations/invite-share';

function share() {
	const priv = secp256k1.utils.randomSecretKey();
	const invitePrivate = bytesToHex(priv);
	const inviteKey = bytesToHex(secp256k1.getPublicKey(priv));
	const text = serializeInviteShare({ invitePrivate, inviteKey, expiration: '2026-11-25T08:00:00.000', type: 'k', name: 'Ada Keyholder' });
	return { invitePrivate, inviteKey, text };
}

const SLOT_CID = 'bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const PEER_ID = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const UUID = '7d9f3c2a-1b4e-4f6a-9c8d-2e5b7a1f0c3d';

describe('errorLogSummary', () => {
	it('names the class, the code and the native code', () => {
		const err = Object.assign(new Error('key-vault: native wrap denied'), { name: 'KeyVaultError', code: 'auth-denied', nativeCode: 'CANCELED' });
		const line = errorLogSummary(err);
		expect(line.startsWith('class=KeyVaultError code=auth-denied native=CANCELED msg=')).toBe(true);
	});

	it('keeps the words that say why', () => {
		const line = errorLogSummary(new Error('InvitationEngine.respondToInvite: Block x is unavailable (cohort-unreachable)'));
		expect(line).toBe('class=Error msg=InvitationEngine.respondToInvite: Block x is unavailable (cohort-unreachable)');
		expect(errorLogSummary(Object.assign(new Error('dial timeout'), { code: 'DIAL_TIMEOUT' }))).toBe('class=Error code=DIAL_TIMEOUT msg=dial timeout');
	});

	it('handles non-errors and odd shapes without throwing', () => {
		expect(errorLogSummary(undefined)).toBe('type=undefined');
		expect(errorLogSummary(null)).toBe('type=null');
		expect(errorLogSummary('boom')).toBe('type=string');
		expect(errorLogSummary({ name: 'has spaces in it', code: 5 })).toBe('class=unknown');
		const hostile = { get message(): string { throw new Error('no'); } };
		expect(errorLogSummary(hostile)).toBe('class=unknown');
	});

	it('caps a long message', () => {
		expect(scrubLogText('word '.repeat(200)).length).toBeLessThanOrEqual(241);
	});

	it('never logs the invitation text, a key, a CID, a peer id or a UUID', () => {
		const s = share();
		const messages = [
			`InvitationEngine.respondToInvite: bad share ${s.text}`,
			`respond failed for ${s.invitePrivate} against ${s.inviteKey}`,
			`InviteSlot not found for Cid: ${SLOT_CID}`,
			`response timeout: peer=${PEER_ID} protocol=/optimystic/repo/1.0.0 after 9000ms`,
			`key-vault: native wrap denied for alias 'keyholder-signing:${UUID}' (CANCELED)`,
			`Quereus error (code 19): CHECK failed with value "${s.invitePrivate.slice(0, 20)}"`,
			`prefix ${s.text.slice(0, 40)} no closing brace`,
		];
		const c = captureConsole();
		try {
			for (const m of messages) console.warn('Error responding to invite:', errorLogSummary(new Error(m)));
			expectNoSecretInConsole(c, [s.text, s.invitePrivate, s.inviteKey, SLOT_CID, PEER_ID, UUID, 'Ada Keyholder']);
		} finally {
			c.restore();
		}
	});
});
