import { ExtendedTheme, useTheme, useNavigation, useRoute } from "@react-navigation/native";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { globalStyles } from "../../theme/styles";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../../navigation/types";

// Phase 9 plan 09-03 (ELECUI-04) — Edit Election polish.
// Scaffold per PATTERNS.md §7 mirroring EditBallotScreen shape.
// PROPOSE stub matches Phase 8 D-04/D-15 convention (D-03 also).
// taskId? route param is consumed for type-safe nav; not exercised
// (Phase 9 is UI parity only per CONTEXT D-18). Spanish strings
// deferred to Phase 11 per D-17.
export default function EditElectionScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const route = useRoute<RouteProp<RootStackParamList, "EditElection">>();

	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [tags, setTags] = useState("");
	const [votingOpens, setVotingOpens] = useState("");
	const [votingCloses, setVotingCloses] = useState("");
	const [revisionDeadline, setRevisionDeadline] = useState("");

	const handlePropose = () => {
		// v1.1 milestone scope: functional persistence is OOS (CONTEXT D-18).
		// Stub the propose action and navigate back — real engine wiring
		// lands when IElectionEngine.proposeElection() is added later.
		console.log("editElection-propose stub", {
			title,
			description,
			tags,
			votingOpens,
			votingCloses,
			revisionDeadline,
			taskId: route.params?.taskId,
		});
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				<View style={styles.section}>
					<ThemedText>{t("title")}</ThemedText>
					<CustomTextInput value={title} onChangeText={setTitle} />
				</View>
				<View style={styles.section}>
					<ThemedText>{t("description")}</ThemedText>
					<CustomTextInput value={description} onChangeText={setDescription} />
				</View>
				<View style={styles.section}>
					<ThemedText>{t("tags")}</ThemedText>
					<CustomTextInput value={tags} onChangeText={setTags} />
				</View>
				<View style={styles.section}>
					<ThemedText>{t("votingOpens")}</ThemedText>
					<CustomTextInput value={votingOpens} onChangeText={setVotingOpens} />
				</View>
				<View style={styles.section}>
					<ThemedText>{t("votingCloses")}</ThemedText>
					<CustomTextInput value={votingCloses} onChangeText={setVotingCloses} />
				</View>
				<View style={styles.section}>
					<ThemedText>{t("revisionDeadline")}</ThemedText>
					<CustomTextInput value={revisionDeadline} onChangeText={setRevisionDeadline} />
				</View>
			</ScrollView>
			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("propose")}
					icon="floppy-disk"
					onPress={handlePropose}
					backgroundColor={colors.success}
					forceDarkText={true}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	section: {
		marginBottom: 20,
	},
});

const styles = { ...globalStyles, ...localStyles };
