/**
 * Unit tests for ProgressBar (HOME-01, D-10) — token-styled 0-1 fill with clamping.
 * Bar only (no label, no i18n) — ElectionCard (40-04) owns the "{{percent}}% complete" text.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import {ProgressBar} from '../ProgressBar';
import {lightTheme} from '../../theme/themes';

/** useTheme() requires a ThemeProvider ancestor (@react-navigation/native) — wrap every render. */
function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

function renderBar(progress: number) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(withTheme(<ProgressBar progress={progress} />));
	});
	return tr;
}

describe('ProgressBar (HOME-01, D-10)', () => {
	it('renders a fill whose width style is "30%" for progress 0.3', () => {
		const tr = renderBar(0.3);
		const fill = tr.root.findByProps({testID: 'progress-bar-fill'});
		const style = fill.props.style;
		expect(style).toEqual(expect.arrayContaining([expect.objectContaining({width: '30%'})]));
	});

	it('clamps progress 1.5 to a "100%" fill width', () => {
		const tr = renderBar(1.5);
		const fill = tr.root.findByProps({testID: 'progress-bar-fill'});
		const style = fill.props.style;
		expect(style).toEqual(expect.arrayContaining([expect.objectContaining({width: '100%'})]));
	});

	it('clamps progress -0.2 to a "0%" fill width', () => {
		const tr = renderBar(-0.2);
		const fill = tr.root.findByProps({testID: 'progress-bar-fill'});
		const style = fill.props.style;
		expect(style).toEqual(expect.arrayContaining([expect.objectContaining({width: '0%'})]));
	});

	it('uses colors.progressTrack/progressFill and radii.pill from useTheme() for track and fill', () => {
		const tr = renderBar(0.5);
		const track = tr.root.findByProps({testID: 'progress-bar-track'});
		const fill = tr.root.findByProps({testID: 'progress-bar-fill'});
		expect(track.props.style).toEqual(
			expect.arrayContaining([
				expect.objectContaining({backgroundColor: lightTheme.colors.progressTrack, borderRadius: lightTheme.radii.pill}),
			]),
		);
		expect(fill.props.style).toEqual(
			expect.arrayContaining([
				expect.objectContaining({backgroundColor: lightTheme.colors.progressFill, borderRadius: lightTheme.radii.pill}),
			]),
		);
	});
});
