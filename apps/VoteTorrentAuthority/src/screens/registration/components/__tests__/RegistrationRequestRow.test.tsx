/**
 * RegistrationRequestRow.test.tsx — co-located coverage for the inbox list
 * row (D-03/D-06 — the phase's headline UI requirement). `react-test-renderer`
 * only, file-scope module mocks, mirrors `RegistrantRow.test.tsx`'s harness
 * (sentinel-color idiom, `t: key => key`, `require()` after `jest.mock()`).
 *
 * These assertions prove the MARKUP, not an officer's perception — the
 * device walkthrough is what proves the latter (48-VALIDATION).
 *
 * A `testID` prop set on a component that CONDITIONALLY renders `null`
 * internally (e.g. `BridgeSourceBadge`) still produces a composite-instance
 * match for that `testID` even when nothing visually renders — `react-test-
 * renderer`'s `findAllByProps` walks composite AND host layers. Every
 * existence/count assertion below therefore filters matches down to HOST
 * nodes only (`typeof node.type === "string"`), which is the only layer that
 * reflects what was actually rendered.
 */

import React from "react";
import renderer from "react-test-renderer";
import type { RegistrationRequestListRow } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
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
			dark: "sentinel-dark",
			light: "sentinel-light",
		},
	}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RegistrationRequestRow } = require("../RegistrationRequestRow");

function renderRow(row: RegistrationRequestListRow, onPress: () => void = () => {}): renderer.ReactTestRenderer {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<RegistrationRequestRow row={row} onPress={onPress} />);
	});
	return tr;
}

function makeRow(overrides: Partial<RegistrationRequestListRow> = {}): RegistrationRequestListRow {
	return {
		requestId: "req-001",
		authorityId: "auth-1",
		status: "p",
		issuerType: "registrant",
		submittedAt: "2026-07-01T09:00:00Z",
		receivedAt: "2026-08-05T10:00:00Z",
		lastName: "Doe",
		firstName: "Jane",
		hasPriorRejections: false,
		...overrides,
	};
}

/** Host-layer matches only — see file header. */
function hostNodes(tr: renderer.ReactTestRenderer, testID: string): renderer.ReactTestInstance[] {
	return tr.root.findAllByProps({ testID }).filter((n) => typeof n.type === "string");
}

function flattenedStyle(node: renderer.ReactTestInstance): Record<string, unknown> {
	const style = Array.isArray(node.props.style) ? node.props.style.flat(5) : [node.props.style];
	return Object.assign({}, ...style.filter((s: unknown) => s !== null && s !== undefined && typeof s === "object"));
}

function textOf(node: renderer.ReactTestInstance): string {
	const c = node.props.children;
	return Array.isArray(c) ? c.join("") : String(c ?? "");
}

function colorOf(node: renderer.ReactTestInstance): unknown {
	return flattenedStyle(node).color;
}

describe("RegistrationRequestRow — D-03 bridge marker render-iff", () => {
	it("positive: an issuerType='bridge' row renders exactly one bridge badge and the root has the reserved border", () => {
		const row = makeRow({ issuerType: "bridge", bridgeId: "b-1", bridgeLabel: "County Clerk" });
		const tr = renderRow(row);

		const badges = hostNodes(tr, "registration-request-row-bridge-badge-" + row.requestId);
		expect(badges).toHaveLength(1);

		const rootHosts = hostNodes(tr, "registration-request-row-" + row.requestId);
		expect(rootHosts).toHaveLength(1);
		const rootStyle = flattenedStyle(rootHosts[0]);
		expect(rootStyle.borderLeftWidth).toBe(4);
		expect(rootStyle.borderLeftColor).toBe("sentinel-warning");
	});

	it("negative: an issuerType='registrant' row renders zero bridge badges and no border on the root", () => {
		const row = makeRow({ issuerType: "registrant" });
		const tr = renderRow(row);

		const badges = hostNodes(tr, "registration-request-row-bridge-badge-" + row.requestId);
		expect(badges).toHaveLength(0);

		const rootHosts = hostNodes(tr, "registration-request-row-" + row.requestId);
		const rootStyle = flattenedStyle(rootHosts[0]);
		expect(rootStyle.borderLeftWidth).toBeUndefined();
		expect(rootStyle.borderLeftColor).toBeUndefined();
	});

	it("spoof resistance: a registrant row carrying a stray bridgeId/bridgeLabel still renders zero badges, no border, no bridge-label node", () => {
		const row = makeRow({ issuerType: "registrant", bridgeId: "b-1", bridgeLabel: "County Clerk" });
		const tr = renderRow(row);

		expect(hostNodes(tr, "registration-request-row-bridge-badge-" + row.requestId)).toHaveLength(0);
		expect(hostNodes(tr, "registration-request-row-bridge-label-" + row.requestId)).toHaveLength(0);

		const rootHosts = hostNodes(tr, "registration-request-row-" + row.requestId);
		const rootStyle = flattenedStyle(rootHosts[0]);
		expect(rootStyle.borderLeftWidth).toBeUndefined();
	});

	it("missing label: a bridge row with no bridgeLabel/bridgeId still renders the badge and border, and zero bridge-label nodes", () => {
		const row = makeRow({ issuerType: "bridge", bridgeId: undefined, bridgeLabel: undefined });
		const tr = renderRow(row);

		expect(hostNodes(tr, "registration-request-row-bridge-badge-" + row.requestId)).toHaveLength(1);
		expect(hostNodes(tr, "registration-request-row-bridge-label-" + row.requestId)).toHaveLength(0);

		const rootHosts = hostNodes(tr, "registration-request-row-" + row.requestId);
		expect(flattenedStyle(rootHosts[0]).borderLeftWidth).toBe(4);
	});

	it("bridge label present: renders exactly one bridge-label node with the registered label text", () => {
		const row = makeRow({ issuerType: "bridge", bridgeLabel: "County Clerk" });
		const tr = renderRow(row);

		const labelNodes = hostNodes(tr, "registration-request-row-bridge-label-" + row.requestId);
		expect(labelNodes).toHaveLength(1);
		expect(textOf(labelNodes[0])).toBe("County Clerk");
	});
});

describe("RegistrationRequestRow — status ladder", () => {
	it("each of p/a/r renders its own registrationRequestStatus* key AND its own sentinel color on the pill label", () => {
		const cases: Array<{ status: RegistrationRequestListRow["status"]; key: string; color: string }> = [
			{ status: "p", key: "registrationRequestStatusPending", color: "sentinel-warning" },
			{ status: "a", key: "registrationRequestStatusApproved", color: "sentinel-success" },
			{ status: "r", key: "registrationRequestStatusRejected", color: "sentinel-error" },
		];

		for (const { status, key, color } of cases) {
			const row = makeRow({ status });
			const tr = renderRow(row);
			const pillNodes = hostNodes(tr, "registration-request-row-status-" + row.requestId);
			expect(pillNodes).toHaveLength(1);
			const label = pillNodes[0]
				.findAll((n) => typeof n.type === "string" && (n.type as unknown) === "Text")
				.find((n) => textOf(n) === key);
			expect(label).toBeDefined();
			expect(colorOf(label!)).toBe(color);
			renderer.act(() => {
				tr.unmount();
			});
		}
	});

	it("a duplicate-closed or closing row renders the Closed pill in textSecondary, never Pending (UAT 62 test 12)", () => {
		for (const duplicateClosure of ["closed", "closing"] as const) {
			const row = makeRow({ status: "p", duplicateClosure });
			const tr = renderRow(row);
			const pillNodes = hostNodes(tr, "registration-request-row-status-" + row.requestId);
			expect(pillNodes).toHaveLength(1);
			const texts = pillNodes[0]
				.findAll((n) => typeof n.type === "string" && (n.type as unknown) === "Text")
				.map((n) => textOf(n));
			expect(texts).toContain("registrationRequestStatusClosedDuplicate");
			expect(texts).not.toContain("registrationRequestStatusPending");
			const label = pillNodes[0]
				.findAll((n) => typeof n.type === "string" && (n.type as unknown) === "Text")
				.find((n) => textOf(n) === "registrationRequestStatusClosedDuplicate");
			expect(colorOf(label!)).toBe("sentinel-textSecondary");
			renderer.act(() => {
				tr.unmount();
			});
		}
	});

	it("unknown status code renders the raw code with zero status pill nodes and does not throw", () => {
		const row = makeRow({ status: "z" as unknown as RegistrationRequestListRow["status"] });
		expect(() => renderRow(row)).not.toThrow();
		const tr = renderRow(row);
		expect(hostNodes(tr, "registration-request-row-status-" + row.requestId)).toHaveLength(0);
		expect(JSON.stringify(tr.toJSON())).toContain("z");
	});
});

describe("RegistrationRequestRow — disambiguation (bridge + pending simultaneously)", () => {
	it("a bridge AND pending row renders the warning left border AND a warning-tinted pending pill as distinct nodes", () => {
		const row = makeRow({ issuerType: "bridge", bridgeLabel: "County Clerk", status: "p" });
		const tr = renderRow(row);

		const rootHosts = hostNodes(tr, "registration-request-row-" + row.requestId);
		expect(flattenedStyle(rootHosts[0]).borderLeftWidth).toBe(4);

		const pillNodes = hostNodes(tr, "registration-request-row-status-" + row.requestId);
		expect(pillNodes).toHaveLength(1);
		expect(flattenedStyle(pillNodes[0]).borderLeftWidth).toBeUndefined();

		const label = pillNodes[0]
			.findAll((n) => typeof n.type === "string" && (n.type as unknown) === "Text")
			.find((n) => textOf(n) === "registrationRequestStatusPending");
		expect(colorOf(label!)).toBe("sentinel-warning");
	});
});

describe("RegistrationRequestRow — observed-vs-claimed timestamps", () => {
	it("divergent dates: exactly one received node and one claimed node, differing values, never substituted", () => {
		const row = makeRow({ receivedAt: "2026-08-05T10:00:00Z", submittedAt: "2026-07-01T09:00:00Z" });
		const tr = renderRow(row);

		const receivedNodes = hostNodes(tr, "registration-request-row-received-at-" + row.requestId);
		const claimedNodes = hostNodes(tr, "registration-request-row-claimed-submitted-at-" + row.requestId);
		expect(receivedNodes).toHaveLength(1);
		expect(claimedNodes).toHaveLength(1);

		const receivedText = textOf(receivedNodes[0]);
		const claimedText = textOf(claimedNodes[0]);
		expect(receivedText).toContain("registrationRequestReceivedAtLabel");
		expect(receivedText).toContain("2026-08-05");
		expect(claimedText).toContain("registrationRequestClaimedSubmittedAtLabel");
		expect(claimedText).toContain("2026-07-01");
		expect(receivedText).not.toBe(claimedText);

		// Never-substituted: neither value ever appears under the other's testID.
		expect(receivedText).not.toContain("2026-07-01");
		expect(claimedText).not.toContain("2026-08-05");
	});

	it("converged dates: exactly one received node, zero claimed nodes, and the survivor is the receivedAt-derived value", () => {
		const row = makeRow({ receivedAt: "2026-08-05T10:00:00Z", submittedAt: "2026-08-05T02:00:00Z" });
		const tr = renderRow(row);

		expect(hostNodes(tr, "registration-request-row-received-at-" + row.requestId)).toHaveLength(1);
		expect(hostNodes(tr, "registration-request-row-claimed-submitted-at-" + row.requestId)).toHaveLength(0);

		const receivedText = textOf(hostNodes(tr, "registration-request-row-received-at-" + row.requestId)[0]);
		expect(receivedText).toContain("2026-08-05");
	});

	it("backdated claim (30 days before, 48-07's extreme): both render, older under claimed, newer under received", () => {
		const row = makeRow({ receivedAt: "2026-08-05T10:00:00Z", submittedAt: "2026-07-06T10:00:00Z" });
		const tr = renderRow(row);

		const receivedText = textOf(hostNodes(tr, "registration-request-row-received-at-" + row.requestId)[0]);
		const claimedText = textOf(hostNodes(tr, "registration-request-row-claimed-submitted-at-" + row.requestId)[0]);
		expect(receivedText).toContain("2026-08-05");
		expect(claimedText).toContain("2026-07-06");
	});

	it("muted, non-competing: both timestamp lines resolve to textSecondary, never warning; a registrant divergent row still has no border", () => {
		const row = makeRow({
			issuerType: "registrant",
			receivedAt: "2026-08-05T10:00:00Z",
			submittedAt: "2026-07-01T09:00:00Z",
		});
		const tr = renderRow(row);

		const receivedNode = hostNodes(tr, "registration-request-row-received-at-" + row.requestId)[0];
		const claimedNode = hostNodes(tr, "registration-request-row-claimed-submitted-at-" + row.requestId)[0];
		expect(colorOf(receivedNode)).toBe("sentinel-textSecondary");
		expect(colorOf(claimedNode)).toBe("sentinel-textSecondary");
		expect(colorOf(receivedNode)).not.toBe("sentinel-warning");
		expect(colorOf(claimedNode)).not.toBe("sentinel-warning");

		const rootHosts = hostNodes(tr, "registration-request-row-" + row.requestId);
		expect(flattenedStyle(rootHosts[0]).borderLeftWidth).toBeUndefined();
	});
});

describe("RegistrationRequestRow — D-06 muted prior-rejection glyph", () => {
	it("hasPriorRejections=true renders exactly one flag node, muted (never warning)", () => {
		const row = makeRow({ hasPriorRejections: true });
		const tr = renderRow(row);

		const flagNodes = hostNodes(tr, "registration-request-row-prior-rejected-" + row.requestId);
		expect(flagNodes).toHaveLength(1);

		const icon = tr.root
			.findAllByType("FontAwesome6" as never)
			.find((n) => n.props.name === "circle-exclamation");
		expect(icon).toBeDefined();
		expect(icon!.props.color).toBe("sentinel-textSecondary");
		expect(icon!.props.color).not.toBe("sentinel-warning");

		const caption = flagNodes[0]
			.findAll((n) => typeof n.type === "string" && (n.type as unknown) === "Text")
			.find((n) => textOf(n) === "registrationRequestPreviouslyRejectedFlag");
		expect(caption).toBeDefined();
		expect(colorOf(caption!)).toBe("sentinel-textSecondary");
		expect(colorOf(caption!)).not.toBe("sentinel-warning");
	});

	it("hasPriorRejections=false renders zero flag nodes", () => {
		const row = makeRow({ hasPriorRejections: false });
		const tr = renderRow(row);
		expect(hostNodes(tr, "registration-request-row-prior-rejected-" + row.requestId)).toHaveLength(0);
	});
});

describe("RegistrationRequestRow — onPress and negative space", () => {
	it("onPress fires exactly once when the row is pressed", () => {
		const onPress = jest.fn();
		const row = makeRow();
		const tr = renderRow(row, onPress);
		const touchable = tr.root.findByProps({ testID: "registration-request-row-" + row.requestId });
		touchable.props.onPress();
		expect(onPress).toHaveBeenCalledTimes(1);
	});

	it("negative space: no payload, signature, or CID substring reaches the tree", () => {
		const row = makeRow({ issuerType: "bridge", bridgeLabel: "County Clerk", hasPriorRejections: true });
		const tr = renderRow(row);
		const json = JSON.stringify(tr.toJSON());
		expect(json).not.toContain("payload");
		expect(json).not.toContain("requesterSignature");
		expect(json).not.toContain("Cid");
		expect(json).not.toContain("ssn");
		expect(json).not.toContain("SSN");
	});
});

describe("RegistrationRequestRow — long names never push the pill or chevron off the card (360dp)", () => {
	const LONG = { lastName: "Fernández-Villalobos de la Concepción", firstName: "María Guadalupe" };

	function nameNode(tr: renderer.ReactTestRenderer, requestId: string): renderer.ReactTestInstance {
		const nodes = hostNodes(tr, "registration-request-row-name-" + requestId);
		expect(nodes).toHaveLength(1);
		return nodes[0];
	}

	it.each([
		["pending", { status: "p" as const }],
		["duplicate-closed", { status: "p" as const, duplicateClosure: "closed" as const }],
		["approved", { status: "a" as const }],
	])("%s: the name shrinks and ellipsizes on one line; the pill never shrinks", (_label, overrides) => {
		const row = makeRow({ ...LONG, ...overrides });
		const tr = renderRow(row);
		const name = nameNode(tr, row.requestId);
		expect(name.props.numberOfLines).toBe(1);
		expect(flattenedStyle(name).flexShrink).toBeGreaterThanOrEqual(1);
		expect(flattenedStyle(name).minWidth ?? 0).toBe(0);
		const pill = hostNodes(tr, "registration-request-row-status-" + row.requestId);
		expect(pill).toHaveLength(1);
		expect(flattenedStyle(pill[0]).flexShrink).toBe(0);
	});

	it("the chevron keeps its width and the left column is bounded (flex:1, minWidth 0)", () => {
		const row = makeRow(LONG);
		const tr = renderRow(row);
		const chevron = tr.root.findAll((n) => n.props.name === "chevron-right" && typeof n.type === "string");
		expect(chevron).toHaveLength(1);
		expect(flattenedStyle(chevron[0]).flexShrink).toBe(0);
		// The left column is the name's ancestor that sits beside the chevron.
		const column = chevron[0].parent!.children.find(
			(c) => typeof c !== "string" && c !== chevron[0],
		) as renderer.ReactTestInstance;
		const columnStyle = flattenedStyle(column);
		expect(columnStyle.flex).toBe(1);
		expect(columnStyle.minWidth).toBe(0);
	});

	it("unknown status: the raw-code fallback in the pill slot never shrinks either", () => {
		const row = makeRow({ ...LONG, status: "z" as unknown as RegistrationRequestListRow["status"] });
		const tr = renderRow(row);
		const raw = tr.root.findAll(
			(n) => typeof n.type === "string" && (n.type as unknown) === "Text" && textOf(n) === "z",
		);
		expect(raw).toHaveLength(1);
		expect(flattenedStyle(raw[0]).flexShrink).toBe(0);
	});
});
