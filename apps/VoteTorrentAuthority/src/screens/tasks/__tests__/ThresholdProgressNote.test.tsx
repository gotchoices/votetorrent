/**
 * ThresholdProgressNote.test.tsx — 62-12 (Surface 5, D-09/D-10/D-11).
 *
 * Copy + state coverage (N1-N7) for the standalone component, plus a mounted-TaskCard geometry
 * gate (G1-G5: adjacency, wrap-not-clip, no clipping container, row touch target, the shared
 * inbox filter). `react-test-renderer` only — RN jest has no layout engine, so "geometry" here
 * means the rendered style props that determine layout (`StyleSheet.flatten`), mirroring
 * `button-radius-padding.test.tsx`'s own convention.
 */

import React from "react";
import { StyleSheet } from "react-native";
import renderer, { act } from "react-test-renderer";
import type { BallotSignatureTask, ISignatureTasksEngine, SignatureTask, SigningStatus } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

// Distinct sentinel values so a colour assertion cannot pass by accidental equality
// (mirrors button-radius-padding.test.tsx's PALETTE convention).
const PALETTE = {
	text: "#T",
	textSecondary: "#TS",
	success: "#SU",
	warning: "#WA",
	error: "#ER",
	accent: "#AC",
	card: "#CA",
	background: "#BG",
	border: "#BO",
	dark: "#DA",
	light: "#LI",
	primary: "#PR",
	notification: "#NO",
	important: "#IM",
};

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({ dark: false, colors: PALETTE }),
}));

let mockCurrentLocale: "en" | "es" = "en";

jest.mock("react-i18next", () => ({
	// Real interpolating t, built from the imported `resources` object for whichever locale the
	// test selects via `mockCurrentLocale` — never a hardcoded copy literal.
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources } = require("../../../i18n");
			const template = (resources[mockCurrentLocale].translation as Record<string, string>)[key];
			if (typeof template !== "string") return key;
			if (!opts) return template;
			return template.replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => String(opts[name] ?? ""));
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resources } = require("../../../i18n");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ThresholdProgressNote } = require("../components/ThresholdProgressNote");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TaskCard } = require("../components/TaskCard");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
	selectRenderableSignatureTasks,
	loadTaskSigningStatus,
} = require("../renderable-signature-tasks");

function flattenStyle(node: renderer.ReactTestInstance): Record<string, unknown> {
	return StyleSheet.flatten(node.props.style) as Record<string, unknown>;
}

function mount(element: React.ReactElement): renderer.ReactTestRenderer {
	let tr!: renderer.ReactTestRenderer;
	act(() => {
		tr = renderer.create(element);
	});
	return tr;
}

function makeStatus(overrides: Partial<SigningStatus>): SigningStatus {
	return {
		nonce: "nonce-1",
		scope: "ceb",
		threshold: 2,
		signatures: 1,
		openTasks: 1,
		rejected: 0,
		reached: false,
		unreachable: false,
		...overrides,
	};
}

describe("ThresholdProgressNote — copy + state (N1-N7)", () => {
	beforeEach(() => {
		mockCurrentLocale = "en";
	});

	test("N1a: status null renders nothing", () => {
		const tr = mount(<ThresholdProgressNote status={null} />);
		expect(tr.toJSON()).toBeNull();
	});

	test("N1b: status undefined renders nothing", () => {
		const tr = mount(<ThresholdProgressNote status={undefined} />);
		expect(tr.toJSON()).toBeNull();
	});

	test("N1c: threshold 1 (any counts) renders nothing", () => {
		const tr = mount(<ThresholdProgressNote status={makeStatus({ threshold: 1, signatures: 5, reached: true })} />);
		expect(tr.toJSON()).toBeNull();
	});

	test("N2: progress (D-09) renders the EN resource text", () => {
		const tr = mount(<ThresholdProgressNote status={makeStatus({ threshold: 2, signatures: 1, reached: false, unreachable: false })} />);
		const expected = resources.en.translation.signatureTaskThresholdProgress
			.replace("{{signed}}", "1")
			.replace("{{threshold}}", "2");
		expect(expected).toBe("1 of 2 signatures");
		expect(tr.root.findByType(require("react-native").Text).props.children).toBe(expected);
	});

	test("N2 (ES): progress renders the ES resource text", () => {
		mockCurrentLocale = "es";
		const tr = mount(<ThresholdProgressNote status={makeStatus({ threshold: 2, signatures: 1, reached: false, unreachable: false })} />);
		const expected = resources.es.translation.signatureTaskThresholdProgress
			.replace("{{signed}}", "1")
			.replace("{{threshold}}", "2");
		expect(tr.root.findByType(require("react-native").Text).props.children).toBe(expected);
	});

	test("N3: reached (D-09) renders the EN resource text", () => {
		const tr = mount(<ThresholdProgressNote status={makeStatus({ threshold: 2, signatures: 2, reached: true })} />);
		expect(tr.root.findByType(require("react-native").Text).props.children).toBe(resources.en.translation.signatureTaskThresholdReached);
	});

	test("N4: past threshold (D-10) renders identically to at-threshold", () => {
		const atThreshold = mount(<ThresholdProgressNote status={makeStatus({ threshold: 2, signatures: 2, reached: true })} />);
		const pastThreshold = mount(<ThresholdProgressNote status={makeStatus({ threshold: 2, signatures: 3, reached: true })} />);
		expect(pastThreshold.toJSON()).toEqual(atThreshold.toJSON());
	});

	test("N5: no veto (D-11) — rejections never change the rendering", () => {
		const noRejects = mount(
			<ThresholdProgressNote status={makeStatus({ threshold: 3, signatures: 1, rejected: 0, unreachable: false })} />
		);
		const withRejects = mount(
			<ThresholdProgressNote status={makeStatus({ threshold: 3, signatures: 1, rejected: 2, unreachable: false })} />
		);
		expect(withRejects.toJSON()).toEqual(noRejects.toJSON());
	});

	test("N6: unreachable renders nothing (the closed path is handled by the screens)", () => {
		const tr = mount(<ThresholdProgressNote status={makeStatus({ threshold: 2, signatures: 1, unreachable: true })} />);
		expect(tr.toJSON()).toBeNull();
	});

	test("N7a: colour is textSecondary in the progress state, never success", () => {
		const tr = mount(<ThresholdProgressNote status={makeStatus({ threshold: 2, signatures: 1, reached: false })} />);
		const flat = flattenStyle(tr.root.findByType(require("react-native").Text));
		expect(flat.color).toBe(PALETTE.textSecondary);
		expect(flat.color).not.toBe(PALETTE.success);
	});

	test("N7b: colour is textSecondary in the reached state, never success", () => {
		const tr = mount(<ThresholdProgressNote status={makeStatus({ threshold: 2, signatures: 2, reached: true })} />);
		const flat = flattenStyle(tr.root.findByType(require("react-native").Text));
		expect(flat.color).toBe(PALETTE.textSecondary);
		expect(flat.color).not.toBe(PALETTE.success);
	});
});

describe("TaskCard geometry gate (G1-G4, mounted, ES locale, longest real string)", () => {
	beforeEach(() => {
		mockCurrentLocale = "es";
	});

	function makeBallotTask(): BallotSignatureTask {
		return {
			type: "signature",
			signatureType: "ballot",
			userId: "officer-1",
			network: {
				hash: "net-hash",
				name: "Red de Prueba",
				relays: [],
				primaryAuthorityDomainName: "test.example",
			},
			ballot: {
				proposed: {
					id: "ballot-1",
					electionId: "election-1",
					authorityId: "authority-1",
					description: "Boleta de Prueba con un Título Bastante Largo",
					districts: [],
					questions: [],
				},
				signers: [],
				timestamp: Date.now(),
			},
		} as unknown as BallotSignatureTask;
	}

	// The LONGEST real string: the reached note, ES locale.
	const reachedStatus = makeStatus({ threshold: 2, signatures: 2, reached: true, unreachable: false });

	function findJsonByTestID(node: unknown, testID: string, path: unknown[] = []): { node: any; path: any[] } | null {
		if (node == null || typeof node === "string") return null;
		if (Array.isArray(node)) {
			for (const child of node) {
				const found = findJsonByTestID(child, testID, path);
				if (found) return found;
			}
			return null;
		}
		const n = node as { props?: Record<string, unknown>; children?: unknown[] };
		if (n.props && n.props.testID === testID) return { node, path };
		if (n.children) {
			for (const child of n.children) {
				const found = findJsonByTestID(child, testID, [...path, node]);
				if (found) return found;
			}
		}
		return null;
	}

	test("G1: the note is a direct child of the content column, immediately after the title", () => {
		const tr = mount(
			<TaskCard task={makeBallotTask()} chipLabel="FIRMA" thresholdStatus={reachedStatus} />
		);
		const json = tr.toJSON() as any;
		const content = findJsonByTestID(json, "task-card-content")!.node;
		expect(content).toBeTruthy();
		const children = content.children as any[];
		const titleIndex = children.findIndex((c) => c?.props?.numberOfLines === 1 && typeof c.children?.[0] === "string" && c.children[0].includes("Bastante Largo"));
		expect(titleIndex).toBeGreaterThanOrEqual(0);
		const noteNode = children[titleIndex + 1];
		expect(noteNode?.props?.testID).toBe("threshold-progress-note");
	});

	test("G2: the note wraps (no numberOfLines/ellipsizeMode), fixed 20px line height, no absolute position, full text", () => {
		const tr = mount(
			<TaskCard task={makeBallotTask()} chipLabel="FIRMA" thresholdStatus={reachedStatus} />
		);
		const json = tr.toJSON() as any;
		const note = findJsonByTestID(json, "threshold-progress-note")!.node;
		expect(note.props.numberOfLines).toBeUndefined();
		expect(note.props.ellipsizeMode).toBeUndefined();
		const flat = StyleSheet.flatten(note.props.style) as Record<string, unknown>;
		expect(flat.fontSize).toBe(14);
		expect(flat.lineHeight).toBe(20);
		expect(flat.position).not.toBe("absolute");
		const expectedText = resources.es.translation.signatureTaskThresholdReached;
		expect(expectedText).toBe("Umbral alcanzado — aún se pueden añadir más firmas");
		expect(note.children).toEqual([expectedText]);
	});

	test("G3: no ancestor from the note up to the TouchableOpacity root clips (no height/maxHeight/overflow hidden)", () => {
		const tr = mount(
			<TaskCard task={makeBallotTask()} chipLabel="FIRMA" thresholdStatus={reachedStatus} />
		);
		const json = tr.toJSON() as any;
		const found = findJsonByTestID(json, "threshold-progress-note")!;
		const ancestors = [...found.path, found.node];
		for (const ancestor of ancestors) {
			const flat = StyleSheet.flatten((ancestor as any).props?.style) as Record<string, unknown>;
			expect(flat.height).toBeUndefined();
			expect(flat.maxHeight).toBeUndefined();
			expect(flat.overflow).not.toBe("hidden");
		}
	});

	function estimateMinRowHeight(cardJson: any): number {
		const cardStyle = StyleSheet.flatten(cardJson.props.style) as Record<string, unknown>;
		const paddingVertical = typeof cardStyle.paddingVertical === "number" ? cardStyle.paddingVertical : 0;
		const paddingTop = typeof cardStyle.paddingTop === "number" ? cardStyle.paddingTop : paddingVertical;
		const paddingBottom = typeof cardStyle.paddingBottom === "number" ? cardStyle.paddingBottom : paddingVertical;

		const content = findJsonByTestID(cardJson, "task-card-content")!.node;
		let contentSum = 0;
		for (const child of content.children ?? []) {
			if (!child || typeof child === "string") continue;
			const style = StyleSheet.flatten(child.props?.style) as Record<string, unknown>;
			if (child.type === "Text") {
				const lineHeight =
					typeof style.lineHeight === "number"
						? style.lineHeight
						: typeof style.fontSize === "number"
							? (style.fontSize as number) * 1.2
							: 0;
				contentSum += lineHeight;
			} else if (child.type === "View") {
				const height = typeof style.height === "number" ? style.height : 0;
				const marginBottom = typeof style.marginBottom === "number" ? style.marginBottom : 0;
				contentSum += height + marginBottom;
			}
		}

		let imageHeight = 0;
		const walkForImage = (node: any): void => {
			if (!node || typeof node === "string") return;
			if (node.type === "Image") {
				const style = StyleSheet.flatten(node.props?.style) as Record<string, unknown>;
				if (typeof style.height === "number") imageHeight = style.height as number;
			}
			(node.children ?? []).forEach(walkForImage);
		};
		walkForImage(cardJson);

		return Math.max(paddingTop + paddingBottom + contentSum, imageHeight);
	}

	test("G4: row touch target stays >= 44px, and the note adds >= 20px over the no-note row", () => {
		const withNote = mount(<TaskCard task={makeBallotTask()} chipLabel="FIRMA" thresholdStatus={reachedStatus} />);
		const withoutNote = mount(<TaskCard task={makeBallotTask()} chipLabel="FIRMA" thresholdStatus={null} />);

		const heightWithNote = estimateMinRowHeight(withNote.toJSON());
		const heightWithoutNote = estimateMinRowHeight(withoutNote.toJSON());

		// eslint-disable-next-line no-console
		console.log(`G4 estimateMinRowHeight: withoutNote=${heightWithoutNote} withNote=${heightWithNote}`);

		expect(heightWithoutNote).toBeGreaterThanOrEqual(44);
		expect(heightWithNote).toBeGreaterThanOrEqual(44);
		expect(heightWithNote).toBeGreaterThanOrEqual(heightWithoutNote + 20);
	});
});

describe("G5: the shared filter (selectRenderableSignatureTasks, loadTaskSigningStatus)", () => {
	function makeTask(signatureType: SignatureTask["signatureType"], userId: string): SignatureTask {
		return {
			type: "signature",
			signatureType,
			userId,
			network: { hash: "h", name: "N", relays: [], primaryAuthorityDomainName: "t.example" },
		} as SignatureTask;
	}

	test("a registrant task is excluded", () => {
		const tasks = [makeTask("registrant", "u1")];
		const result = selectRenderableSignatureTasks(tasks, [null]);
		expect(result).toHaveLength(0);
	});

	test("a task with status.unreachable === true is excluded", () => {
		const tasks = [makeTask("ballot", "u1")];
		const result = selectRenderableSignatureTasks(tasks, [makeStatus({ unreachable: true })]);
		expect(result).toHaveLength(0);
	});

	test("a task with status === null is KEPT (fail-open)", () => {
		const tasks = [makeTask("ballot", "u1")];
		const result = selectRenderableSignatureTasks(tasks, [null]);
		expect(result).toHaveLength(1);
		expect(result[0].status).toBeNull();
	});

	test("a reached task is kept", () => {
		const tasks = [makeTask("ballot", "u1")];
		const status = makeStatus({ reached: true, unreachable: false });
		const result = selectRenderableSignatureTasks(tasks, [status]);
		expect(result).toHaveLength(1);
		expect(result[0].status).toEqual(status);
	});

	test("input order is preserved", () => {
		const tasks = [makeTask("ballot", "u1"), makeTask("admin", "u2"), makeTask("network", "u3")];
		const result = selectRenderableSignatureTasks(tasks, [null, null, null]);
		expect(result.map((r: { task: SignatureTask }) => r.task.userId)).toEqual(["u1", "u2", "u3"]);
	});

	test("loadTaskSigningStatus returns null when the engine is undefined", async () => {
		const result = await loadTaskSigningStatus(undefined, makeTask("ballot", "u1"));
		expect(result).toBeNull();
	});

	test("loadTaskSigningStatus returns null when the engine has no getTaskSigningStatus member", async () => {
		const engine = {} as ISignatureTasksEngine;
		const result = await loadTaskSigningStatus(engine, makeTask("ballot", "u1"));
		expect(result).toBeNull();
	});

	test("loadTaskSigningStatus returns null when the method rejects", async () => {
		const engine = {
			getTaskSigningStatus: async () => {
				throw new Error("boom");
			},
		} as unknown as ISignatureTasksEngine;
		const result = await loadTaskSigningStatus(engine, makeTask("ballot", "u1"));
		expect(result).toBeNull();
	});

	test("loadTaskSigningStatus returns null when the method throws synchronously", async () => {
		const engine = {
			getTaskSigningStatus: () => {
				throw new Error("boom-sync");
			},
		} as unknown as ISignatureTasksEngine;
		const result = await loadTaskSigningStatus(engine, makeTask("ballot", "u1"));
		expect(result).toBeNull();
	});
});
