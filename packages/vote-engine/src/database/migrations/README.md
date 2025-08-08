# Database Migrations

This directory contains database migration files for the VoteTorrent application.

## Migration File Format

Migration files should follow the naming convention:

```
{version}_{description}.sql
```

Example: `001_initial_schema.sql`

## Migration Structure

Each migration file should contain:

1. **Up Migration**: SQL statements to apply the migration
2. **Down Migration**: SQL statements to rollback the migration

Example:

```sql
-- Up Migration
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE
);

-- Down Migration
DROP TABLE users;
```

## Running Migrations

Migrations are automatically run when the database is initialized, but can also be run manually:

```typescript
import { QuereusDatabase } from "../quereus-database";

const db = new QuereusDatabase();
await db.initialize();
await db.runMigrations();
```

## Migration Best Practices

1. **Always include both up and down migrations**
2. **Test migrations before committing**
3. **Use descriptive names for migration files**
4. **Keep migrations small and focused**
5. **Never modify existing migration files**
6. **Always backup before running migrations**

## Current Migrations

- `001_initial_schema.sql` - Initial VoteTorrent schema setup
