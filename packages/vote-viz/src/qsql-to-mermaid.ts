/**
 * AST → Mermaid erDiagram generation (reuses schema extraction from quereus-to-typeql)
 *    entity blocks with typed attributes
 *    PK annotation for primary key columns (surrogate key when composite PK)
 *    FK annotation for _id foreign-key columns
 *    one-to-many relationship lines inferred from _id columns
 */

import type { Statement } from '@quereus/quereus/parser';
import { buildTranspiledSchema, type TranspiledSchema, type AttributeType } from './qsql-transpilation.js';

const MERMAID_TYPE_MAP: Record<AttributeType, string> = {
  string: 'string',
  integer: 'int',
  boolean: 'boolean',
  'datetime-tz': 'datetime',
};

export function transpileQuereusAstToMermaidEr(statements: Statement[]): string {
  const schema = buildTranspiledSchema(statements);
  return renderMermaidErDiagram(schema);
}

function renderMermaidErDiagram(schema: TranspiledSchema): string {
  const lines: string[] = ['erDiagram', ''];

  const fkColumnsByTable = buildFkColumnSet(schema);

  for (const table of schema.tables) {
    const needsSurrogateKey = table.primaryKeyColumns.length !== 1;
    lines.push(`  ${table.name} {`);

    if (needsSurrogateKey) {
      lines.push(`    string ${table.name}_key PK`);
    }

    for (const column of table.columns) {
      const mermaidType = MERMAID_TYPE_MAP[column.type] ?? 'string';
      const isPk = !needsSurrogateKey && table.primaryKeyColumns.includes(column.name);
      const isFk = fkColumnsByTable.get(table.name)?.has(column.name) ?? false;

      let marker = '';
      if (isPk && isFk) {
        marker = ' PK,FK';
      } else if (isPk) {
        marker = ' PK';
      } else if (isFk) {
        marker = ' FK';
      }

      lines.push(`    ${mermaidType} ${column.name}${marker}`);
    }

    lines.push('  }');
    lines.push('');
  }

  if (schema.relations.length > 0) {
    for (const relation of schema.relations) {
      if (relation.roles.length < 2) {
        continue;
      }
      // roles[0] is the FK-holding table (many side), roles[1] is the referenced entity (one side)
      const [many, one] = relation.roles;
      lines.push(`  ${many} }o--|| ${one} : "${relation.name}"`);
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

function buildFkColumnSet(schema: TranspiledSchema): Map<string, Set<string>> {
  const fkColumns = new Map<string, Set<string>>();

  for (const relation of schema.relations) {
    if (relation.roles.length < 2) {
      continue;
    }
    const [manyTable, roleTarget] = relation.roles;
    // The FK column on manyTable is `${roleTarget}_id`
    const fkColName = `${roleTarget}_id`;
    const set = fkColumns.get(manyTable) ?? new Set<string>();
    set.add(fkColName);
    fkColumns.set(manyTable, set);
  }

  return fkColumns;
}
