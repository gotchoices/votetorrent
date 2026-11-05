/**
 * ElectionTimelineList.test.tsx — Phase 59 plan 59-01.
 *
 * Pins EVENT_ORDER completeness AND order (a presence assertion is not an
 * order assertion) with a ten-key timeline, and proves the pre-D-08
 * seven-key tolerance — the `if (!ts) return null` skip renders exactly
 * seven rows and throws nothing for a legacy signed row.
 *
 * The EN/ES i18n-key resolution check lives in the sibling file
 * ElectionTimelineList.i18n.test.tsx, split out for the same reason
 * ElectionDetailsScreen.navigation.test.tsx documents at its header:
 * jest.mock() is file-scoped, and this file's identity-t mock of
 * react-i18next would crash i18next.use(undefined) if the real
 * src/i18n/index.ts module (which calls i18n.use(initReactI18next)) were
 * imported into the same file.
 */
import React from "react";
import renderer, { act } from "react-test-renderer";
import { ElectionEvent } from "@votetorrent/vote-core";
import { ElectionTimelineList } from "../components/ElectionTimelineList";

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "sentinel-primary",
			background: "sentinel-background",
			card: "sentinel-card",
			text: "sentinel-text",
			border: "sentinel-border",
			notification: "sentinel-notification",
			error: "sentinel-error",
			textSecondary: "sentinel-textSecondary",
			important: "sentinel-important",
			success: "sentinel-success",
			accent: "sentinel-accent",
			warning: "sentinel-warning",
		},
	}),
}));

const TEN_KEY_ORDER: ElectionEvent[] = [
	ElectionEvent.registrationEnds,
	ElectionEvent.ballotsFinal,
	ElectionEvent.votingStarts,
	ElectionEvent.accruingVotes,
	ElectionEvent.hashingVotes,
	ElectionEvent.releasingKeys,
	ElectionEvent.tallyingStarts,
	ElectionEvent.validation,
	ElectionEvent.certificationStarts,
	ElectionEvent.closed,
];

function makeTenKeyTimeline(): Record<ElectionEvent, number> {
	const now = Date.now();
	const timeline = {} as Record<ElectionEvent, number>;
	TEN_KEY_ORDER.forEach((event, i) => {
		timeline[event] = now + i * 86_400_000;
	});
	return timeline;
}

/** Each row renders exactly two Text nodes (label, then date) — this
 * extracts the label text of every row in document order. */
function extractRowLabels(root: renderer.ReactTestInstance): string[] {
	const textNodes = root.findAllByType("Text" as any);
	const labels: string[] = [];
	for (let i = 0; i < textNodes.length; i += 2) {
		labels.push(textNodes[i].children.join(""));
	}
	return labels;
}

describe("ElectionTimelineList", () => {
	it("renders all ten rows, in D-09 order, for a full ten-key timeline", () => {
		const timeline = makeTenKeyTimeline();
		let tree: renderer.ReactTestRenderer;
		act(() => {
			tree = renderer.create(<ElectionTimelineList timeline={timeline} />);
		});
		const labels = extractRowLabels(tree!.root);
		expect(labels.length).toBe(10);

		// The identity t() mock means the rendered label text equals the raw
		// ElectionEvent member name — asserting label text therefore asserts
		// BOTH completeness and order of EVENT_ORDER.
		const expectedLabels = TEN_KEY_ORDER.map((event) => `${event}: `);
		expect(labels).toEqual(expectedLabels);
	});

	it("renders exactly seven rows and throws nothing for a pre-D-08 seven-key timeline", () => {
		const full = makeTenKeyTimeline();
		const seven = { ...full } as Partial<Record<ElectionEvent, number>>;
		delete seven[ElectionEvent.accruingVotes];
		delete seven[ElectionEvent.hashingVotes];
		delete seven[ElectionEvent.releasingKeys];

		let tree: renderer.ReactTestRenderer;
		expect(() => {
			act(() => {
				tree = renderer.create(
					<ElectionTimelineList
						timeline={seven as unknown as Record<ElectionEvent, number>}
					/>
				);
			});
		}).not.toThrow();

		const labels = extractRowLabels(tree!.root);
		expect(labels.length).toBe(7);
	});
});
