import { useTranslation } from "react-i18next";
import type { BallotSignatureTask } from "@votetorrent/vote-core";
import { SignatureTaskBody } from "./SignatureTaskBody";

export function BallotSignatureTaskDetails({ task }: { task: BallotSignatureTask }) {
	const { t } = useTranslation();
	return (
		<SignatureTaskBody
			sections={[
				{
					title: t("proposal"),
					rows: [
						{ label: t("network"), value: task.network.name },
						{ label: t("description"), value: task.ballot.proposed.description },
					],
				},
			]}
		/>
	);
}
