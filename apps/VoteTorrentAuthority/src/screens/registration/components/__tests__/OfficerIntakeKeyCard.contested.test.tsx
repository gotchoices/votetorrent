import React from 'react';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@react-navigation/native', () => ({
	useTheme: () => ({
		colors: { primary: 'p', background: 'b', card: 'c', text: 't', border: 'bo', notification: 'n', error: 'e', textSecondary: 'ts', important: 'i', success: 's', accent: 'a', warning: 'w' },
	}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OfficerIntakeKeyCard } = require('../OfficerIntakeKeyCard');

function render(state: string) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<OfficerIntakeKeyCard state={state} onEnable={() => {}} />);
	});
	return tr;
}
const has = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props?.testID === id).length > 0;

describe('OfficerIntakeKeyCard contested key', () => {
	it('enabled-contested shows the enabled body AND the warning', () => {
		const tr = render('enabled-contested');
		expect(has(tr, 'officer-intake-key-enabled')).toBe(true);
		expect(has(tr, 'officer-intake-key-contested')).toBe(true);
		expect(JSON.stringify(tr.toJSON())).toContain('officerIntakeKeyContestedWarning');
		expect(has(tr, 'officer-intake-key-enable')).toBe(false);
	});

	it('negative control: enabled shows no warning', () => {
		const tr = render('enabled');
		expect(has(tr, 'officer-intake-key-enabled')).toBe(true);
		expect(has(tr, 'officer-intake-key-contested')).toBe(false);
	});
});
