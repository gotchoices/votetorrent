import React, { createContext, useContext, useState, useCallback } from 'react';
import type { PropsWithChildren } from 'react';

/**
 * RegistrationDraftProvider — the in-memory multi-step draft Context for the registration
 * form (REG-03). Mirrors the Authority app's `BallotDraftProvider` structurally
 * (createContext + useContext + hook-with-throw + Provider) but holds a FLAT
 * `RegistrationDraft` object with a single generic `updateField(field, value)` setter,
 * instead of BallotDraftProvider's per-entity add/update/remove set — the registration
 * draft is flat, not a nested array (see 41-RESEARCH.md Pattern 2).
 *
 * Held in-memory React state ONLY (D-03) — never persisted to AsyncStorage/SecureStore/
 * disk, and never logged. This draft is never explicitly cleared after a successful
 * submission (D-06): the registered card and Update-registration pre-fill (D-04) both
 * read from this same never-cleared draft instance. `resetDraft` is exposed for parity
 * with `BallotDraftProvider`'s completeness but is unused by any screen this phase
 * (RESEARCH Pattern 2).
 *
 * App-local only — does NOT import from `vote-core` (D-04) and does NOT call
 * `useVotingApp()` (this is a provider, not a screen; it intentionally lives outside
 * the `src/screens/` scan root exercised by `__tests__/no-inline-mock-imports.test.ts`).
 *
 * Pattern reference: apps/VoteTorrentAuthority/src/screens/ballots/providers/BallotDraftProvider.tsx
 */

export interface RegistrationDraft {
	firstName: string;
	lastName: string;
	dob: string; // freeform text, no parsed Date — mock-permissive (D-02)
	email: string;
	phone: string;
	addressLine1: string;
	addressLine2: string; // optional, may be empty string
	addressLine3: string; // optional, may be empty string
	// Stable party KEY ('democratic'|'republican'|'independent'|'other'), or '' if unselected.
	// Manual-QA gap-closure (Phase 41 re-verification): previously stored the LOCALIZED LABEL
	// captured at selection time, so switching languages left stale-language text in the
	// review/identity-line display sites. Storing the key instead keeps the draft
	// locale-independent — display sites resolve `t('form.party.' + party)` at render time.
	party: string;
}

export const EMPTY_DRAFT: RegistrationDraft = {
	firstName: '',
	lastName: '',
	dob: '',
	email: '',
	phone: '',
	addressLine1: '',
	addressLine2: '',
	addressLine3: '',
	party: '',
};

export interface RegistrationDraftContextType {
	draft: RegistrationDraft;
	updateField: (field: keyof RegistrationDraft, value: string) => void;
	resetDraft: () => void;
}

const RegistrationDraftContext = createContext<RegistrationDraftContextType | null>(null);

export function useRegistrationDraft(): RegistrationDraftContextType {
	const context = useContext(RegistrationDraftContext);
	if (!context) {
		throw new Error('useRegistrationDraft must be used within a RegistrationDraftProvider');
	}
	return context;
}

export function RegistrationDraftProvider({ children }: PropsWithChildren) {
	const [draft, setDraft] = useState<RegistrationDraft>(EMPTY_DRAFT);

	const updateField = useCallback((field: keyof RegistrationDraft, value: string) => {
		setDraft((prev) => ({ ...prev, [field]: value }));
	}, []);

	const resetDraft = useCallback(() => setDraft(EMPTY_DRAFT), []);

	return (
		<RegistrationDraftContext.Provider value={{ draft, updateField, resetDraft }}>
			{children}
		</RegistrationDraftContext.Provider>
	);
}
