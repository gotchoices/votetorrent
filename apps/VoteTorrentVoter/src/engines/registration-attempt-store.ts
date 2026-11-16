/**
 * registration-attempt-store.ts — the one registration attempt this phone has in flight, kept across
 * a remount of `ConfirmationScreen` and an app restart so a second Confirm RESUMES it.
 *
 * Why: the screen used to hold its attempt (registrant id, request ids, inits, device key) only in
 * refs. Navigating away and back, a restart or a Fast Refresh remount started over: Android's
 * `provisionDeviceKey` minted a new voting key (orphaning the pending association request, which
 * names the old one), and a new registrant + request pair reached the officer. A real officer
 * approves by hand, so a wait that ends before the approval must never fork the request.
 *
 * What is kept is the minimum a resume needs, and none of it is personal data:
 *   - the registrant id and the registration request's `submittedAt` (the request id is the
 *     registrant id), plus whether that request is known to be staged;
 *   - the association request init (ids, authority, election, P-256 PUBLIC key, `submittedAt`);
 *   - the P-256 public key the attempt uses, and the identity public key, authority and election
 *     it belongs to (a record for another identity, authority or election is ignored).
 * The registration PAYLOAD (name, date of birth, address, party) is never stored: it stays in the
 * in-memory draft (D-22), and a resumed attempt rebuilds the init from the draft only when the
 * request was never staged.
 *
 * This is not a status source. D-23 (registration-status.ts) still derives "registered/pending"
 * from authority-signed rows and never reads this store; the record only says which request this
 * phone is waiting on. It is removed when the attempt ends: the attestation answer is staged, the
 * authority closes the registration request, or the identity, authority or election no longer
 * match.
 *
 * Every function is best-effort and never throws: an unreadable store reads as "no attempt" and a
 * failed write leaves the screen's in-memory attempt working exactly as before.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {AssociationRequestInit} from '@votetorrent/vote-core';
import {vtDebug} from './vt-debug';

export const REGISTRATION_ATTEMPT_KEY = 'votetorrent.registrationAttempt.v1';

export interface RegistrationAttemptRecord {
	version: 1;
	/** The secp256k1 identity PUBLIC key the registration request is signed by. */
	identityKey: string;
	authorityId: string;
	electionId: string;
	/** Also the registration request's own id. */
	registrantId: string;
	registrationSubmittedAt: string;
	/** True once a registration submit for this id has succeeded on this phone. */
	registrationStaged: boolean;
	/** The P-256 PUBLIC key this attempt's association request names. */
	deviceKey: string;
	/** Null once the authority refused the association request (a new one is made on the next press). */
	association: AssociationRequestInit | null;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function isAssociationInit(v: unknown): v is AssociationRequestInit {
	const a = v as AssociationRequestInit;
	return (
		a !== null &&
		typeof a === 'object' &&
		isNonEmptyString(a.id) &&
		isNonEmptyString(a.authorityId) &&
		isNonEmptyString(a.registrantId) &&
		isNonEmptyString(a.deviceKey) &&
		(a.electionId === undefined || isNonEmptyString(a.electionId)) &&
		isNonEmptyString(a.submittedAt)
	);
}

function isRecord(v: unknown): v is RegistrationAttemptRecord {
	const r = v as RegistrationAttemptRecord;
	return (
		r !== null &&
		typeof r === 'object' &&
		r.version === 1 &&
		isNonEmptyString(r.identityKey) &&
		isNonEmptyString(r.authorityId) &&
		isNonEmptyString(r.electionId) &&
		isNonEmptyString(r.registrantId) &&
		isNonEmptyString(r.registrationSubmittedAt) &&
		typeof r.registrationStaged === 'boolean' &&
		isNonEmptyString(r.deviceKey) &&
		(r.association === null ||
			(isAssociationInit(r.association) &&
				r.association.registrantId === r.registrantId &&
				r.association.deviceKey === r.deviceKey &&
				r.association.authorityId === r.authorityId))
	);
}

/** Only the fields a resume needs, so nothing else ever reaches the store. */
function stripRecord(r: RegistrationAttemptRecord): RegistrationAttemptRecord {
	const a = r.association;
	return {
		version: 1,
		identityKey: r.identityKey,
		authorityId: r.authorityId,
		electionId: r.electionId,
		registrantId: r.registrantId,
		registrationSubmittedAt: r.registrationSubmittedAt,
		registrationStaged: r.registrationStaged,
		deviceKey: r.deviceKey,
		association:
			a === null
				? null
				: {
						id: a.id,
						authorityId: a.authorityId,
						registrantId: a.registrantId,
						deviceKey: a.deviceKey,
						...(a.electionId === undefined ? {} : {electionId: a.electionId}),
						submittedAt: a.submittedAt,
					},
	};
}

/** The stored attempt, or null when there is none or it is unreadable or malformed. Never throws. */
export async function readRegistrationAttempt(): Promise<RegistrationAttemptRecord | null> {
	try {
		const raw = await AsyncStorage.getItem(REGISTRATION_ATTEMPT_KEY);
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? parsed : null;
	} catch (err) {
		vtDebug('registration', 'attempt-read-failed', {class: err instanceof Error ? err.name : typeof err});
		return null;
	}
}

/** Replaces the stored attempt. Never throws: a failed write only loses the resume. */
export async function writeRegistrationAttempt(record: RegistrationAttemptRecord): Promise<void> {
	try {
		await AsyncStorage.setItem(REGISTRATION_ATTEMPT_KEY, JSON.stringify(stripRecord(record)));
	} catch (err) {
		vtDebug('registration', 'attempt-write-failed', {class: err instanceof Error ? err.name : typeof err});
	}
}

/** Removes the stored attempt. Never throws. */
export async function clearRegistrationAttempt(): Promise<void> {
	try {
		await AsyncStorage.removeItem(REGISTRATION_ATTEMPT_KEY);
	} catch (err) {
		vtDebug('registration', 'attempt-clear-failed', {class: err instanceof Error ? err.name : typeof err});
	}
}
