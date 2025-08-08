import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Schema loader utility for loading SQL schema files from vote-core
 */
export class SchemaLoader {
	private static readonly SCHEMA_PATH = '../../vote-core/schema';

	/**
	 * Load a schema file by name
	 */
	static loadSchema(schemaName: string): string {
		try {
			const schemaPath = join(__dirname, this.SCHEMA_PATH, `${schemaName}.sql`);
			return readFileSync(schemaPath, 'utf-8');
		} catch (error) {
			throw new Error(`Failed to load schema ${schemaName}: ${error}`);
		}
	}

	/**
	 * Parse SQL schema and extract table definitions
	 */
	static parseTableDefinitions(sql: string): TableDefinition[] {
		const tableDefinitions: TableDefinition[] = [];
		const lines = sql.split('\n');
		let currentTable: Partial<TableDefinition> | null = null;
		let inTableDefinition = false;

		for (const line of lines) {
			const trimmedLine = line.trim();

			// Skip empty lines and comments
			if (!trimmedLine || trimmedLine.startsWith('--')) {
				continue;
			}

			// Check for table creation
			if (trimmedLine.toLowerCase().startsWith('create table')) {
				if (currentTable) {
					tableDefinitions.push(currentTable as TableDefinition);
				}

				const tableName = this.extractTableName(trimmedLine);
				currentTable = {
					name: tableName,
					columns: [],
					constraints: [],
					sql: trimmedLine,
				};
				inTableDefinition = true;
				continue;
			}

			// Check for view creation
			if (trimmedLine.toLowerCase().startsWith('create view')) {
				if (currentTable) {
					tableDefinitions.push(currentTable as TableDefinition);
				}

				const viewName = this.extractViewName(trimmedLine);
				currentTable = {
					name: viewName,
					type: 'view',
					columns: [],
					constraints: [],
					sql: trimmedLine,
				};
				inTableDefinition = true;
				continue;
			}

			// Parse columns and constraints
			if (inTableDefinition && currentTable) {
				if (trimmedLine.startsWith(')') || trimmedLine.endsWith(';')) {
					// End of table definition
					if (currentTable.sql) {
						currentTable.sql += '\n' + trimmedLine;
					}
					tableDefinitions.push(currentTable as TableDefinition);
					currentTable = null;
					inTableDefinition = false;
				} else {
					// Continue building the table definition
					if (currentTable.sql) {
						currentTable.sql += '\n' + trimmedLine;
					}

					// Parse column or constraint
					this.parseColumnOrConstraint(trimmedLine, currentTable);
				}
			}
		}

		// Add the last table if exists
		if (currentTable) {
			tableDefinitions.push(currentTable as TableDefinition);
		}

		return tableDefinitions;
	}

	/**
	 * Extract table name from CREATE TABLE statement
	 */
	private static extractTableName(createTableLine: string): string {
		const match = createTableLine.match(/create\s+table\s+(\w+)/i);
		return match ? match[1] ?? '' : '';
	}

	/**
	 * Extract view name from CREATE VIEW statement
	 */
	private static extractViewName(createViewLine: string): string {
		const match = createViewLine.match(/create\s+view\s+(\w+)/i);
		return match ? match[1] ?? '' : '';
	}

	/**
	 * Parse a line as either a column or constraint
	 */
	private static parseColumnOrConstraint(
		line: string,
		table: Partial<TableDefinition>
	): void {
		const trimmedLine = line.trim();

		// Skip empty lines
		if (!trimmedLine) {
			return;
		}

		// Check if it's a constraint
		if (
			trimmedLine.toLowerCase().includes('constraint') ||
			trimmedLine.toLowerCase().includes('primary key') ||
			trimmedLine.toLowerCase().includes('foreign key') ||
			trimmedLine.toLowerCase().includes('check')
		) {
			table.constraints = table.constraints || [];
			table.constraints.push(trimmedLine);
		} else {
			// Assume it's a column definition
			const columnName = this.extractColumnName(trimmedLine);
			if (columnName) {
				table.columns = table.columns || [];
				table.columns.push({
					name: columnName,
					definition: trimmedLine,
				});
			}
		}
	}

	/**
	 * Extract column name from column definition
	 */
	private static extractColumnName(columnLine: string): string {
		const match = columnLine.match(/^(\w+)/);
		return match ? match[1] ?? '' : '';
	}

	/**
	 * Validate schema syntax
	 */
	static validateSchema(sql: string): ValidationResult {
		const errors: string[] = [];
		const warnings: string[] = [];

		// Basic validation checks
		const lines = sql.split('\n');
		let braceCount = 0;
		let inString = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			const trimmedLine = line.trim();

			// Skip empty lines and comments
			if (!trimmedLine || trimmedLine.startsWith('--')) {
				continue;
			}

			// Check for balanced parentheses
			for (const char of line) {
				if (char === "'" && !inString) {
					inString = true;
				} else if (char === "'" && inString) {
					inString = false;
				} else if (!inString) {
					if (char === '(') {
						braceCount++;
					} else if (char === ')') {
						braceCount--;
					}
				}
			}

			// Check for common SQL syntax issues
			if (
				trimmedLine.toLowerCase().includes('create table') &&
				!trimmedLine.includes('(')
			) {
				warnings.push(
					`Line ${
						i + 1
					}: CREATE TABLE statement should be followed by column definitions`
				);
			}

			if (
				trimmedLine.toLowerCase().includes('primary key') &&
				!trimmedLine.includes('(')
			) {
				warnings.push(
					`Line ${i + 1}: PRIMARY KEY constraint should specify columns`
				);
			}
		}

		if (braceCount !== 0) {
			errors.push('Unbalanced parentheses in SQL schema');
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings,
		};
	}
}

/**
 * Table definition interface
 */
export interface TableDefinition {
	name: string;
	type?: 'table' | 'view';
	columns: ColumnDefinition[];
	constraints: string[];
	sql: string;
}

/**
 * Column definition interface
 */
export interface ColumnDefinition {
	name: string;
	definition: string;
}

/**
 * Validation result interface
 */
export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}
