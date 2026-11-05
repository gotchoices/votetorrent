/**
 * O-04: a rotation (WIDTH change) while scrolled keeps the officer's place. Height-only changes
 * (the IME on API < 35) and keyboard events never trigger a restore.
 */
import React from "react";
import renderer from "react-test-renderer";
import { usePreserveScrollOnResize } from "../usePreserveScrollOnResize";

let handlers: ReturnType<typeof usePreserveScrollOnResize>;
const ref = { current: { scrollTo: jest.fn(), scrollToEnd: jest.fn() } };
const caller = { onScroll: jest.fn(), onLayout: jest.fn(), onContentSizeChange: jest.fn() };

function Probe() {
	handlers = usePreserveScrollOnResize(ref, caller);
	return null;
}

let mockDims = { width: 360, height: 760 };
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
	__esModule: true,
	default: () => ({ ...mockDims, scale: 2, fontScale: 1 }),
}));
let tr: renderer.ReactTestRenderer;

async function mount() {
	await renderer.act(async () => {
		tr = renderer.create(<Probe />);
	});
}
async function setDims(d: { width: number; height: number }) {
	mockDims = d;
	await renderer.act(async () => {
		tr.update(<Probe />);
	});
}
const scroll = (y: number) =>
	handlers.onScroll({ nativeEvent: { contentOffset: { y } } } as any);
const layout = (h: number) => handlers.onLayout({ nativeEvent: { layout: { height: h, width: 0, x: 0, y: 0 } } } as any);

beforeEach(() => {
	jest.useFakeTimers();
	ref.current.scrollTo.mockClear();
	ref.current.scrollToEnd.mockClear();
	Object.values(caller).forEach((f) => f.mockClear());
	mockDims = { width: 360, height: 760 };
});
afterEach(() => {
	renderer.act(() => {
		tr.unmount();
	});
	jest.useRealTimers();
	jest.restoreAllMocks();
});

describe("usePreserveScrollOnResize", () => {
	it("P1: at the bottom, a width change then new layout + content size scrolls to end once", async () => {
		await mount();
		layout(600);
		handlers.onContentSizeChange(360, 1000);
		scroll(400); // 400 + 600 = 1000 -> bottom
		await setDims({ width: 760, height: 360 });
		layout(300);
		expect(ref.current.scrollToEnd).not.toHaveBeenCalled(); // waits for content size too
		handlers.onContentSizeChange(760, 900);
		expect(ref.current.scrollToEnd).toHaveBeenCalledTimes(1);
		expect(ref.current.scrollToEnd).toHaveBeenCalledWith({ animated: false });
		jest.advanceTimersByTime(1000);
		expect(ref.current.scrollToEnd).toHaveBeenCalledTimes(1);
	});

	it("P2: mid-list restores the offset clamped to the new range", async () => {
		await mount();
		layout(600);
		handlers.onContentSizeChange(360, 1400);
		scroll(300);
		await setDims({ width: 760, height: 360 });
		layout(300);
		handlers.onContentSizeChange(760, 500); // max = 200
		expect(ref.current.scrollTo).toHaveBeenCalledWith({ y: 200, animated: false });
		expect(ref.current.scrollToEnd).not.toHaveBeenCalled();
	});

	it("P2b: the 300 ms cap applies the restore if an event never arrives", async () => {
		await mount();
		layout(600);
		handlers.onContentSizeChange(360, 1400);
		scroll(300);
		await setDims({ width: 760, height: 360 });
		layout(300);
		await renderer.act(async () => {
			jest.advanceTimersByTime(301);
		});
		expect(ref.current.scrollTo).toHaveBeenCalledTimes(1);
	});

	it("P3: a height-only change triggers nothing", async () => {
		await mount();
		layout(600);
		handlers.onContentSizeChange(360, 1000);
		scroll(400);
		await setDims({ width: 360, height: 400 });
		layout(240);
		handlers.onContentSizeChange(360, 1000);
		jest.advanceTimersByTime(1000);
		expect(ref.current.scrollTo).not.toHaveBeenCalled();
		expect(ref.current.scrollToEnd).not.toHaveBeenCalled();
	});

	it("P4: no dimension change -> no calls; handlers forward to the caller", async () => {
		await mount();
		layout(600);
		handlers.onContentSizeChange(360, 1000);
		scroll(100);
		jest.advanceTimersByTime(1000);
		expect(ref.current.scrollTo).not.toHaveBeenCalled();
		expect(ref.current.scrollToEnd).not.toHaveBeenCalled();
		expect(caller.onLayout).toHaveBeenCalledTimes(1);
		expect(caller.onContentSizeChange).toHaveBeenCalledWith(360, 1000);
		expect(caller.onScroll).toHaveBeenCalledTimes(1);
		expect(handlers.scrollEventThrottle).toBe(16);
	});

	// WR-R6-02: a mid-list state makes the restore branch deterministic (scrollTo), and BOTH scroll
	// methods are asserted, so a fired cap cannot slip through on the method the test did not check.
	async function armMidListRestore() {
		await mount();
		layout(600);
		handlers.onContentSizeChange(360, 1400);
		scroll(300); // 300 + 600 < 1400 -> mid-list
		const baseline = jest.getTimerCount();
		await setDims({ width: 760, height: 360 });
		expect(jest.getTimerCount()).toBeGreaterThan(baseline); // the settle cap is armed
	}

	it("control: without unmount the armed cap fires the restore (the unmount check below is live)", async () => {
		await armMidListRestore();
		await renderer.act(async () => {
			jest.runOnlyPendingTimers();
		});
		expect(ref.current.scrollTo).toHaveBeenCalledTimes(1);
		expect(ref.current.scrollTo).toHaveBeenCalledWith({ y: 300, animated: false });
		expect(ref.current.scrollToEnd).not.toHaveBeenCalled();
	});

	it("leaves no timer running on unmount", async () => {
		await armMidListRestore();
		await renderer.act(async () => {
			tr.unmount();
		});
		jest.runOnlyPendingTimers();
		// Cancelled, never fired: neither restore method is called.
		expect(ref.current.scrollTo).not.toHaveBeenCalled();
		expect(ref.current.scrollToEnd).not.toHaveBeenCalled();
		await renderer.act(async () => {
			tr = renderer.create(<Probe />); // for afterEach
		});
	});
});
