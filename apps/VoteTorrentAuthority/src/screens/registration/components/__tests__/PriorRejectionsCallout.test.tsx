/**
 * PriorRejectionsCallout.test.tsx — co-located coverage for the D-06
 * prior-rejection history callout. `react-test-renderer` only, file-scope
 * module mocks — mirrors `RegistrantRow.test.tsx`'s screen-local component
 * test shape.
 *
 * `@votetorrent/vote-core` is imported TYPE-ONLY by the component under
 * test (`PriorRejection`), unlike `VerificationChecklist`'s value imports —
 * so, unlike that suite, `yarn workspace @votetorrent/vote-core build` is
 * not strictly required for this file to resolve. It is still run in the
 * verify command for consistency with the sibling task's precondition.
 */

import React from "react";
import renderer from "react-test-renderer";
import type { PriorRejection } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

// This file's single, file-scope `t` mock echoes the interpolation params so
// assertion 5 can prove all three (`date`/`officer`/`reason`) reached the
// call — declared once; no mid-file mock swap.
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key}:${JSON.stringify(params)}` : key,
	}),
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			success: "sentinel-success",
			warning: "sentinel-warning",
			error: "sentinel-error",
			accent: "sentinel-accent",
			card: "sentinel-card",
			textSecondary: "sentinel-textSecondary",
			text: "sentinel-text",
			border: "sentinel-border",
		},
	}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PriorRejectionsCallout } = require("../PriorRejectionsCallout");

const PREFIX = "prior-rejections-callout";

function makeRejection(overrides: Partial<PriorRejection> = {}): PriorRejection {
	return {
		requestId: "req-1",
		rejectedAt: "2026-01-01T00:00:00.000Z",
		rejectionReason: "Address mismatch",
		decidingOfficerUserId: "u-1",
		...overrides,
	};
}

function renderCallout(
	props: Partial<{
		rejections: readonly PriorRejection[];
		resolveOfficerName: (id: string) => string;
	}> = {},
) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<PriorRejectionsCallout
				rejections={props.rejections ?? []}
				resolveOfficerName={props.resolveOfficerName}
			/>,
		);
	});
	return tr;
}

describe("PriorRejectionsCallout — D-06", () => {
	it("with zero rejections, renders a null tree — absence is the signal, not a false positive on a first-time applicant", () => {
		const tr = renderCallout({ rejections: [] });
		expect(tr.toJSON()).toBeNull();
		tr.unmount();
	});

	it("with one rejection, renders exactly one row instance and the container renders once", () => {
		const tr = renderCallout({ rejections: [makeRejection()] });
		expect(tr.root.findAllByProps({ testID: PREFIX }, { deep: false }).length).toBe(1);
		expect(
			tr.root.findAllByProps({ testID: `${PREFIX}-row-req-1` }, { deep: false }).length,
		).toBe(1);
		tr.unmount();
	});

	it("the container's flattened style carries borderLeftWidth 4 and borderLeftColor sentinel-warning", () => {
		const tr = renderCallout({ rejections: [makeRejection()] });
		const container = tr.root.findByProps({ testID: PREFIX });
		const flattened = Array.isArray(container.props.style)
			? Object.assign({}, ...container.props.style.flat(5))
			: container.props.style;
		expect(flattened.borderLeftWidth).toBe(4);
		expect(flattened.borderLeftColor).toBe("sentinel-warning");
		tr.unmount();
	});

	it("the heading renders priorRejectionsCalloutHeading and the glyph is circle-exclamation in sentinel-warning", () => {
		const tr = renderCallout({ rejections: [makeRejection()] });
		const heading = tr.root.findAllByProps({ testID: `${PREFIX}-heading` }, { deep: false })[0];
		expect(String(heading.props.children)).toBe("priorRejectionsCalloutHeading");
		const glyph = tr.root.findByProps({ testID: `${PREFIX}-glyph` });
		expect(glyph.props.name).toBe("circle-exclamation");
		expect(glyph.props.color).toBe("sentinel-warning");
		tr.unmount();
	});

	it("the row is rendered through t('priorRejectionsCalloutRow', {...}) with date, officer and reason all present", () => {
		const tr = renderCallout({
			rejections: [
				makeRejection({
					requestId: "req-9",
					rejectedAt: "2026-03-15T12:00:00.000Z",
					rejectionReason: "Missing signature",
					decidingOfficerUserId: "officer-7",
				}),
			],
		});
		const row = tr.root.findAllByProps({ testID: `${PREFIX}-row-req-9` }, { deep: false })[0];
		const text = String(row.props.children);
		expect(text).toContain("priorRejectionsCalloutRow");
		expect(text).toContain("2026-03-15");
		expect(text).toContain("officer-7");
		expect(text).toContain("Missing signature");
		tr.unmount();
	});

	it("given three rejections supplied oldest-first, the rendered rows appear newest-first", () => {
		const tr = renderCallout({
			rejections: [
				makeRejection({ requestId: "oldest", rejectedAt: "2026-01-01T00:00:00.000Z" }),
				makeRejection({ requestId: "middle", rejectedAt: "2026-02-01T00:00:00.000Z" }),
				makeRejection({ requestId: "newest", rejectedAt: "2026-03-01T00:00:00.000Z" }),
			],
		});
		const rows = tr.root.findAll(
			(node) => typeof node.props.testID === "string" && node.props.testID.startsWith(`${PREFIX}-row-`),
			{ deep: false },
		);
		expect(rows.map((r) => r.props.testID)).toEqual([
			`${PREFIX}-row-newest`,
			`${PREFIX}-row-middle`,
			`${PREFIX}-row-oldest`,
		]);
		tr.unmount();
	});

	it("resolveOfficerName is applied when supplied, and the raw id renders when omitted", () => {
		const trResolved = renderCallout({
			rejections: [makeRejection({ decidingOfficerUserId: "u-1" })],
			resolveOfficerName: (id: string) => `Officer ${id}`,
		});
		const rowResolved = trResolved.root.findAllByProps({ testID: `${PREFIX}-row-req-1` }, { deep: false })[0];
		expect(String(rowResolved.props.children)).toContain("Officer u-1");
		trResolved.unmount();

		const trRaw = renderCallout({ rejections: [makeRejection({ decidingOfficerUserId: "u-1" })] });
		const rowRaw = trRaw.root.findAllByProps({ testID: `${PREFIX}-row-req-1` }, { deep: false })[0];
		expect(String(rowRaw.props.children)).toContain("u-1");
		expect(String(rowRaw.props.children)).not.toContain("Officer u-1");
		trRaw.unmount();
	});

	it("a rejection with an unparseable rejectedAt renders without throwing and the malformed value appears unchanged", () => {
		expect(() =>
			renderCallout({ rejections: [makeRejection({ rejectedAt: "not-a-date" })] }),
		).not.toThrow();
		const tr = renderCallout({ rejections: [makeRejection({ rejectedAt: "not-a-date" })] });
		const row = tr.root.findAllByProps({ testID: `${PREFIX}-row-req-1` }, { deep: false })[0];
		expect(String(row.props.children)).toContain("not-a-date");
		tr.unmount();
	});

	it("R3 sibling-renders half: a genuine earlier sibling rejection — distinct requestId from the request on screen — still renders its date, officer and reason (this file cannot observe the engine-level exclusion itself, only that a surfaced sibling row still renders correctly)", () => {
		const tr = renderCallout({
			rejections: [
				makeRejection({
					requestId: "req-sibling-earlier",
					rejectedAt: "2026-02-10T09:00:00.000Z",
					rejectionReason: "Roll entry not found",
					decidingOfficerUserId: "officer-11",
				}),
			],
		});
		const row = tr.root.findAllByProps({ testID: `${PREFIX}-row-req-sibling-earlier` }, { deep: false })[0];
		const text = String(row.props.children);
		expect(text).toContain("2026-02-10");
		expect(text).toContain("officer-11");
		expect(text).toContain("Roll entry not found");
		tr.unmount();
	});
});
