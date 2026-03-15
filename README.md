# ai-migrate

[![npm version](https://img.shields.io/npm/v/@lxgicstudios/ai-migrate.svg)](https://www.npmjs.com/package/@lxgicstudios/ai-migrate)
[![npm downloads](https://img.shields.io/npm/dm/@lxgicstudios/ai-migrate.svg)](https://www.npmjs.com/package/@lxgicstudios/ai-migrate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Generate database migration SQL from schema diffs. Compare SQL schema files and produce ALTER TABLE statements automatically.

## What it does

Point it at two SQL schema files (old vs new), and it spits out the migration SQL you need. No more writing ALTER TABLE statements by hand.

- Detects column additions, removals, and type changes
- Generates ALTER TABLE, ADD COLUMN, DROP COLUMN statements
- Supports PostgreSQL, MySQL, and SQLite syntax
- Produces rollback migrations automatically
- Zero external dependencies

## Install

```bash
npx @lxgicstudios/ai-migrate
```

Or install globally:

```bash
npm install -g @lxgicstudios/ai-migrate
```

## Usage

```bash
# Compare two schema files
npx @lxgicstudios/ai-migrate --from schema-old.sql --to schema-new.sql

# Output to file
npx @lxgicstudios/ai-migrate --from old.sql --to new.sql --output migration.sql

# Generate rollback too
npx @lxgicstudios/ai-migrate --from old.sql --to new.sql --rollback

# Specify dialect
npx @lxgicstudios/ai-migrate --from old.sql --to new.sql --dialect postgres
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--from` | Old schema file | Required |
| `--to` | New schema file | Required |
| `--output` | Output migration file | stdout |
| `--rollback` | Generate rollback migration | false |
| `--dialect` | SQL dialect (postgres, mysql, sqlite) | postgres |
| `--dry-run` | Preview without writing | false |

## Example

**Old schema (v1.sql):**
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL
);
```

**New schema (v2.sql):**
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Output:**
```sql
-- Migration: v1 -> v2
ALTER TABLE users ADD COLUMN name VARCHAR(100);
ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT NOW();
```

## Supported Changes

- ADD COLUMN
- DROP COLUMN
- ALTER COLUMN type
- ADD/DROP INDEX
- ADD/DROP CONSTRAINT
- RENAME COLUMN (when detectable)

## FAQ

**Does it handle foreign keys?**
Yes. It detects FK constraints and orders DROP/ADD statements correctly to avoid constraint violations.

**Can I use it in CI/CD?**
Absolutely. Use `--dry-run` to validate schema changes, or pipe output directly to your migration runner.

**What about data migrations?**
This tool handles schema DDL only. For data migrations (UPDATE statements, backfills), you'll need custom scripts.

## License

MIT


---

Built by [LXGIC Studios](https://github.com/LXGIC-Studios)

🔗 [GitHub](https://github.com/LXGIC-Studios) · [Twitter](https://x.com/lxgicstudios)

💡 Want more free tools like this? We have 100+ on our GitHub: [github.com/lxgicstudios](https://github.com/lxgicstudios)
