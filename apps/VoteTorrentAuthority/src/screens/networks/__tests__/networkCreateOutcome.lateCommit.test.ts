import { awaitLateCommit, LATE_COMMIT_BUDGET_MS } from "../networkCreateOutcome";

describe("awaitLateCommit", () => {
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it("yields landed with the resolved value when the commit resolves inside the budget", async () => {
		const commit = new Promise<string>((resolve) => setTimeout(() => resolve("engine"), 30_000));
		const outcome = awaitLateCommit(commit, LATE_COMMIT_BUDGET_MS);
		await jest.advanceTimersByTimeAsync(30_000);
		await expect(outcome).resolves.toEqual({ status: "landed", value: "engine" });
		expect(jest.getTimerCount()).toBe(0);
	});

	it("yields failed with the same error object and never throws", async () => {
		const err = new Error("boom");
		const commit = Promise.reject(err);
		await expect(awaitLateCommit(commit, LATE_COMMIT_BUDGET_MS)).resolves.toEqual({
			status: "failed",
			error: err,
		});
		const outcome = await awaitLateCommit(Promise.reject(err), 1000);
		expect((outcome as { error: unknown }).error).toBe(err);
		expect(jest.getTimerCount()).toBe(0);
	});

	it("yields budget-exhausted when the commit is still pending at the budget", async () => {
		const commit = new Promise<string>(() => undefined);
		const outcome = awaitLateCommit(commit, 5000);
		await jest.advanceTimersByTimeAsync(5000);
		await expect(outcome).resolves.toEqual({ status: "budget-exhausted" });
		expect(jest.getTimerCount()).toBe(0);
	});

	it("budget is 10 minutes", () => {
		expect(LATE_COMMIT_BUDGET_MS).toBe(600000);
	});
});
