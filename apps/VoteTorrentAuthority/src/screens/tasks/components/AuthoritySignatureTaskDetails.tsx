import { useTranslation } from "react-i18next";
import type { AuthoritySignatureTask } from "@votetorrent/vote-core";
import { SignatureTaskBody } from "./SignatureTaskBody";

export function AuthoritySignatureTaskDetails({ task }: { task: AuthoritySignatureTask }) {
	const { t } = useTranslation();
	return (
		<SignatureTaskBody
			sections={[
				{
					title: t("proposal"),
					rows: [
						{ label: t("network"), value: task.network.name },
						{ label: t("authority"), value: task.authority.proposed.name },
						{ label: t("domain"), value: task.authority.proposed.domainName },
					],
				},
			]}
		/>
	);
}
