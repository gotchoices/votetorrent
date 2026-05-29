import { useTranslation } from "react-i18next";
import type { AdminSignatureTask } from "@votetorrent/vote-core";
import { SignatureTaskBody } from "./SignatureTaskBody";

export function AdminSignatureTaskDetails({ task }: { task: AdminSignatureTask }) {
	const { t } = useTranslation();
	return (
		<SignatureTaskBody
			sections={[
				{
					title: t("proposal"),
					rows: [
						{ label: t("type"), value: task.type },
						{ label: t("network"), value: task.network.name },
						{ label: t("authority"), value: task.authority.name },
						{
							label: t("admin"),
							value: String(task.administration.proposed.officers.length),
						},
					],
				},
			]}
		/>
	);
}
