/**
 * Unit tests for OfficeRow (VOTE-01, 42-RESEARCH Recommended Project Structure) — a presentational
 * office card on the Ballot Page: title, current-selection summary, "Learn about this office"
 * link, tap-to-open-question.
 *
 * Presentational-only: `title`/`selectionSummary`/`hasSelection`/`onOpen`/`onLearnAboutOffice`
 * props in, no internal state and no `useVoterApp()`/`useNavigation()` — the caller
 * (BallotScreen, Plan 05) resolves display strings (candidate names, "Not yet answered" copy)
 * before passing them down, mirroring PartyChipSelector/ElectionCard's presentational discipline.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import {OfficeRow} from '../OfficeRow';
import {lightTheme} from '../../theme/themes';

function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

const activeRenderers: renderer.ReactTestRenderer[] = [];

function renderRow(props: Partial<React.ComponentProps<typeof OfficeRow>> = {}) {
	const merged = {
		title: 'U.S. Senate',
		selectionSummary: 'Not yet answered',
		hasSelection: false,
		learnLabel: 'Learn about this office',
		onOpen: jest.fn(),
		onLearnAboutOffice: jest.fn(),
		...props,
	};
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(withTheme(<OfficeRow {...merged} />));
	});
	activeRenderers.push(tr);
	return {tr, props: merged};
}

afterEach(() => {
	while (activeRenderers.length) {
		const tr = activeRenderers.pop()!;
		renderer.act(() => {
			tr.unmount();
		});
	}
});

describe('OfficeRow (VOTE-01)', () => {
	it('renders the office title', () => {
		const {tr} = renderRow({title: 'U.S. Senate'});
		expect(tr.root.findByProps({children: 'U.S. Senate'})).toBeTruthy();
	});

	it('shows the chevron (and no selection summary) when hasSelection is false', () => {
		const {tr} = renderRow({selectionSummary: 'Not yet answered', hasSelection: false});
		// Figma: an unanswered office shows only the chevron affordance — no summary copy.
		expect(tr.root.findByProps({testID: 'office-row-chevron'})).toBeTruthy();
		expect(tr.root.findAllByProps({testID: 'office-row-selection'})).toHaveLength(0);
		expect(tr.root.findAllByProps({testID: 'office-row-check'})).toHaveLength(0);
	});

	it('renders the selected candidate name(s) + green check when hasSelection is true, in colors.success', () => {
		const {tr} = renderRow({selectionSummary: 'Alice Adams', hasSelection: true});
		const summaryText = tr.root.findByProps({children: 'Alice Adams'});
		const flatStyle = Object.assign({}, ...[summaryText.props.style].flat(Infinity).filter(Boolean));
		expect(flatStyle.color).toBe(lightTheme.colors.success);
		expect(tr.root.findByProps({testID: 'office-row-check'})).toBeTruthy();
		expect(tr.root.findAllByProps({testID: 'office-row-chevron'})).toHaveLength(0);
	});

	it('renders the caller-resolved learn-link label', () => {
		const {tr} = renderRow({learnLabel: 'Learn about this office'});
		expect(tr.root.findByProps({children: 'Learn about this office'})).toBeTruthy();
	});

	it('tapping the row calls onOpen()', () => {
		const {tr, props} = renderRow();
		const openTarget = tr.root.findByProps({testID: 'office-row-open'});
		renderer.act(() => {
			openTarget.props.onPress();
		});
		expect(props.onOpen).toHaveBeenCalledTimes(1);
	});

	it('tapping the "Learn about this office" link calls onLearnAboutOffice()', () => {
		const {tr, props} = renderRow();
		const learnTarget = tr.root.findByProps({testID: 'office-row-learn'});
		renderer.act(() => {
			learnTarget.props.onPress();
		});
		expect(props.onLearnAboutOffice).toHaveBeenCalledTimes(1);
	});
});
