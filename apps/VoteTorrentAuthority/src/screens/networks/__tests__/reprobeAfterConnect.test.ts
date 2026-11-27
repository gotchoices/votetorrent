/**
 * reprobeAfterConnect — post-Connect control-cohort pass + strand-address refresh.
 */
import { reprobeAfterConnect } from "../reprobeAfterConnect";

type Strands = Map<string, { libp2pNode?: { getConnections: () => unknown[] } }>;

function makeNode(opts: {
	reconcile: () => Promise<unknown>;
	strands?: Strands;
}) {
	return {
		reconcileControlCohort: jest.fn(opts.reconcile),
		getStrands: jest.fn(() => opts.strands ?? new Map()),
	};
}

const LINE = /^\[connect\] strand re-probe: (reconciled|failed|timed-out|no-strand) strands=\d+ connected=\d+$/;

let infoSpy: jest.SpyInstance;
beforeEach(() => {
	infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
	infoSpy.mockRestore();
	jest.useRealTimers();
});

describe("reprobeAfterConnect", () => {
	it("1: resolves -> reconciled with strand and connected counts", async () => {
		const strands: Strands = new Map([
			["a", { libp2pNode: { getConnections: () => [{}] } }],
			["b", { libp2pNode: { getConnections: () => [] } }],
			["c", {}],
		]);
		const node = makeNode({ reconcile: async () => ({ dialed: [] }), strands });
		const out = await reprobeAfterConnect(node as never);
		expect(out).toEqual({ status: "reconciled", strands: 2, connectedStrands: 1 });
		expect(node.reconcileControlCohort).toHaveBeenCalledTimes(1);
	});

	it("2: rejects -> failed, never throws", async () => {
		const node = makeNode({
			reconcile: async () => {
				throw new Error("boom");
			},
			strands: new Map([["a", { libp2pNode: { getConnections: () => [] } }]]),
		});
		const out = await reprobeAfterConnect(node as never);
		expect(out.status).toBe("failed");
		expect(out.strands).toBe(1);
	});

	it("3: never settles -> timed-out after timeoutMs, timer cleared", async () => {
		jest.useFakeTimers();
		const node = makeNode({ reconcile: () => new Promise(() => undefined) });
		const p = reprobeAfterConnect(node as never, { timeoutMs: 5000 });
		await jest.advanceTimersByTimeAsync(5000);
		const out = await p;
		expect(out.status).toBe("timed-out");
		expect(jest.getTimerCount()).toBe(0);
	});

	it("3b: settling early clears the timer", async () => {
		jest.useFakeTimers();
		const node = makeNode({ reconcile: async () => ({}) });
		await reprobeAfterConnect(node as never);
		expect(jest.getTimerCount()).toBe(0);
	});

	it("4: no strands -> no-strand, reconcile still called once", async () => {
		const node = makeNode({ reconcile: async () => ({}) });
		const out = await reprobeAfterConnect(node as never);
		expect(out).toEqual({ status: "no-strand", strands: 0, connectedStrands: 0 });
		expect(node.reconcileControlCohort).toHaveBeenCalledTimes(1);
	});

	it("4b: a strand torn down mid-count counts as not connected", async () => {
		const strands: Strands = new Map([
			[
				"a",
				{
					libp2pNode: {
						getConnections: () => {
							throw new Error("stopped");
						},
					},
				},
			],
		]);
		const node = makeNode({ reconcile: async () => ({}), strands });
		const out = await reprobeAfterConnect(node as never);
		expect(out).toEqual({ status: "reconciled", strands: 1, connectedStrands: 0 });
	});

	it("5: exactly one closed-token console.info line per call", async () => {
		const cases = [
			makeNode({ reconcile: async () => ({}), strands: new Map([["a", { libp2pNode: { getConnections: () => [{}] } }]]) }),
			makeNode({
				reconcile: async () => {
					throw new Error("12D3KooWsecret /ip4/10.0.0.1/tcp/1");
				},
			}),
			makeNode({ reconcile: async () => ({}) }),
		];
		for (const node of cases) {
			infoSpy.mockClear();
			await reprobeAfterConnect(node as never);
			expect(infoSpy).toHaveBeenCalledTimes(1);
			expect(String(infoSpy.mock.calls[0][0])).toMatch(LINE);
			expect(infoSpy.mock.calls[0]).toHaveLength(1);
		}
	});
});
