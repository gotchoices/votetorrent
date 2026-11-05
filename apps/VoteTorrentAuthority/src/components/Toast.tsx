import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Platform, StyleSheet, Text, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** How long a toast stays fully visible before it fades out. */
export const TOAST_VISIBLE_MS = 2500;
const FADE_MS = 150;

/** `testID` (default `toast-message`) lands on the message text so device proofs can find a toast. */
type ShowToast = (message: string, options?: { testID?: string }) => void;

// Without a provider (isolated screen tests) `showToast` is a no-op; App.tsx mounts the provider.
const ToastContext = createContext<ShowToast>(() => undefined);

/** Returns `showToast(message)`, which flashes a short message at the bottom centre of the app. */
export function useToast(): ShowToast {
	return useContext(ToastContext);
}

/**
 * ToastProvider — one app-wide toast, rendered bottom-centre above every non-modal screen. Mount it
 * inside NavigationContainer (it reads the theme). A new toast replaces the current one and restarts
 * its timer. The toast never takes touches, so it cannot block the button it sits over.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const [toast, setToast] = useState<{ id: number; message: string; testID?: string } | null>(null);
	const opacity = useRef(new Animated.Value(0)).current;
	const nextId = useRef(0);

	const showToast = useCallback<ShowToast>((message, options) => {
		nextId.current += 1;
		setToast({ id: nextId.current, message, testID: options?.testID });
	}, []);

	useEffect(() => {
		if (!toast) return;
		if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(toast.message);
		opacity.setValue(0);
		Animated.timing(opacity, { toValue: 1, duration: FADE_MS, useNativeDriver: true }).start();
		const fade = setTimeout(() => {
			Animated.timing(opacity, { toValue: 0, duration: FADE_MS, useNativeDriver: true }).start();
		}, TOAST_VISIBLE_MS);
		const clear = setTimeout(() => {
			setToast((current) => (current?.id === toast.id ? null : current));
		}, TOAST_VISIBLE_MS + FADE_MS);
		return () => {
			clearTimeout(fade);
			clearTimeout(clear);
		};
	}, [toast, opacity]);

	return (
		<ToastContext.Provider value={showToast}>
			<View style={styles.root}>
				{children}
				{toast ? (
					<View style={[styles.host, { paddingBottom: insets.bottom + 64 }]}>
						<Animated.View
							testID="toast"
							accessibilityLiveRegion="polite"
							style={[styles.toast, { backgroundColor: colors.text, opacity }]}
						>
							<Text testID={toast.testID ?? "toast-message"} style={[styles.message, { color: colors.background }]}>
								{toast.message}
							</Text>
						</Animated.View>
					</View>
				) : null}
			</View>
		</ToastContext.Provider>
	);
}

const styles = StyleSheet.create({
	root: {
		flex: 1,
	},
	host: {
		position: "absolute",
		top: 0,
		right: 0,
		bottom: 0,
		left: 0,
		justifyContent: "flex-end",
		alignItems: "center",
		paddingHorizontal: 24,
		pointerEvents: "none",
	},
	toast: {
		maxWidth: 360,
		paddingHorizontal: 20,
		paddingVertical: 12,
		borderRadius: 22,
		elevation: 4,
		shadowColor: "#000",
		shadowOpacity: 0.2,
		shadowRadius: 6,
		shadowOffset: { width: 0, height: 2 },
	},
	message: {
		fontSize: 15,
		lineHeight: 20,
		textAlign: "center",
	},
});

export default ToastProvider;
