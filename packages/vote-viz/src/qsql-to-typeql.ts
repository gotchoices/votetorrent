/**
 * AST → TypeQL schema transpiler
 */

import type { Statement } from '@quereus/quereus/parser';
import {
  buildTranspiledSchema,
  type TranspiledSchema,
} from './qsql-transpilation.js';

export type { AttributeType, ColumnInfo, TableInfo, RelationInfo, TranspiledSchema } from './qsql-transpilation.js';

export { buildTranspiledSchema } from './qsql-transpilation.js';

export function transpileQuereusAstToTypeql(statements: Statement[]): string {
  const schema = buildTranspiledSchema(statements);
  return renderTypeql(schema);
}


function renderTypeql(schema: TranspiledSchema): string {
  const lines: string[] = ['define', ''];

  lines.push('# ATTRIBUTE TYPES');
  for (const [name, type] of schema.attributes) {
    lines.push(`attribute ${name}, value ${type};`);
  }

  lines.push('', '# ENTITY TYPES');
  for (const table of schema.tables) {
    const entityLines: string[] = [];
    const needsSurrogateKey = table.primaryKeyColumns.length !== 1;

    if (needsSurrogateKey) {
      entityLines.push(`owns ${table.name}_key @key`);
    }

    for (const column of table.columns) {
      if (!needsSurrogateKey && table.primaryKeyColumns.includes(column.name)) {
        entityLines.push(`owns ${column.name} @key`);
      } else {
        entityLines.push(`owns ${column.name}`);
      }
    }

    const plays = schema.playsByEntity.get(table.name);
    if (plays) {
      for (const play of plays) {
        entityLines.push(`plays ${play}`);
      }
    }

    lines.push(`entity ${table.name},`);
    entityLines.forEach((line, idx) => {
      const suffix = idx === entityLines.length - 1 ? ';' : ',';
      lines.push(`  ${line}${suffix}`);
    });
    lines.push('');
  }

  if (schema.relations.length > 0) {
    lines.push('# RELATION TYPES');
    for (const relation of schema.relations) {
      lines.push(`relation ${relation.name},`);
      relation.roles.forEach((role, idx) => {
        const suffix = idx === relation.roles.length - 1 ? ';' : ',';
        lines.push(`  relates ${role}${suffix}`);
      });
      lines.push('');
    }
  }

  return lines.join('\n').trim() + '\n';
}

