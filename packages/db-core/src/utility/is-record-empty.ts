/** True if the given object has no keys.  This should not be used for classes or objects with proto fields. */
export function isRecordEmpty<T>(record: Record<string, T>): boolean {
	for (const key in record) return false;
	return true;
}
