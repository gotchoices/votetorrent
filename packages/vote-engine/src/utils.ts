//sql data validation helpers
export const asText = (value: unknown, field: string): string => {
	if (value === null || value === undefined) {
		throw new Error(`${field} is null or undefined`);
	}
	return value.toString();
};

export const asNumberOr = (
	value: unknown,
	defaultValue: number,
	field: string
): number => {
	if (value === null || value === undefined) return defaultValue;
	const n = Number(value);
	if (Number.isNaN(n)) {
		throw new Error(`${field} is not a number`);
	}
	return n;
};

export const parseJsonOr = <T>(
	value: unknown,
	defaultValue: T,
	field: string
): T => {
	if (value === null || value === undefined) return defaultValue;
	try {
		return JSON.parse(value.toString()) as T;
	} catch {
		throw new Error(`${field} has invalid JSON`);
	}
};
