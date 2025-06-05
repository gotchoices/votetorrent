import { OnboardingTasksEngine } from './onboarding-tasks-engine';

export class MockOnboardingTasksEngine extends OnboardingTasksEngine {
	async getCompletedOnboardingTasks(): Promise<string[]> {
		return [];
	}

	async setOnboardingTaskCompleted(taskId: string): Promise<void> {
		return;
	}
}
