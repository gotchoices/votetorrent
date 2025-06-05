import React from 'react';
import {useTranslation} from 'react-i18next';
import {Image, ScrollView, StyleSheet, View} from 'react-native';
import {ThemedText} from '../../components/ThemedText';
import type {Administrator} from '@votetorrent/vote-core';
import {useRoute} from '@react-navigation/native';
import {scopeDescriptions} from '@votetorrent/vote-core';
import {globalStyles} from '../../theme/styles';

export default function AdministratorDetailsScreen() {
	const {t} = useTranslation();
	const {administrator} = useRoute().params as {administrator: Administrator};

	if (!administrator) {
		return null;
	}

	const administratorDetails = [
		{label: t('name'), value: administrator.name},
		{label: t('title'), value: administrator.title},
		{label: t('sid'), value: administrator.sid},
		{label: t('key'), value: administrator.key},
		{label: t('signatures'), value: administrator.signatures.join(', ')}
	];

	return (
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				<View style={styles.imageContainer}>
					{administrator.imageRef && (
						<Image source={{uri: administrator.imageRef.url}} style={styles.administratorImage} />
					)}
				</View>
				{administratorDetails.map(field => (
					<View key={field.label} style={styles.field}>
						<ThemedText type="defaultSemiBold">{field.label}: </ThemedText>
						<ThemedText>{field.value}</ThemedText>
					</View>
				))}
				<View style={styles.scopesSection}>
					<ThemedText type="defaultSemiBold" style={styles.scopesTitle}>
						{t('scopes')}:
					</ThemedText>
					{administrator.scopes.map(scope => (
						<View key={scope} style={styles.scopeItem}>
							<ThemedText style={styles.bullet}>•</ThemedText>
							<ThemedText style={styles.scopeDescription}>{scopeDescriptions[scope]}</ThemedText>
						</View>
					))}
				</View>
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	imageContainer: {
		position: 'relative',
		width: 200,
		height: 200,
		alignSelf: 'center',
		marginVertical: 16
	},
	administratorImage: {
		width: '100%',
		height: '100%',
		borderRadius: 8
	},
	field: {
		flexDirection: 'row'
	},
	scopesSection: {
		marginTop: 16
	},
	scopesTitle: {
		marginBottom: 8
	},
	scopeItem: {
		flexDirection: 'row',
		marginBottom: 4
	},
	bullet: {
		marginRight: 8
	},
	scopeDescription: {
		flex: 1
	}
});

const styles = {...globalStyles, ...localStyles};
