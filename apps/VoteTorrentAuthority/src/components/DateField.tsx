import React, { useState } from "react";
import { Platform, StyleSheet, TouchableOpacity, View } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "./ThemedText";
import { globalStyles } from "../theme/styles";

interface DateFieldProps {
	/** Optional bold label rendered above the field. */
	title?: string;
	/** ISO 8601 string, or "" when unset. */
	value: string;
	/** Receives an ISO string on pick, or "" when cleared. */
	onChange: (iso: string) => void;
	/** Empty-state text (defaults to t("selectDate")). */
	placeholder?: string;
}

function formatDateTime(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) return "";
	return d.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/**
 * DateField — calendar-pill date/time input backed by the native OS picker
 * (@react-native-community/datetimepicker). Tapping opens a date picker, then a
 * time picker (two-step on Android), and stores the combined value as an ISO
 * string. There is NO free-text entry, so a non-date value cannot be entered.
 * A clear (✕) resets the value, matching the Figma date rows.
 */
export function DateField({ title, value, onChange, placeholder }: DateFieldProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const [mode, setMode] = useState<"date" | "time" | null>(null);
	const [draft, setDraft] = useState<Date | null>(null);

	const hasValue = !!value && !isNaN(new Date(value).getTime());
	const current = hasValue ? new Date(value) : new Date();
	const display = hasValue ? formatDateTime(value) : placeholder ?? t("selectDate");

	const open = () => {
		setDraft(current);
		setMode("date");
	};

	const onPickerChange = (event: { type: string }, picked?: Date) => {
		if (event.type === "dismissed" || !picked) {
			setMode(null);
			return;
		}
		const base = draft ?? current;
		if (mode === "date") {
			const merged = new Date(picked);
			merged.setHours(base.getHours(), base.getMinutes(), 0, 0);
			setDraft(merged);
			setMode("time");
		} else {
			const merged = new Date(base);
			merged.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
			onChange(merged.toISOString());
			setMode(null);
		}
	};

	return (
		<View style={styles.wrap}>
			{title ? (
				<ThemedText type="defaultSemiBold" style={styles.label}>
					{title}
				</ThemedText>
			) : null}
			<View style={styles.row}>
				<TouchableOpacity
					onPress={open}
					style={[styles.pill, { backgroundColor: colors.card, borderColor: colors.border }]}
				>
					<FontAwesome6 name="calendar" size={16} color={colors.text} />
					<ThemedText
						style={[styles.text, { color: hasValue ? colors.text : colors.textSecondary }]}
						numberOfLines={1}
					>
						{display}
					</ThemedText>
				</TouchableOpacity>
				{hasValue ? (
					<TouchableOpacity onPress={() => onChange("")} style={styles.clear}>
						<FontAwesome6 name="xmark" size={16} color={colors.text} />
					</TouchableOpacity>
				) : null}
			</View>
			{mode ? (
				<DateTimePicker
					value={draft ?? current}
					mode={mode}
					display={Platform.OS === "ios" ? "inline" : "default"}
					onChange={onPickerChange}
				/>
			) : null}
		</View>
	);
}

const localStyles = StyleSheet.create({
	wrap: {
		marginTop: 8,
	},
	label: {
		marginBottom: 4,
	},
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	pill: {
		flex: 1,
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 14,
		paddingVertical: 12,
		borderRadius: 28,
		borderWidth: 1,
	},
	text: {
		flex: 1,
		fontSize: 14,
	},
	clear: {
		padding: 6,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default DateField;
