import type { ReleaseKeyTask, SignatureTask, SignatureResult } from './models';

export interface IOnboardingTasksEngine {
	getCompletedOnboardingTasks: () => Promise<string[]>;
	setOnboardingTaskCompleted: (taskId: string) => Promise<void>;
}

export interface IKeysTasksEngine {
	completeKeyRelease: (
		task: ReleaseKeyTask
		//keyShares: FinalShareData
	) => Promise<void>;
	getKeysToRelease: (pending: boolean) => Promise<ReleaseKeyTask[]>;
}

export interface ISignatureTasksEngine {
	completeSignature: (
		task: SignatureTask,
		result: SignatureResult
	) => Promise<void>;
	getRequestedSignatures: (pending: boolean) => Promise<SignatureTask[]>;
}
