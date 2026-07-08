/*
This file contains the global styles for the app.
Global styles should only be used in cases where styles will be used on many screens.
*/

import { StyleSheet } from 'react-native';

// Raw style-object map (the literal passed to StyleSheet.create) exported so tests
// can deep-equal footer/cardSurface values without resolving RN StyleSheet numeric IDs.
export const globalStyleDefs = {
	// Content is the outermost View, only needed if there is something that needs to avoid the container padding
	content: {
		flex: 1,
	},
	// Container should be added to the outermost View on most screens
	container: {
		padding: 16,
	},
	// Sections are groups of related fields, usually headed by a title
	section: {
		marginBottom: 20,
	},
	sectionTitle: {
		marginBottom: 16,
	},
	footer: {
		paddingVertical: 16,
		paddingHorizontal: 16,
		elevation: 12, // Android only
		// shadow properties only apply on ios
		shadowOffset: {
			width: 0,
			height: -1,
		},
		shadowOpacity: 0.1,
		shadowRadius: 1,
	},
	// Used when there are two buttons in the footer
	footerButtonsContainer: {
		flexDirection: 'row' as const,
		gap: 16,
		paddingHorizontal: 20,
	},
	// Shared visual shell for all "card" surfaces (InfoCard, ElectionCard,
	// KeyholderCard, TaskCard). Per-component backgroundColor is applied
	// dynamically from theme.colors.card. Shadow is intentionally soft and
	// wide so it diffuses around the rounded corners on both platforms
	// instead of reading as a hard strip below the card.
	cardSurface: {
		borderRadius: 16,
		paddingVertical: 16,
		paddingHorizontal: 16,
		marginVertical: 10,
		marginHorizontal: 4,
		shadowColor: '#000',
		shadowOffset: {
			width: 0,
			height: 6,
		},
		shadowOpacity: 0.18,
		shadowRadius: 18,
		elevation: 8,
	},
};

export const globalStyles = StyleSheet.create(globalStyleDefs);
