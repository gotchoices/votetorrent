/**
 * headerTouchTargets.test.tsx — O-03 (Voter): the modal CloseButton's layout box must be at
 * least 44 x 44 dp, not only a hitSlop.
 */
import React from 'react';
import {StyleSheet} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import {NavigationContainer, ThemeProvider} from '@react-navigation/native';
import '../../i18n';
import {lightTheme} from '../../theme/themes';

jest.mock('../../providers/VoterAppProvider');
jest.mock('../../providers/CadreNodeProvider', () => ({
	useCadreNode: () => ({node: null, syncState: 'offline', connectedPeers: () => 0}),
	CadreNodeProvider: ({children}: {children: React.ReactNode}) => children,
}));

import {CloseButton} from '../index';

describe('Voter header CloseButton (O-03)', () => {
	it('N1/N3: box >= 44 x 44, centred, keeps hitSlop, button role and label', async () => {
		let tr!: ReactTestRenderer.ReactTestRenderer;
		await ReactTestRenderer.act(async () => {
			tr = ReactTestRenderer.create(
				<NavigationContainer>
					<ThemeProvider value={lightTheme}>
						<CloseButton onPress={jest.fn()} />
					</ThemeProvider>
				</NavigationContainer>,
			);
		});
		const btn = tr.root.findAll(n => n.props.hitSlop === 8 && typeof n.props.onPress === 'function')[0];
		const style = StyleSheet.flatten(btn.props.style) as Record<string, unknown>;
		expect(style.minWidth).toBeGreaterThanOrEqual(44);
		expect(style.minHeight).toBeGreaterThanOrEqual(44);
		expect(style.alignItems).toBe('center');
		expect(style.justifyContent).toBe('center');
		expect(btn.props.hitSlop).toBe(8);
		expect(btn.props.accessibilityRole).toBe('button');
		expect(btn.props.accessibilityLabel).toBeTruthy();
	});
});
