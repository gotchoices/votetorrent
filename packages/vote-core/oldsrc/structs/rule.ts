/* eslint-disable @typescript-eslint/no-explicit-any */
export type RuleResponse = {
	passed: boolean;
	message: string;
}

export type RuleResult = {
	name: string;
	passed: boolean;
	message: string;
}

export type RuleFunc = (...args: any[]) => Promise<RuleResponse> | RuleResponse;

export class Rule<TF extends RuleFunc> {
	constructor(
		public readonly name: string,
		public readonly test: TF,
		public readonly options: {
			dependencies?: string[],
			condition?: (...args: Parameters<TF>) => boolean,
		} = {}
	) {}
}

export class RuleSet<TF extends RuleFunc> {
	constructor(
		public readonly rules: Rule<TF>[],
	) {}

	private async evaluateRule(rule: Rule<TF>, results: Map<string, RuleResult | null>, ...args: Parameters<TF>): Promise<RuleResult | null> {
		// Check if this rule's dependencies have been evaluated
		if (rule.options?.dependencies) {
			for (const depName of rule.options.dependencies) {
				if (!results.has(depName)) {
					const depRule = this.rules.find(r => r.name === depName);
					if (depRule) {
						const depResult = await this.evaluateRule(depRule, results, ...args);
						results.set(depName, depResult);
						if (depResult && !depResult.passed) {
							return {
								name: rule.name,
								passed: false,
								message: `Dependency failed: ${depName}`,
							};
						}
					} else {
						return {
							name: rule.name,
							passed: false,
							message: `Missing dependency: ${depName}`,
						};
					}
				} else if (!results.get(depName)) {	// If the dependency was skipped, skip this rule as well
					return null;
				}
			}
		}

		// Check the condition if it exists
		if (rule.options?.condition && !rule.options.condition(...args)) {
			return null;
		}

		// Run the rule test
		try {
			const { passed, message } = await rule.test(...args);
			return { name: rule.name, passed, message };
		} catch (error) {
			return {
				name: rule.name,
				passed: false,
				message: `Error: ${error}`,
			};
		}
	}

	public async run(...args: Parameters<TF>): Promise<RuleResult[]> {
		const results = new Map<string, RuleResult | null>();

		for (const rule of this.rules) {
			if (!results.has(rule.name)) {
				const result = await this.evaluateRule(rule, results, ...args);
				results.set(rule.name, result);
			}
		}

		// Filter out null results (rules that were skipped)
		return Array.from(results.values()).filter((result): result is RuleResult => result !== null);
	}

	public async runAndCheck(...args: Parameters<TF>): Promise<void> {
		const results = await this.run(...args);
		checkRules(results);
	}
}

/** Throws appropriate rule messages if any of the rules failed. */
export function checkRules(rules: RuleResult[]): void {
	const failedRules = rules.filter((rule) => !rule.passed);
	if (failedRules.length > 0) {
		throw new Error(failedRules.map((rule) => rule.message).join("\r\n"));
	}
}
