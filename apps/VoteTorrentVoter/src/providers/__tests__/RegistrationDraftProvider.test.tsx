/**
 * Unit tests for RegistrationDraftProvider / useRegistrationDraft — REG-03 draft basis.
 *
 * Written as .tsx (uses JSX) mirroring the Probe-capture render harness pattern from
 * ../../__tests__/voting-app-provider.test.ts, adapted for a flat-field draft context
 * instead of the VoterAppProvider's lifecycle/election shape.
 */

import React from 'react';
import renderer from 'react-test-renderer';
import {
	RegistrationDraftProvider,
	useRegistrationDraft,
	EMPTY_DRAFT,
} from '../RegistrationDraftProvider';
import type { RegistrationDraftContextType } from '../RegistrationDraftProvider';

/**
 * Renders RegistrationDraftProvider with a probe child that captures the current context
 * value on every render, so the test can read/act on draft/updateField/resetDraft.
 */
function renderProvider() {
	const captured: { value: RegistrationDraftContextType | null } = { value: null };

	function Probe() {
		captured.value = useRegistrationDraft();
		return null;
	}

	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<RegistrationDraftProvider>
				<Probe />
			</RegistrationDraftProvider>,
		);
	});
	return { tr, captured };
}

describe('RegistrationDraftProvider / useRegistrationDraft (REG-03, D-03)', () => {
	it('useRegistrationDraft() throws the exact message when called outside a RegistrationDraftProvider', () => {
		function Orphan() {
			useRegistrationDraft();
			return null;
		}
		expect(() => {
			renderer.act(() => {
				renderer.create(<Orphan />);
			});
		}).toThrow('useRegistrationDraft must be used within a RegistrationDraftProvider');
	});

	it('initial draft equals EMPTY_DRAFT — all 9 fields are empty strings', () => {
		const { captured } = renderProvider();
		expect(captured.value!.draft).toEqual(EMPTY_DRAFT);
		expect(Object.keys(captured.value!.draft)).toHaveLength(9);
		Object.values(captured.value!.draft).forEach((v) => expect(v).toBe(''));
	});

	it("updateField('firstName', 'Jane') writes 'Jane' to draft.firstName and leaves other fields untouched", () => {
		const { captured } = renderProvider();

		renderer.act(() => {
			captured.value!.updateField('firstName', 'Jane');
		});

		expect(captured.value!.draft.firstName).toBe('Jane');
		expect(captured.value!.draft.lastName).toBe('');
		expect(captured.value!.draft.dob).toBe('');
		expect(captured.value!.draft.email).toBe('');
		expect(captured.value!.draft.phone).toBe('');
		expect(captured.value!.draft.addressLine1).toBe('');
		expect(captured.value!.draft.addressLine2).toBe('');
		expect(captured.value!.draft.addressLine3).toBe('');
		expect(captured.value!.draft.party).toBe('');
	});

	it('updateField twice on different fields accumulates both (functional update, no clobber)', () => {
		const { captured } = renderProvider();

		renderer.act(() => {
			captured.value!.updateField('firstName', 'Jane');
		});
		renderer.act(() => {
			captured.value!.updateField('lastName', 'Doe');
		});

		expect(captured.value!.draft.firstName).toBe('Jane');
		expect(captured.value!.draft.lastName).toBe('Doe');
	});

	it('resetDraft() after edits returns draft deep-equal to EMPTY_DRAFT (backward-compatible alias)', () => {
		const { captured } = renderProvider();

		renderer.act(() => {
			captured.value!.updateField('firstName', 'Jane');
		});
		renderer.act(() => {
			captured.value!.updateField('email', 'jane@example.com');
		});
		expect(captured.value!.draft).not.toEqual(EMPTY_DRAFT);

		renderer.act(() => {
			captured.value!.resetDraft();
		});

		expect(captured.value!.draft).toEqual(EMPTY_DRAFT);
	});

	it('clearDraft() after edits resets all fields to EMPTY_DRAFT (D-06 deferred — in-memory only)', () => {
		const { captured } = renderProvider();

		renderer.act(() => {
			captured.value!.updateField('firstName', 'Jane');
		});
		renderer.act(() => {
			captured.value!.updateField('lastName', 'Doe');
		});
		renderer.act(() => {
			captured.value!.updateField('party', 'independent');
		});
		expect(captured.value!.draft).not.toEqual(EMPTY_DRAFT);

		renderer.act(() => {
			captured.value!.clearDraft();
		});

		expect(captured.value!.draft).toEqual(EMPTY_DRAFT);
	});
});

describe('RegistrationDraftProvider source (D-06 deferred — no persistence API)', () => {
	it('does not import react-native-keychain, AsyncStorage, or any other persistence API', () => {
		const fs = require('fs');
		const path = require('path');
		const source: string = fs.readFileSync(
			path.resolve(__dirname, '../RegistrationDraftProvider.tsx'),
			'utf8',
		);
		// Only import/require statements matter here — the file's own doc-comment legitimately
		// *mentions* these names to explain that persistence is intentionally NOT used.
		const importLines = source
			.split('\n')
			.filter((line) => /^\s*import\b/.test(line) || /\brequire\(/.test(line));
		const importedSource = importLines.join('\n');
		expect(importedSource).not.toMatch(/react-native-keychain/);
		expect(importedSource).not.toMatch(/async-storage/i);
		expect(importedSource).not.toMatch(/AsyncStorage/);
		expect(importedSource).not.toMatch(/SecureStore/);
	});
});
