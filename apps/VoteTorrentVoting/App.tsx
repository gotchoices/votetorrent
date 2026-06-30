/**
 * VoteTorrent Voting app — entry component.
 *
 * @format
 */

import React from 'react';
import {SafeAreaView, StyleSheet, Text, useColorScheme, View} from 'react-native';

function App(): React.JSX.Element {
	const isDarkMode = useColorScheme() === 'dark';

	return (
		<SafeAreaView style={[styles.container, isDarkMode ? styles.dark : styles.light]}>
			<View style={styles.content}>
				<Text style={[styles.title, isDarkMode ? styles.textDark : styles.textLight]}>
					Hello, VoteTorrent Voting!
				</Text>
				<Text style={[styles.subtitle, isDarkMode ? styles.textDark : styles.textLight]}>
					The voting app is up and running.
				</Text>
			</View>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	light: {
		backgroundColor: '#ffffff',
	},
	dark: {
		backgroundColor: '#000000',
	},
	content: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		padding: 24,
	},
	title: {
		fontSize: 24,
		fontWeight: '700',
		textAlign: 'center',
	},
	subtitle: {
		marginTop: 12,
		fontSize: 16,
		textAlign: 'center',
	},
	textLight: {
		color: '#111111',
	},
	textDark: {
		color: '#f5f5f5',
	},
});

export default App;
