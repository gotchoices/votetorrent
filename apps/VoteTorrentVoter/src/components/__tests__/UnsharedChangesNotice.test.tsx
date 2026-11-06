/**
 * UnsharedChangesNotice -- todo 2026-09-11-optimystic-commit-success-hides-unresolvable-cohort.
 * Home shows how many writes on this phone no other member of the election network holds yet,
 * read live from the CommitDurabilityTracker the CadreNodeProvider publishes.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import {lightTheme} from '../../theme/themes';
import '../../i18n';
import {UnsharedChangesNotice} from '../UnsharedChangesNotice';
import {CommitShareProvider} from '../../hooks/useCommitShare';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

/** A tracker double with the subscribe contract the hooks rely on. */
function fakeTracker(initial: number) {
	const listeners = new Set<() => void>();
	const t = {
		unsharedCount: initial,
		subscribe: (l: () => void) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		actionState: () => 'unknown',
		waitingActionCount: () => 0,
		set(n: number) {
			t.unsharedCount = n;
			for (const l of listeners) l();
		},
	};
	return t;
}

function render(tracker: ReturnType<typeof fakeTracker> | null) {
	let tr!: renderer.ReactTestRenderer;
	const body = tracker ? (
		<CommitShareProvider tracker={tracker as never}>
			<UnsharedChangesNotice />
		</CommitShareProvider>
	) : (
		<UnsharedChangesNotice />
	);
	renderer.act(() => {
		tr = renderer.create(<ThemeProvider value={lightTheme as never}>{body}</ThemeProvider>);
	});
	return tr;
}

describe('UnsharedChangesNotice', () => {
	it('shows the count of writes not yet on the election network', () => {
		const tr = render(fakeTracker(2));
		expect(JSON.stringify(tr.toJSON())).toContain('Saved on this phone, not yet on the election network: 2');
	});

	it('updates live when a write becomes shared, and disappears at zero', () => {
		const tracker = fakeTracker(1);
		const tr = render(tracker);
		expect(JSON.stringify(tr.toJSON())).toContain('unshared-changes-notice');
		renderer.act(() => tracker.set(3));
		expect(JSON.stringify(tr.toJSON())).toContain('election network: 3');
		renderer.act(() => tracker.set(0));
		expect(tr.toJSON()).toBeNull();
	});

	it('control: renders nothing outside the provider (screen tests without a node)', () => {
		const tr = render(null);
		expect(tr.toJSON()).toBeNull();
	});
});
