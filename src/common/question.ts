export interface Option {
	/** The option code */
	code: string;

	/** The option description */
	description: string;

	/** Details about the option */
	details?: string;

	/** Additional information link */
	infoURL?: string;

	/** Additional information data */
	infoCID?: string;
}

export interface Question {
	/** The slot code on the election describing the position, role, or question filled by this question */
	code: string;

	/** Markdown describing the position, role, or question to be filled by the eventual election */
	description: string;

	/** Markdown instructions for this question. */
	instructions: string;

	dependsOn?: {
		/** The question code that this question depends on */
		code: string;

		/** The answer value(s) to the question that this question depends on */
		valuesExpression?: string;
	};

	/** The options to be selected from or ranked - must have at least one entry for a select or rank question */
	options: Option[];

	/** Type of question. Default: 'select'	*/
	type: 'select' | 'rank' | 'score' | 'text';

	/** minimum and maximum number of options to select from or rank (default 1 and 1) */
	optionRange?: { min: number; max: number; };

	/** Preserve the order of the options (default false) */
	optionsOrdered?: boolean;

	/** The range and step of scores that can be given */
	scoreRange?: { min: number; max: number; step: number; };

	/** The grouping (hierarchy) containing the question */
	group?: string;

	/** The sequence of the question within the group */
	sequence?: number;

	/** Required.  Default: true. */
	required?: boolean;
}
