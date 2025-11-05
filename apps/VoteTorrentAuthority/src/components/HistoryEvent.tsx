import React from "react";
import { UserHistory, UserHistoryEvent, UserKeyType } from "@votetorrent/vote-core";
import { StyleSheet, View } from "react-native";
import { globalStyles } from "../theme/styles";
import { ThemedText } from "./ThemedText";
import { useTranslation } from "react-i18next";
import { formatDate, getKeyTypeDisplayName } from "../utils/displayUtils";
import { useTheme } from "@react-navigation/native";
import { ExtendedTheme } from "@react-navigation/native";

interface HistoryEventProps {
	userHistory?: UserHistory;
}

const keyTranslations: { [key: string]: string } = {
	url: "Image Url",
	expiration: "Expires",
	id: "ID",
	cid: "CID",
};

const getDisplayKeyName = (key: string): string => {
	return keyTranslations[key] || key;
};

// Desired order of properties to display
const propertyDisplayOrder = ["key", "type", "name", "url", "cid", "expiration", "signature"];

// Recursive function to extract key-value pairs into a flat list
const extractProperties = (data: any, displayItems: { key: string; value: any }[]) => {
	if (typeof data !== "object" || data === null) {
		return;
	}

	Object.entries(data).forEach(([key, value]) => {
		if (typeof value === "object" && value !== null) {
			// Recurse into nested objects
			extractProperties(value, displayItems);
		} else {
			// Add primitive/null value to the list
			displayItems.push({ key, value });
		}
	});
};

// Custom sort function based on propertyDisplayOrder
const sortProperties = (a: { key: string; value: any }, b: { key: string; value: any }): number => {
	const indexA = propertyDisplayOrder.indexOf(a.key);
	const indexB = propertyDisplayOrder.indexOf(b.key);
	// If keys are not in the order list, they should effectively have infinite index
	const effectiveIndexA = indexA === -1 ? Infinity : indexA;
	const effectiveIndexB = indexB === -1 ? Infinity : indexB;
	return effectiveIndexA - effectiveIndexB;
};

const getEventTypeDisplayName = (eventType?: UserHistoryEvent): string => {
	if (eventType === UserHistoryEvent.create) {
		return "create";
	} else if (eventType === UserHistoryEvent.revise) {
		return "revise";
	} else if (eventType === UserHistoryEvent.addKey) {
		return "addKey";
	} else if (eventType === UserHistoryEvent.revokeKey) {
		return "revokeKey";
	}
	return String(eventType) || "Unknown";
};

export function HistoryEvent({ userHistory }: HistoryEventProps) {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	if (!userHistory) {
		return null;
	}

	const eventType = (userHistory as any)?.event;
	const { event, ...propertiesToExtract } = userHistory;
	const allProperties: { key: string; value: any }[] = [];

	extractProperties(propertiesToExtract, allProperties);
	const filteredProperties = allProperties.filter((prop) =>
		propertyDisplayOrder.includes(prop.key)
	);
	const sortedProperties = filteredProperties.sort(sortProperties);

	const getEventTypeColor = (eventType?: UserHistoryEvent): string => {
		if (eventType === UserHistoryEvent.create || eventType === UserHistoryEvent.addKey) {
			return colors.success;
		} else if (eventType === UserHistoryEvent.revokeKey) {
			return colors.error;
		}
		return colors.primary;
	};

	// Helper function to format values based on key
	const getDisplayValue = (key: string, value: any): string => {
		const isNull = value === null;
		if (isNull) {
			return "-";
		}

		switch (key) {
			case "expiration":
				return typeof value === "number" ? formatDate(value) : String(value);
			case "type":
				const displayName = getKeyTypeDisplayName(value as UserKeyType);
				return displayName.charAt(0).toUpperCase() + displayName.slice(1);
			case "signature":
				const signer = userHistory.signature.signerKey.slice(0, 5) + "...";
				return value + " (by " + signer + ")";
			default:
				return String(value);
		}
	};

	return (
		<View style={styles.section}>
			<ThemedText
				type="default"
				style={[styles.eventType, { color: getEventTypeColor(eventType) }]}
			>
				{t(getEventTypeDisplayName(eventType))}
			</ThemedText>

			{sortedProperties.map(({ key, value }, index) => {
				return (
					<View key={`${key}-${index}`} style={styles.propertyRow}>
						<ThemedText type="defaultSemiBold" style={styles.propertyName}>
							{getDisplayKeyName(key)}:{" "}
						</ThemedText>
						<View style={styles.propertyValue}>
							<ThemedText numberOfLines={1} ellipsizeMode="tail">
								{getDisplayValue(key, value)}
							</ThemedText>
						</View>
					</View>
				);
			})}
		</View>
	);
}

const localStyles = StyleSheet.create({
	eventType: {
		marginBottom: 8,
		textTransform: "capitalize",
	},
	propertyRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		width: "100%",
	},
	propertyName: {
		marginRight: 4,
		textTransform: "capitalize",
	},
	propertyValue: {
		flex: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default HistoryEvent;
