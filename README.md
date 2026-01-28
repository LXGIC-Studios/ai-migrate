# ai-migrate

Point it at your ORM schema, get SQL migration files. Supports Prisma, Drizzle, TypeORM, and Sequelize.

## Install

```bash
npm install -g ai-migrate
```

## Usage

```bash
npx ai-migrate --orm prisma --name add_users
```

It'll find your schema files automatically, read them, and generate timestamped UP and DOWN migration SQL files.

```bash
npx ai-migrate --orm drizzle --name add_orders --output ./db/migrations
```

## Setup

```bash
export OPENAI_API_KEY=sk-...
```

## Options

- `--orm <type>` - Which ORM you're using (prisma, drizzle, typeorm, sequelize)
- `--name <name>` - Name for this migration
- `-o, --output <dir>` - Where to put the files (default: ./migrations)
- `-d, --dir <dir>` - Project root to scan for schemas (default: current directory)

## Output

Creates a timestamped folder with `up.sql` and `down.sql`:

```
migrations/
  20240115120000_add_users/
    up.sql
    down.sql
```

Both files include proper guards (IF NOT EXISTS, IF EXISTS) so they're safe to run.

## License

MIT
