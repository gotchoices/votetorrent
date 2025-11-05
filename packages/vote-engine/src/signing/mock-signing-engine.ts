import { ISigningEngine, Officer } from '@votetorrent/vote-core';

export class MockSigningEngine implements ISigningEngine {
	constructor() {}

	startSigningSession(
		officer: Officer,
		digest: string,
		key: string,
		signature: string
	): Promise<void> {
		throw new Error('Method not implemented.');
	}

	sign(
		nonce: string,
		officer: Officer,
		key: string,
		signature: string
	): Promise<void> {
		throw new Error('Method not implemented.');
	}
}
