/*
This file contains the global styles for the app.
Global styles should only be used in cases where styles will be used on many screens.
*/

import {StyleSheet} from 'react-native';

export const globalStyles = StyleSheet.create({
	// Content is the outermost View, only needed if there is something that needs to avoid the container padding
	content: {
		flex: 1
	},
	// Container should be added to the outermost View on most screens
	container: {
		padding: 16
	},
	// Sections are groups of related fields, usually headed by a title
	section: {
		marginBottom: 28
	},
	sectionTitle: {
		marginBottom: 16
	},
	footer: {
		paddingVertical: 16,
		paddingHorizontal: 16,
		elevation: 12, // Android only
		// shadow properties only apply on ios
		shadowOffset: {
			width: 0,
			height: -1
		},
		shadowOpacity: 0.1,
		shadowRadius: 1
	}
});
