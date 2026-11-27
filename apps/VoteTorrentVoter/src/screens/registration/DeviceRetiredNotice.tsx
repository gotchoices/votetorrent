/**
 * DeviceRetiredNotice.tsx — Phase 62 Plan 28 (D-41). Surface 8's old-device full-screen notice:
 * once a re-association for this registrant's new device is approved, this device's own key is
 * retired. `RootNavigator` (navigation/index.tsx) replaces the WHOLE tab navigator with this
 * screen — at app open and on every return to the foreground — rather than letting the voter
 * navigate into a non-functional "home" (62-UI-SPEC Surface 8). No CTA is offered: there is
 * nothing a retired device can do.
 *
 * `useDeviceRetired()` fails open (`false`, i.e. "not retired") on ANY read error — the actual
 * security property is enforced by the deleted `Association` row, not by this notice
 * (T-62-28-07, mirrored from `continuity.ts`'s `resolveDeviceRetired`). It latches `true` once
 * observed true: a retired key never becomes un-retired for the lifetime of this session.
 */
import React, {useEffect, useRef, useState} from 'react';
import {AppState, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {resolveAttestationProducer} from '../../engines/attestation-producer';
import {resolveDeviceRetired} from '../../engines/continuity';
import {globalStyles} from '../../theme/styles';

export function DeviceRetiredNotice() {
	const {colors, type: typeScale, fonts} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('continuity');
	const insets = useSafeAreaInsets();

	return (
		<View
			testID="device-retired-notice"
			style={[
				styles.screen,
				{backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom},
			]}>
			<View style={globalStyles.container}>
				<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
					<Text
						style={[
							styles.heading,
							{
								color: colors.text,
								fontFamily: fonts.medium.fontFamily,
								fontWeight: fonts.medium.fontWeight,
								fontSize: typeScale.h4.fontSize,
								lineHeight: typeScale.h4.lineHeight,
							},
						]}>
						{t('deviceRetired.heading')}
					</Text>
					<Text
						style={[
							styles.body,
							{
								color: colors.textSecondary,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							},
						]}>
						{t('deviceRetired.body')}
					</Text>
				</View>
			</View>
		</View>
	);
}

/**
 * Runs once on mount and on every `AppState` transition to `'active'` (per the plan's discretion:
 * a never-registered phone does no hardware-key provisioning at app open, which
 * `resolveDeviceRetired`'s own `identityKeyState` gate already short-circuits for). Latches
 * `true`; ignores results after unmount.
 */
export function useDeviceRetired(): boolean {
	const {getEngine} = useVoterApp();
	const [retired, setRetired] = useState(false);
	const retiredRef = useRef(false);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		async function check() {
			if (retiredRef.current) return;
			const result = await resolveDeviceRetired({
				getEngine,
				getCurrentDeviceKey: () => resolveAttestationProducer().getCurrentDeviceKey(),
			});
			if (!mountedRef.current) return;
			if (result) {
				retiredRef.current = true;
				setRetired(true);
			}
		}
		check();

		const sub = AppState.addEventListener('change', state => {
			if (state === 'active') {
				check();
			}
		});
		return () => {
			sub.remove();
		};
	}, [getEngine]);

	return retired;
}

export default DeviceRetiredNotice;

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	heading: {
		marginBottom: 8, // sm
	},
	body: {},
});
