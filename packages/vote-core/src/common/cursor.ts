export type Cursor<T> = {
	buffer: T[];
	offset: number;
	firstBOF: boolean;
	lastEOF: boolean;
}
