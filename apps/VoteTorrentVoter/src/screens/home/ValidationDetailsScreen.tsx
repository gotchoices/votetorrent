/**
 * ValidationDetailsScreen — pushed within the Vote stack (HOME-03/D-11 trust-story drill-in),
 * faithful to Figma frame `276:868`. Plain native-stack push (mirrors `BallotScreen`'s own
 * registration exactly) — NOT a modal, with NO custom breadcrumb component (the native-stack
 * default header, back chevron + title, IS the "breadcrumb" D-06 refers to).
 *
 * Terminal drill-in (D-05): no action button, nothing navigates further from here.
 */
import React, {useEffect, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useVoterApp} from '../../providers/VoterAppProvider';
import type {MockElection} from '../../providers/types';
import {globalStyles} from '../../theme/styles';

export default function ValidationDetailsScreen() {
	// D-06/SHELL-03: reads through useVoterApp() — no inline mockData import.
	const {getElection} = useVoterApp();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('home');
	const [election, setElection] = useState<MockElection | null>(null);

	useEffect(() => {
		let cancelled = false;
		getElection().then(result => {
			if (!cancelled) {
				setElection(result);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [getElection]);

	if (!election || !election.evidence) {
		// Not yet loaded — render nothing rather than a flash of empty content (BallotScreen has
		// no equivalent loading gate since it doesn't fetch; this screen does).
		return <View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]} />;
	}

	const evidence = election.evidence;
	const verified = evidence.filter(check => check.verified).length;
	const total = evidence.length;

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<Text
				style={[
					styles.overallCount,
					{
						color: colors.text,
						fontFamily: fonts.medium.fontFamily,
						fontWeight: fonts.medium.fontWeight,
						fontSize: typeScale.h4.fontSize,
						lineHeight: typeScale.h4.lineHeight,
					},
				]}>
				{t('validationDetails.overallCount', {verified, total})}
			</Text>

			<View style={styles.rowList}>
				{evidence.map((check, index) => (
					<View
						key={`${check.nameKey}-${index}`}
						style={[globalStyles.cardSurface, {backgroundColor: colors.card}, styles.row]}>
						<View style={styles.rowLeft}>
							<Text
								style={[
									styles.rowName,
									{
										color: colors.text,
										fontFamily: fonts.regular.fontFamily,
										fontWeight: fonts.regular.fontWeight,
										fontSize: typeScale.body.fontSize,
										lineHeight: typeScale.body.lineHeight,
									},
								]}>
								{t(check.nameKey)}
							</Text>
							<Text
								style={[
									styles.rowResult,
									{
										color: colors.textSecondary,
										fontFamily: fonts.regular.fontFamily,
										fontWeight: fonts.regular.fontWeight,
										fontSize: typeScale.body.fontSize,
										lineHeight: typeScale.body.lineHeight,
									},
								]}>
								{t(check.resultKey)}
							</Text>
						</View>
						<View style={styles.rowRight}>
							<Text
								style={[
									styles.rowTime,
									{
										color: colors.textSecondary,
										fontSize: typeScale.caption.fontSize,
										lineHeight: typeScale.caption.lineHeight,
									},
								]}>
								{check.elapsedSeconds}s
							</Text>
							<View style={styles.statusFlag}>
								<FontAwesome6
									name={check.verified ? 'circle-check' : 'circle'}
									size={16}
									color={check.verified ? colors.success : colors.muted}
								/>
								<Text
									style={[
										styles.statusLabel,
										{
											color: check.verified ? colors.success : colors.muted,
											fontSize: typeScale.caption.fontSize,
											lineHeight: typeScale.caption.lineHeight,
										},
									]}>
									{t(check.verified ? 'validationDetails.verified' : 'validationDetails.pending')}
								</Text>
							</View>
						</View>
					</View>
				))}
			</View>

			<View style={styles.footer}>
				<Text
					style={[
						styles.fingerprintLabel,
						{color: colors.textSecondary, fontSize: typeScale.caption.fontSize, lineHeight: typeScale.caption.lineHeight},
					]}>
					{t('validationDetails.fingerprintLabel')}
				</Text>
				<Text
					style={[
						styles.fingerprintValue,
						{
							color: colors.text,
							fontFamily: fonts.medium.fontFamily,
							fontWeight: fonts.medium.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						},
					]}>
					{election.fingerprint}
				</Text>
				<Text
					style={[
						styles.recordedLine,
						{color: colors.textSecondary, fontSize: typeScale.caption.fontSize, lineHeight: typeScale.caption.lineHeight},
					]}>
					{t('validationDetails.recordedInBlockchain')}
				</Text>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	overallCount: {
		marginBottom: 24, // lg spacing token (40-UI-SPEC.md Spacing Scale)
	},
	rowList: {
		gap: 0,
	},
	row: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'flex-start',
	},
	rowLeft: {
		flex: 1,
		marginRight: 12,
	},
	rowName: {},
	rowResult: {
		marginTop: 4, // xs spacing token
	},
	rowRight: {
		alignItems: 'flex-end',
	},
	rowTime: {},
	statusFlag: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 4,
		marginTop: 4, // xs spacing token
	},
	statusLabel: {},
	footer: {
		marginTop: 24, // lg spacing token
	},
	fingerprintLabel: {},
	fingerprintValue: {
		marginTop: 4,
	},
	recordedLine: {
		marginTop: 8,
		textAlign: 'center',
	},
});
