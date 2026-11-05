/**
 * Unit tests for NetworkHeader's title: the open network's name when given, the `networkName`
 * copy otherwise. Presentational — no provider, mirrors RegistrationCard.test.tsx.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {NetworkHeader} from '../NetworkHeader';
import {lightTheme} from '../../theme/themes';
import '../../i18n'; // initializes the global i18next instance useTranslation() reads from

function renderTitle(networkName?: string): string {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<SafeAreaProvider initialMetrics={{frame: {x: 0, y: 0, width: 390, height: 844}, insets: {top: 0, left: 0, right: 0, bottom: 0}}}>
				<ThemeProvider value={lightTheme}>
					<NetworkHeader networkName={networkName} />
				</ThemeProvider>
			</SafeAreaProvider>,
		);
	});
	return JSON.stringify(tr.root.findByProps({testID: 'network-header-title'}).findAllByType(Text)[0]!.props.children);
}

describe('NetworkHeader', () => {
	it("shows the open network's name", () => {
		expect(renderTitle('Lean Network')).toBe('"Lean Network"');
	});

	it('falls back to the common network name when none is open', () => {
		expect(renderTitle()).toBe('"Utah Network"');
	});
});
