/**
 * Shared AST extraction layer for QSQL → * transpilers
 *    handles declare schema + create table statements
 *    snake_case normalization
 *    SQL type → canonical AttributeType mapping
 *    table/column/PK extraction
 *    relation inference from _id columns
 */

import type {
	ColumnConstraint,
	CreateTableStmt,
	DeclareSchemaStmt,
	Statement
} from '@quereus/quereus/parser';

export type AttributeType = 'string' | 'integer' | 'boolean' | 'datetime-tz';

export interface ColumnInfo {
  name: string;
  type: AttributeType;
  originalName: string;
}

export interface TableInfo {
  name: string;
  originalName: string;
  columns: ColumnInfo[];
  primaryKeyColumns: string[];
}

export interface RelationInfo {
  name: string;
  roles: string[];
}

export interface TranspiledSchema {
  attributes: Map<string, AttributeType>;
  tables: TableInfo[];
  relations: RelationInfo[];
  playsByEntity: Map<string, Set<string>>;
}

export const TYPE_MAP: Record<string, AttributeType> = {
  text: 'string',
  string: 'string',
  integer: 'integer',
  int: 'integer',
  bigint: 'integer',
  boolean: 'boolean',
  bool: 'boolean',
  datetime: 'datetime-tz',
  'datetime-tz': 'datetime-tz',
};

export function buildTranspiledSchema(statements: Statement[]): TranspiledSchema {
  const tables = extractTables(statements);
  const attributes = collectAttributes(tables);
  const { relations, playsByEntity } = inferRelations(tables);

  return {
    attributes,
    tables,
    relations,
    playsByEntity,
  };
}

function extractTables(statements: Statement[]): TableInfo[] {
  const tableStmts: CreateTableStmt[] = [];

  for (const stmt of statements) {
    if (stmt.type === 'declareSchema') {
      tableStmts.push(...extractDeclaredTables(stmt));
      continue;
    }

    if (stmt.type === 'createTable') {
      tableStmts.push(stmt);
    }
  }

  return tableStmts.map(toTableInfo);
}

function extractDeclaredTables(stmt: DeclareSchemaStmt): CreateTableStmt[] {
  const tables: CreateTableStmt[] = [];
  for (const item of stmt.items) {
    if (item.type === 'declaredTable') {
      tables.push(item.tableStmt);
    }
  }
  return tables;
}

function toTableInfo(table: CreateTableStmt): TableInfo {
  const name = toSnakeCase(table.table.name);
  const columns = table.columns.map((column) => ({
    name: toSnakeCase(column.name),
    type: mapDataType(column.dataType),
    originalName: column.name,
  }));

  const primaryKeyColumns = extractPrimaryKeyColumns(table, columns);

  return {
    name,
    originalName: table.table.name,
    columns,
    primaryKeyColumns,
  };
}

function extractPrimaryKeyColumns(table: CreateTableStmt, columns: ColumnInfo[]): string[] {
  const columnPkNames = table.columns
    .filter((column) => hasColumnPrimaryKey(column.constraints))
    .map((column) => toSnakeCase(column.name));

  const tablePkConstraint = table.constraints.find((constraint) => constraint.type === 'primaryKey');
  const tablePkNames = tablePkConstraint?.columns?.map((col) => toSnakeCase(col.name)) ?? [];

  if (tablePkNames.length > 0) {
    return tablePkNames;
  }

  if (columnPkNames.length > 0) {
    return columnPkNames;
  }

  return [];
}

function hasColumnPrimaryKey(constraints: ColumnConstraint[]): boolean {
  return constraints.some((constraint) => constraint.type === 'primaryKey');
}

function collectAttributes(tables: TableInfo[]): Map<string, AttributeType> {
  const attributes = new Map<string, AttributeType>();

  for (const table of tables) {
    const needsSurrogateKey = table.primaryKeyColumns.length !== 1;
    if (needsSurrogateKey) {
      const keyName = `${table.name}_key`;
      upsertAttribute(attributes, keyName, 'string');
    }

    for (const column of table.columns) {
      upsertAttribute(attributes, column.name, column.type);
    }
  }

  return attributes;
}

function inferRelations(tables: TableInfo[]): {
  relations: RelationInfo[];
  playsByEntity: Map<string, Set<string>>;
} {
  const relationsByName = new Map<string, RelationInfo>();
  const playsByEntity = new Map<string, Set<string>>();
  const tableNames = tables.map((table) => table.name);

  for (const table of tables) {
    for (const column of table.columns) {
      const relationTarget = inferRelationTarget(column.name, tableNames);
      if (!relationTarget || relationTarget === table.name) {
        continue;
      }

      const roleTarget = column.name.replace(/_id$/, '');
      const relationName = `${table.name}_${roleTarget}`;
      const roles = [table.name, roleTarget];

      const relation = relationsByName.get(relationName) ?? {
        name: relationName,
        roles: [],
      };

      relation.roles = Array.from(new Set([...relation.roles, ...roles]));
      relationsByName.set(relationName, relation);

      registerPlay(playsByEntity, table.name, `${relationName}:${table.name}`);
      registerPlay(playsByEntity, relationTarget, `${relationName}:${roleTarget}`);
    }
  }

  return {
    relations: Array.from(relationsByName.values()),
    playsByEntity,
  };
}

function inferRelationTarget(columnName: string, tableNames: string[]): string | null {
  if (!columnName.endsWith('_id')) {
    return null;
  }

  const remainder = columnName.replace(/_id$/, '');

  if (tableNames.includes(remainder)) {
    return remainder;
  }

  let bestMatch: string | null = null;
  for (const tableName of tableNames) {
    if (remainder.endsWith(tableName)) {
      if (!bestMatch || tableName.length > bestMatch.length) {
        bestMatch = tableName;
      }
    }
  }

  return bestMatch;
}

function registerPlay(map: Map<string, Set<string>>, entity: string, play: string): void {
  const plays = map.get(entity) ?? new Set<string>();
  plays.add(play);
  map.set(entity, plays);
}

export function mapDataType(dataType?: string): AttributeType {
  if (!dataType) {
    return 'string';
  }

  const normalized = dataType.trim().toLowerCase();
  const token = normalized.split(/[\s(]/)[0];
  return TYPE_MAP[token] ?? 'string';
}

export function upsertAttribute(map: Map<string, AttributeType>, name: string, type: AttributeType): void {
  const existing = map.get(name);
  if (!existing) {
    map.set(name, type);
    return;
  }

  if (existing !== type) {
    map.set(name, 'string');
  }
}

export function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}
