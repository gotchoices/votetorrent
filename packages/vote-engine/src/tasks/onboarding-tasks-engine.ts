import type { IOnboardingTasksEngine } from '@votetorrent/vote-core';

export class OnboardingTasksEngine implements IOnboardingTasksEngine {
	constructor() {}

	async getCompletedOnboardingTasks(): Promise<string[]> {
		throw new Error('Not implemented');
	}

	async setOnboardingTaskCompleted(taskId: string): Promise<void> {
		throw new Error('Not implemented');
	}
}
