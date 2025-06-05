import React from 'react';
import {View, StyleSheet, TouchableOpacity} from 'react-native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useTheme} from '@react-navigation/native';
import {ThemedText} from './ThemedText';
import {useTranslation} from 'react-i18next';
import {globalStyles} from '../theme/styles';

export function NoNetwork() {
	const {colors} = useTheme();
	const {t} = useTranslation();

	return (
		<View style={styles.container}>
			<TouchableOpacity style={styles.backButton}>
				<FontAwesome6 name="arrow-up" size={24} color={colors.text} />
			</TouchableOpacity>
			<ThemedText type="default" style={styles.text}>
				{t('noNetwork')}
			</ThemedText>
		</View>
	);
}

const localStyles = StyleSheet.create({
	backButton: {
		position: 'relative',
		left: 8,
		padding: 8
	},
	text: {
		textAlign: 'center'
	}
});

const styles = {...globalStyles, ...localStyles};
