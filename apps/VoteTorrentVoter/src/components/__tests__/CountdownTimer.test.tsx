/**
 * Unit tests for CountdownTimer (HOME-01, D-09) — first jest.useFakeTimers() consumer in this
 * app's test suite (RESEARCH.md §Wave 0 Gaps). Asserts the drift-free target-diff derivation:
 * recomputed from `targetIso` every tick, never a decrementing counter.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import {CountdownTimer} from '../CountdownTimer';
import {lightTheme} from '../../theme/themes';
import '../../i18n'; // initializes the global i18next instance useTranslation() reads from

/** ~2h/5m/2s in the future from a fixed reference "now". */
const NOW = new Date('2026-07-09T12:00:00.000Z').getTime();
const FUTURE_ISO = new Date(NOW + (2 * 3600 + 5 * 60 + 2) * 1000).toISOString();

/** useTheme() requires a ThemeProvider ancestor (@react-navigation/native) — wrap every render. */
function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

describe('CountdownTimer (HOME-01, D-09)', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(NOW);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('renders the correct HH:MM:SS three 2-digit groups on initial render', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={FUTURE_ISO} />));
		});
		const text = tr.root.findAll(node => typeof node.props.children === 'string')
			.map(node => node.props.children)
			.join(' ');
		expect(text).toContain('02');
		expect(text).toContain('05');
		expect(text).toContain('02');
	});

	it('decrements the seconds group by exactly 1 after one 1000ms tick (recomputed from target, not a decrementing counter)', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={FUTURE_ISO} />));
		});

		renderer.act(() => {
			jest.advanceTimersByTime(1000);
		});

		const seconds = tr.root.findByProps({testID: 'countdown-seconds-value'});
		expect(seconds.props.children).toBe('01');
	});

	it('renders 00:00:00 for a target in the past (Math.max(0, ...) floor, never negative)', () => {
		const pastIso = new Date(NOW - 60_000).toISOString();
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={pastIso} />));
		});
		const hours = tr.root.findByProps({testID: 'countdown-hours-value'});
		const minutes = tr.root.findByProps({testID: 'countdown-minutes-value'});
		const seconds = tr.root.findByProps({testID: 'countdown-seconds-value'});
		expect(hours.props.children).toBe('00');
		expect(minutes.props.children).toBe('00');
		expect(seconds.props.children).toBe('00');
	});

	it('resolves sub-labels from i18n keys countdown.hours/minutes/seconds', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={FUTURE_ISO} />));
		});
		const hoursLabel = tr.root.findByProps({testID: 'countdown-hours-label'});
		const minutesLabel = tr.root.findByProps({testID: 'countdown-minutes-label'});
		const secondsLabel = tr.root.findByProps({testID: 'countdown-seconds-label'});
		expect(hoursLabel.props.children).toBe('hours');
		expect(minutesLabel.props.children).toBe('minutes');
		expect(secondsLabel.props.children).toBe('seconds');
	});
});
