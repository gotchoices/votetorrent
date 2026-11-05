import { StyleSheet, TouchableOpacity, View, type HostInstance } from "react-native";
import { ThemedText } from "./ThemedText";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";

interface FullButtonProps {
	title: string;
	icon?: string;
	/** Optional trailing glyph pinned to the right edge (e.g. SELECT's network symbol). */
	rightIcon?: string;
	disabled?: boolean;
	backgroundColor?: string;
	forceDarkText?: boolean;
	size?: "tall" | "thin";
	flex?: boolean;
	testID?: string;
	/** Host ref (React 19 passes `ref` as a prop); lets a caller return accessibility focus to the button. */
	ref?: React.Ref<HostInstance>;
	onPress: () => void;
}

export function CustomButton({
	title,
	icon,
	rightIcon,
	disabled = false,
	backgroundColor,
	forceDarkText,
	size = "tall",
	flex = false,
	testID,
	ref,
	onPress,
}: FullButtonProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const buttonColor = backgroundColor ?? colors.accent;
	let textColor = forceDarkText ? colors.dark : colors.text;
	if (backgroundColor && (backgroundColor === colors.success || backgroundColor === colors.error || backgroundColor === colors.primary)) {
		textColor = colors.light;
	}

	return (
		<TouchableOpacity
			ref={ref}
			style={[
				styles.button,
				{ backgroundColor: buttonColor },
				disabled && styles.disabled,
				size === "thin" ? styles.thin : styles.tall,
				flex && styles.flex,
			]}
			onPress={onPress}
			disabled={disabled}
			testID={testID}
			// Explicit label: otherwise Android concatenates the icon glyph's empty text
			// with the title and screen readers announce ", TITLE".
			accessibilityRole="button"
			accessibilityLabel={title}
			accessibilityState={{ disabled }}
			// The thin box is 6*2 + minHeight 24 = 36pt, below the 44pt floor.
			// Raising paddingVertical would reflow every thin call site
			// (LifecycleConfirmCard's width-constrained slots, both
			// authorities add-forms), so vertical-only hitSlop lifts the
			// effective touch height without a layout change. marginVertical:
			// 8 puts adjacent buttons 16pt apart, so 6pt of vertical slop
			// cannot create overlapping touch regions. Tall is already 56pt
			// and needs none. Left/right stay 0.
			hitSlop={size === "thin" ? { top: 6, bottom: 6, left: 0, right: 0 } : undefined}
		>
			<View style={styles.buttonContent}>
				{icon && <FontAwesome6 name={icon} size={20} color={textColor} />}
				<ThemedText style={[styles.text, { color: textColor }]}>{title.toUpperCase()}</ThemedText>
			</View>
			{rightIcon && (
				<View style={styles.rightIconWrap} pointerEvents="none">
					<FontAwesome6 name={rightIcon} size={20} color={textColor} />
				</View>
			)}
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	button: {
		// 28 is the tall box's true clamped radius (RN clamps borderRadius to
		// half the smaller box dimension: paddingVertical 16*2 + buttonContent
		// minHeight 24 = 56, halved = 28) — the previous 32 was already
		// fictional, so re-declaring the true value is a visual no-op.
		// paddingHorizontal 32 clears it with the same 4pt of breathing room
		// 260805-hfi used on ChipButton.
		borderRadius: 28,
		paddingHorizontal: 32,
		marginVertical: 8,
		marginHorizontal: 4,
		alignItems: "center",
		justifyContent: "center",
	},
	buttonContent: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 12,
		minHeight: 24,
	},
	disabled: {
		opacity: 0.5,
	},
	flex: {
		flex: 1,
		alignSelf: "stretch",
	},
	text: {
		fontSize: 16,
		fontWeight: "600",
		textAlign: "center",
		flexShrink: 1,
	},
	rightIconWrap: {
		position: "absolute",
		right: 16,
		top: 0,
		bottom: 0,
		justifyContent: "center",
	},
	tall: {
		paddingVertical: 16,
	},
	thin: {
		paddingVertical: 6,
		// The thin box is 6*2 + minHeight 24 = 36, so its radius already
		// clamped to 18 — another visual no-op. paddingHorizontal 22 reclaims
		// 10pt per side versus the base value, which matters because
		// size="thin" is what the width-constrained LifecycleConfirmCard
		// slots and both authorities add-forms use. This array entry sits
		// after styles.button, so both keys override cleanly.
		borderRadius: 18,
		paddingHorizontal: 22,
	},
});
