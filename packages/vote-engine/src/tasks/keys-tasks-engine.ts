import type { IKeysTasksEngine, ReleaseKeyTask } from '@votetorrent/vote-core';
import type { FinalShareData } from '../../../vinz/dist/src/internal-types';

export class KeysTasksEngine implements IKeysTasksEngine {
	constructor() {}

	async completeKeyRelease(
		task: ReleaseKeyTask,
		keyShares: FinalShareData
	): Promise<void> {
		throw new Error('Not implemented');
	}

	async getKeysToRelease(pending: boolean): Promise<ReleaseKeyTask[]> {
		throw new Error('Not implemented');
	}
}
