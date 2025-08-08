import type { Database } from '@quereus/quereus';
import type { User } from '@votetorrent/vote-core';

export type EngineContext = {
	db: Database;
	config: EngineConfig;
	user: User;
};

export type EngineConfig = {
	invitationSpanMinutes: number;
};
