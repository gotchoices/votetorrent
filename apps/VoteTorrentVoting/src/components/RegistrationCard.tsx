/**
 * RegistrationCard (REG-01/REG-05) — TDD RED stub. Full implementation lands in the following
 * GREEN commit; this stub exists only so the test file's failure is observed before that.
 */
import React from 'react';
import type {RegistrationDraft} from '../providers/RegistrationDraftProvider';

export interface RegistrationCardProps {
	isRegistered: boolean;
	draft: RegistrationDraft;
	registeredAt: string | null;
	onRegisterNow?: () => void;
	onUpdateRegistration?: () => void;
	onHelp?: () => void;
}

export function computeValidThrough(_registeredAt: string | null): string {
	return '';
}

export function RegistrationCard(_props: RegistrationCardProps) {
	return null;
}

export default RegistrationCard;
