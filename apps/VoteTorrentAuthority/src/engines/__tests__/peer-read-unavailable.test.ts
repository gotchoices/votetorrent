/**
 * peer-read-unavailable.test.ts — tells "the network could not answer" apart from "the data is
 * not there" (gap 7, D-23/D-39), plus the translated notice the screens render for it.
 *
 * The error shapes are built structurally (name + fields + message), the same way the screens
 * meet them: the app never imports @optimystic/db-core.
 */

import React from "react";
import renderer from "react-test-renderer";
import { Text } from "react-native";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

const mockT = (key: string) => key;
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: mockT }),
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "sentinel-primary",
			background: "sentinel-background",
			card: "sentinel-card",
			text: "sentinel-text",
			border: "sentinel-border",
			error: "sentinel-error",
			warning: "sentinel-warning",
			accent: "sentinel-accent",
			light: "sentinel-light",
			dark: "sentinel-dark",
			textSecondary: "sentinel-textSecondary",
		},
	}),
}));

import { classifyPeerReadFailure } from "../peer-read-unavailable";

function blockUnavailable(blockId: string, reason: string): Error {
	return Object.assign(
		new Error(`Block ${blockId} is unavailable (${reason}): the repo could not determine whether it exists`),
		{ name: "BlockUnavailableError", blockId, reason }
	);
}

describe("classifyPeerReadFailure", () => {
	it("classifies a BlockUnavailableError by its reason", () => {
		expect(classifyPeerReadFailure(blockUnavailable("default/app/Admin", "cohort-unreachable"))).toEqual({
			reason: "cohort-unreachable",
		});
	});

	it("classifies a renamed wrapper by the message alone", () => {
		const err = new Error("Block default/app/InviteCancellation is unavailable (cohort-unreachable)");
		expect(classifyPeerReadFailure(err)).toEqual({ reason: "cohort-unreachable" });
	});

	it("walks cause two levels down to a peers-unreachable BlockUnavailableError", () => {
		const inner = blockUnavailable("default/app/Election", "peers-unreachable");
		const middle = Object.assign(new Error("vtab read failed"), { cause: inner });
		const outer = Object.assign(new Error("query failed"), { cause: middle });
		expect(classifyPeerReadFailure(outer)).toEqual({ reason: "peers-unreachable" });
	});

	it("classifies a BlockPossiblyStaleError as possibly-stale", () => {
		const err = Object.assign(new Error("Block default/app/Admin may be stale: a cohort peer claimed rev 4 ..."), {
			name: "BlockPossiblyStaleError",
			blockId: "default/app/Admin",
			claimedRev: 4,
		});
		expect(classifyPeerReadFailure(err)).toEqual({ reason: "possibly-stale" });
	});

	it("classifies a possibly-stale message under a different name", () => {
		expect(classifyPeerReadFailure(new Error("Block x/y may be stale: claimed rev 2"))).toEqual({
			reason: "possibly-stale",
		});
	});

	it("falls back to the parenthesised reason when the name matches but the field is missing", () => {
		const err = Object.assign(new Error("Block a/b is unavailable (named-by-log): ..."), { name: "BlockUnavailableError" });
		expect(classifyPeerReadFailure(err)).toEqual({ reason: "named-by-log" });
	});

	it.each([
		["a plain error", new Error("boom")],
		["a string", "Block a/b is unavailable (cohort-unreachable)"],
		["null", null],
		["undefined", undefined],
		["a number", 42],
	])("returns null for %s", (_label, value) => {
		expect(classifyPeerReadFailure(value)).toBeNull();
	});

	it("returns null (no throw, no infinite loop) on a self-referencing cause cycle", () => {
		const a = new Error("first") as Error & { cause?: unknown };
		const b = new Error("second") as Error & { cause?: unknown };
		a.cause = b;
		b.cause = a;
		const self = new Error("self") as Error & { cause?: unknown };
		self.cause = self;
		expect(classifyPeerReadFailure(a)).toBeNull();
		expect(classifyPeerReadFailure(self)).toBeNull();
	});

	it("stops after five cause levels", () => {
		let err: unknown = blockUnavailable("deep/block", "cohort-unreachable");
		for (let i = 0; i < 6; i++) err = Object.assign(new Error(`wrap ${i}`), { cause: err });
		expect(classifyPeerReadFailure(err)).toBeNull();
	});
});

function textContent(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}

async function renderNotice(variant: "unavailable" | "stale", onRetry: () => void) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { PeerReadUnavailableNotice } = require("../../components/PeerReadUnavailableNotice");
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(React.createElement(PeerReadUnavailableNotice, { variant, onRetry }));
	});
	return tr;
}

describe("PeerReadUnavailableNotice", () => {
	it("variant unavailable renders the title, body and a Try Again button that calls onRetry", async () => {
		const onRetry = jest.fn();
		const tr = await renderNotice("unavailable", onRetry);
		expect(tr.root.findAll((n) => n.props?.testID === "peer-read-unavailable-notice").length).toBeGreaterThan(0);
		const texts = tr.root.findAllByType(Text).map(textContent).join(" | ");
		expect(texts).toContain("peerReadUnavailableTitle");
		expect(texts).toContain("peerReadUnavailableBody");
		expect(texts).not.toContain("peerReadUnavailableStaleBody");
		const retry = tr.root.findAll(
			(n) => n.props?.testID === "peer-read-unavailable-retry" && typeof n.props?.onPress === "function"
		);
		expect(retry.length).toBeGreaterThan(0);
		await renderer.act(async () => {
			retry[0].props.onPress();
		});
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("variant stale renders the stale body and the same button", async () => {
		const onRetry = jest.fn();
		const tr = await renderNotice("stale", onRetry);
		const texts = tr.root.findAllByType(Text).map(textContent).join(" | ");
		expect(texts).toContain("peerReadUnavailableStaleBody");
		expect(texts).not.toContain("peerReadUnavailableBody |");
		const retry = tr.root.findAll(
			(n) => n.props?.testID === "peer-read-unavailable-retry" && typeof n.props?.onPress === "function"
		);
		expect(retry.length).toBeGreaterThan(0);
		await renderer.act(async () => {
			retry[0].props.onPress();
		});
		expect(onRetry).toHaveBeenCalledTimes(1);
	});
});
