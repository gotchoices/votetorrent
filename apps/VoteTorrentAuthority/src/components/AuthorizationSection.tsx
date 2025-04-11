import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {ExtendedTheme, useTheme} from '@react-navigation/native';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {ThemedText} from './ThemedText';
import {FullButton} from './FullButton';
import type {Administration} from '@votetorrent/vote-core';
import {globalStyles} from '../theme/styles';

interface AuthorizationSectionProps {
	administration: Administration | null;
	signedAdministratorSids?: string[];
}

export function AuthorizationSection({administration}: AuthorizationSectionProps) {
	const {t} = useTranslation();
	const {colors} = useTheme() as ExtendedTheme;

	return (
		<View style={styles.section}>
			<ThemedText type="title">{t('authorization')}</ThemedText>
			<FullButton
				title={t('adjustProposal')}
				icon="pen"
				backgroundColor={colors.accent}
				size="thin"
				onPress={() => {}}
			/>
			<View style={styles.authorizationBlock}>
				<View style={styles.adminChecks}>
					{administration?.administrators.map(admin => (
						<View key={admin.sid} style={styles.adminCheck}>
							<FontAwesome6 name="circle-check" size={24} color={colors.text} />
							<ThemedText style={styles.adminCheckText}>{admin.name}</ThemedText>
						</View>
					))}
				</View>
				<View style={styles.signButtons}>
					<FullButton
						title={t('sign')}
						icon="signature"
						backgroundColor={colors.important}
						forceDarkText={true}
						size="thin"
						onPress={() => {}}
					/>
					<FullButton
						title={t('share')}
						icon="share-nodes"
						backgroundColor={colors.important}
						forceDarkText={true}
						size="thin"
						onPress={() => {}}
					/>
				</View>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	authorizationBlock: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		justifyContent: 'space-between'
	},
	adminChecks: {
		justifyContent: 'space-between'
	},
	adminCheck: {
		flexDirection: 'row',
		width: '100%',
		paddingRight: 8,
		marginTop: 16
	},
	adminCheckText: {
		marginLeft: 32
	},
	signButtons: {
		gap: 4
	}
});
const styles = {...globalStyles, ...localStyles};
