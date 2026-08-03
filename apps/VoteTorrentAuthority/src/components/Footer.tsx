import React, { ReactNode } from "react";
import { View, StyleSheet, StyleProp, ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { globalStyles } from "../theme/styles";

export interface FooterProps {
	children: ReactNode;
	/** Lay children out in a horizontal button row (two-button footers). */
	row?: boolean;
	/** Extra style overrides merged after the base footer chrome. */
	style?: StyleProp<ViewStyle>;
}

/**
 * Pinned bottom footer chrome. Always clears the Android gesture nav bar /
 * iOS home indicator by padding for the bottom safe-area inset, so footer
 * buttons never overflow into the system nav area.
 *
 * Single source of truth — use this instead of `<View style={styles.footer}>`
 * so the safe-area handling can't drift per-screen (see v1.1 milestone audit:
 * footer overflow was a recurring app-wide regression before this existed).
 */
export function Footer({ children, row, style }: FooterProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	return (
		<View
			style={[
				globalStyles.footer,
				row && globalStyles.footerButtonsContainer,
				{ backgroundColor: colors.card, paddingBottom: insets.bottom + 16 },
				style,
			]}
		>
			{children}
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
