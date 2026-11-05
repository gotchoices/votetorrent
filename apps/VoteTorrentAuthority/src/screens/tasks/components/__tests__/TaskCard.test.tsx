/**
 * TaskCard date guard (UAT 62 gap 4 item 3): a ballot task, built the way the engine
 * builds it ({ proposed, signers: [] }, no timestamp), never renders "Invalid Date".
 */
import React from "react";
import renderer from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: { card: "c", text: "t", notification: "n", accent: "a", error: "e", textSecondary: "s" },
	}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TaskCard } = require("../TaskCard");

const network = { name: "Net", imageUrl: undefined };

function render(task: unknown) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<TaskCard task={task as never} showIndicator={false} />);
	});
	return JSON.stringify(tr.toJSON());
}

const ballotTask = (extra: object = {}) => ({
	type: "signature",
	signatureType: "ballot",
	network,
	ballot: { proposed: { id: "b1", description: "Main ballot" }, signers: [], ...extra },
});

describe("TaskCard dates", () => {
	it("T3: an engine-shaped ballot task shows its description and no Invalid Date", () => {
		const out = render(ballotTask());
		expect(out).toContain("Main ballot");
		expect(out).not.toMatch(/Invalid Date/);
	});

	it("T4: a ballot task with a finite timestamp renders that date", () => {
		const ts = Date.UTC(2026, 5, 15, 12);
		const out = render(ballotTask({ timestamp: ts }));
		expect(out).toContain(new Date(ts).toLocaleDateString());
	});

	it("T5: an election task with a NaN date renders no date text", () => {
		const out = render({
			type: "signature",
			signatureType: "election",
			network,
			election: { proposed: { election: { title: "E1", date: Number.NaN } } },
		});
		expect(out).toContain("E1");
		expect(out).not.toMatch(/Invalid Date/);
	});
});
