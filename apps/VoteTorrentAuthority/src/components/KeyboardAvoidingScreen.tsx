import React, { ReactNode } from "react";
import { StyleProp, View, ViewStyle } from "react-native";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import { globalStyles } from "../theme/styles";

export interface KeyboardAvoidingScreenProps {
	children: ReactNode;
	/** Extra style overrides merged after the base `content` chrome. */
	style?: StyleProp<ViewStyle>;
	/** Optional testID forwarded to the shell View (screens keep their existing shell testID). */
	testID?: string;
}

/**
 * Drop-in replacement for the `<View style={styles.content}>` shell that every
 * form screen uses as its outermost element. Identical layout when no keyboard
 * is showing; while one is up it pads the bottom by the keyboard's height, so
 * the flex children above it (the ScrollView and the pinned {@link Footer})
 * shrink to the space that is actually visible.
 *
 * That padding is what restores scrolling: the ScrollView's viewport ends at
 * the top of the keyboard instead of behind it, so its maximum scroll offset
 * grows by the keyboard's height and the fields underneath can be reached. It
 * also lifts the footer's Save/Create button into view instead of leaving it
 * stranded behind the IME.
 *
 * Single source of truth on purpose — same reasoning as `Footer`. The padding
 * has to be applied by the app because `adjustResize` no longer resizes the
 * window under Android's forced edge-to-edge; see {@link useKeyboardInset}.
 */
export function KeyboardAvoidingScreen({ children, style, testID }: KeyboardAvoidingScreenProps) {
	const keyboardInset = useKeyboardInset();
	return (
		<View testID={testID} style={[globalStyles.content, { paddingBottom: keyboardInset }, style]}>
			{children}
		</View>
	);
}
