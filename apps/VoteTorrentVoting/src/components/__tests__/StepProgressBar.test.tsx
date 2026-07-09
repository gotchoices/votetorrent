/**
 * Unit tests for StepProgressBar (REG-03) — a 3-segment progress bar + "Step X of 3" caption,
 * reusing Phase 40's `progressFill`/`progressTrack` tokens. Prop-driven (`step: 1 | 2 | 3`),
 * no own state; mirrors ElectionCard.test.tsx's `import '../../i18n'` + ThemeProvider wrapper
 * since this component calls `useTranslation('registration')`.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import {StepProgressBar} from '../StepProgressBar';
import {lightTheme} from '../../theme/themes';
import '../../i18n'; // initializes the global i18next instance useTranslation() reads from

function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

const activeRenderers: renderer.ReactTestRenderer[] = [];

function renderBar(step: 1 | 2 | 3) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(withTheme(<StepProgressBar step={step} />));
	});
	activeRenderers.push(tr);
	return tr;
}

afterEach(() => {
	while (activeRenderers.length) {
		const tr = activeRenderers.pop()!;
		renderer.act(() => {
			tr.unmount();
		});
	}
});

function fillCount(tr: renderer.ReactTestRenderer, fillColor: string) {
	return [1, 2, 3].filter(n => {
		const segment = tr.root.findByProps({testID: `step-segment-${n}`});
		const flatStyle = [].concat(segment.props.style).reduce((acc, s) => ({...acc, ...s}), {});
		return flatStyle.backgroundColor === fillColor;
	}).length;
}

describe('StepProgressBar (REG-03)', () => {
	it('step 1: renders 3 segments, 1 filled, caption resolves "Step 1 of 3"', () => {
		const tr = renderBar(1);
		expect(fillCount(tr, lightTheme.colors.progressFill)).toBe(1);
		expect(tr.root.findByProps({testID: 'step-segment-1'})).toBeTruthy();
		expect(tr.root.findByProps({testID: 'step-segment-2'})).toBeTruthy();
		expect(tr.root.findByProps({testID: 'step-segment-3'})).toBeTruthy();
		expect(tr.root.findByProps({children: 'Step 1 of 3'})).toBeTruthy();
	});

	it('step 2: 2 filled segments, caption resolves "Step 2 of 3"', () => {
		const tr = renderBar(2);
		expect(fillCount(tr, lightTheme.colors.progressFill)).toBe(2);
		expect(tr.root.findByProps({children: 'Step 2 of 3'})).toBeTruthy();
	});

	it('step 3: 3 filled segments, caption resolves "Step 3 of 3"', () => {
		const tr = renderBar(3);
		expect(fillCount(tr, lightTheme.colors.progressFill)).toBe(3);
		expect(tr.root.findByProps({children: 'Step 3 of 3'})).toBeTruthy();
	});
});
