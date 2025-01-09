
export class MakeRange {
	constructor(private first: number, private last: number) { }

	static asArray(first: number, last: number) {
		return Array(...new MakeRange(first, last));
	}
	[Symbol.iterator]() { return this; }

	next() {
		return (this.first < this.last)
			? { value: this.first++, done: false }
			: { value: undefined, done: true };
	}
}
