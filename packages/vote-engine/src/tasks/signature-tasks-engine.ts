import type {
	ISignatureTasksEngine,
	SignatureResult,
	SignatureTask,
} from '@votetorrent/vote-core';

export class SignatureTasksEngine implements ISignatureTasksEngine {
	constructor() {}

	completeSignature(
		task: SignatureTask,
		result: SignatureResult
	): Promise<void> {
		throw new Error('Method not implemented.');
	}
	getRequestedSignatures(pending: boolean): Promise<SignatureTask[]> {
		throw new Error('Method not implemented.');
	}
}
