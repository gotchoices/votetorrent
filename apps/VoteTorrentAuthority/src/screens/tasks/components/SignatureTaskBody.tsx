import React from "react";
import { View, StyleSheet } from "react-native";
import { globalStyles } from "../../../theme/styles";
import { ThemedText } from "../../../components/ThemedText";

export interface SignatureTaskRow {
	label: string;
	value?: string;
	slot?: React.ReactNode;
}

export interface SignatureTaskSection {
	title?: string;
	rows: SignatureTaskRow[];
}

export interface SignatureTaskBodyProps {
	sections: SignatureTaskSection[];
}

export function SignatureTaskBody({ sections }: SignatureTaskBodyProps) {
	return (
		<View>
			{sections.map((section, sectionIndex) => (
				<View key={sectionIndex} style={styles.section}>
					{section.title && (
						<ThemedText type="defaultSemiBold" style={styles.sectionTitleSpacing}>
							{section.title}
						</ThemedText>
					)}
					<View style={[styles.section, styles.detailContainer]}>
						{section.rows.map((row, rowIndex) => (
							<View key={rowIndex} style={styles.detail}>
								<ThemedText type="defaultSemiBold">{row.label}: </ThemedText>
								{row.slot !== undefined ? row.slot : <ThemedText>{row.value}</ThemedText>}
							</View>
						))}
					</View>
				</View>
			))}
		</View>
	);
}

const localStyles = StyleSheet.create({
	detailContainer: {
		width: "100%",
	},
	detail: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 4,
	},
	sectionTitleSpacing: {
		marginBottom: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
