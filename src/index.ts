#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── ANSI Colors ──

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
};

// ── Types ──

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  unique: boolean;
  references: { table: string; column: string } | null;
}

interface Index {
  name: string;
  columns: string[];
  unique: boolean;
}

interface Constraint {
  name: string;
  type: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK';
  columns: string[];
  references?: { table: string; columns: string[] };
  expression?: string;
}

interface Table {
  name: string;
  columns: Column[];
  indexes: Index[];
  constraints: Constraint[];
}

interface Schema {
  tables: Table[];
}

interface MigrationAction {
  type: 'CREATE_TABLE' | 'DROP_TABLE' | 'ADD_COLUMN' | 'DROP_COLUMN' | 'ALTER_COLUMN' | 'RENAME_COLUMN' | 'ADD_INDEX' | 'DROP_INDEX' | 'ADD_CONSTRAINT' | 'DROP_CONSTRAINT';
  table: string;
  details: string;
  upSql: string;
  downSql: string;
}

interface MigrationResult {
  fromFile: string;
  toFile: string;
  timestamp: string;
  actions: MigrationAction[];
  upMigration: string;
  downMigration: string;
}

// ── SQL Parser ──

function normalizeType(type: string): string {
  return type.toUpperCase().replace(/\s+/g, ' ').trim();
}

function parseColumn(definition: string): Column | null {
  // Clean up the definition
  const def = definition.trim();
  if (!def) return null;

  // Skip constraint-only lines
  const upperDef = def.toUpperCase();
  if (upperDef.startsWith('PRIMARY KEY') ||
      upperDef.startsWith('UNIQUE') ||
      upperDef.startsWith('FOREIGN KEY') ||
      upperDef.startsWith('CHECK') ||
      upperDef.startsWith('CONSTRAINT') ||
      upperDef.startsWith('INDEX') ||
      upperDef.startsWith('KEY ')) {
    return null;
  }

  // Match: column_name TYPE [(size)] [constraints...]
  const match = def.match(/^["'`]?(\w+)["'`]?\s+(\w+(?:\s*\([^)]*\))?(?:\s+\w+)*)/i);
  if (!match) return null;

  const name = match[1];
  const rest = def.substring(match[0].indexOf(match[2]));

  // Extract type (first word after name, potentially with parentheses)
  const typeMatch = rest.match(/^(\w+(?:\s*\([^)]*\))?)/i);
  const type = typeMatch ? normalizeType(typeMatch[1]) : 'TEXT';

  const upperRest = rest.toUpperCase();

  return {
    name,
    type,
    nullable: !upperRest.includes('NOT NULL'),
    defaultValue: extractDefault(rest),
    primaryKey: upperRest.includes('PRIMARY KEY'),
    unique: upperRest.includes('UNIQUE'),
    references: extractReference(rest),
  };
}

function extractDefault(def: string): string | null {
  const match = def.match(/DEFAULT\s+('([^']*)'|"([^"]*)"|(\S+))/i);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

function extractReference(def: string): { table: string; column: string } | null {
  const match = def.match(/REFERENCES\s+["'`]?(\w+)["'`]?\s*\(["'`]?(\w+)["'`]?\)/i);
  if (!match) return null;
  return { table: match[1], column: match[2] };
}

function parseConstraints(lines: string[], tableName: string): Constraint[] {
  const constraints: Constraint[] = [];

  for (const line of lines) {
    const upper = line.toUpperCase().trim();

    // Named constraints
    const namedMatch = line.match(/CONSTRAINT\s+["'`]?(\w+)["'`]?\s+(.*)/i);
    const constraintDef = namedMatch ? namedMatch[2] : line;
    const constraintName = namedMatch ? namedMatch[1] : '';
    const upperCDef = constraintDef.toUpperCase().trim();

    if (upperCDef.startsWith('PRIMARY KEY')) {
      const colMatch = constraintDef.match(/\(([^)]+)\)/);
      if (colMatch) {
        constraints.push({
          name: constraintName || `pk_${tableName}`,
          type: 'PRIMARY KEY',
          columns: colMatch[1].split(',').map(c => c.trim().replace(/["'`]/g, '')),
        });
      }
    } else if (upperCDef.startsWith('UNIQUE')) {
      const colMatch = constraintDef.match(/\(([^)]+)\)/);
      if (colMatch) {
        constraints.push({
          name: constraintName || `uq_${tableName}`,
          type: 'UNIQUE',
          columns: colMatch[1].split(',').map(c => c.trim().replace(/["'`]/g, '')),
        });
      }
    } else if (upperCDef.startsWith('FOREIGN KEY')) {
      const fkMatch = constraintDef.match(/FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+["'`]?(\w+)["'`]?\s*\(([^)]+)\)/i);
      if (fkMatch) {
        constraints.push({
          name: constraintName || `fk_${tableName}`,
          type: 'FOREIGN KEY',
          columns: fkMatch[1].split(',').map(c => c.trim().replace(/["'`]/g, '')),
          references: {
            table: fkMatch[2],
            columns: fkMatch[3].split(',').map(c => c.trim().replace(/["'`]/g, '')),
          },
        });
      }
    } else if (upperCDef.startsWith('CHECK')) {
      const checkMatch = constraintDef.match(/CHECK\s*\((.+)\)/i);
      if (checkMatch) {
        constraints.push({
          name: constraintName || `chk_${tableName}`,
          type: 'CHECK',
          columns: [],
          expression: checkMatch[1],
        });
      }
    }
  }

  return constraints;
}

function parseCreateTable(sql: string): Table | null {
  // Match CREATE TABLE ... ( ... )
  const match = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s*\(([\s\S]+)\)/i);
  if (!match) return null;

  const tableName = match[1];
  const body = match[2];

  // Split body by commas, but respect parentheses
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;

    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  // Separate columns from constraints
  const columns: Column[] = [];
  const constraintLines: string[] = [];

  for (const part of parts) {
    const upper = part.toUpperCase().trim();
    if (upper.startsWith('PRIMARY KEY') ||
        upper.startsWith('UNIQUE') ||
        upper.startsWith('FOREIGN KEY') ||
        upper.startsWith('CHECK') ||
        upper.startsWith('CONSTRAINT') ||
        upper.startsWith('INDEX') ||
        upper.startsWith('KEY ')) {
      constraintLines.push(part);
    } else {
      const col = parseColumn(part);
      if (col) columns.push(col);
    }
  }

  const constraints = parseConstraints(constraintLines, tableName);

  return {
    name: tableName,
    columns,
    indexes: [],
    constraints,
  };
}

function parseCreateIndex(sql: string): { tableName: string; index: Index } | null {
  const match = sql.match(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s+ON\s+["'`]?(\w+)["'`]?\s*\(([^)]+)\)/i);
  if (!match) return null;

  return {
    tableName: match[3],
    index: {
      name: match[2],
      columns: match[4].split(',').map(c => c.trim().replace(/["'`]/g, '').replace(/\s+(ASC|DESC)/i, '')),
      unique: !!match[1],
    },
  };
}

function parseSchema(sql: string): Schema {
  const tables = new Map<string, Table>();

  // Remove comments
  let cleaned = sql.replace(/--[^\n]*/g, '');
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

  // Split by semicolons
  const statements = cleaned.split(';').map(s => s.trim()).filter(Boolean);

  for (const stmt of statements) {
    const upper = stmt.toUpperCase().trim();

    if (upper.startsWith('CREATE TABLE')) {
      const table = parseCreateTable(stmt);
      if (table) {
        tables.set(table.name.toLowerCase(), table);
      }
    } else if (upper.startsWith('CREATE INDEX') || upper.startsWith('CREATE UNIQUE INDEX')) {
      const result = parseCreateIndex(stmt);
      if (result) {
        const table = tables.get(result.tableName.toLowerCase());
        if (table) {
          table.indexes.push(result.index);
        }
      }
    }
  }

  return { tables: Array.from(tables.values()) };
}

// ── Diff Engine ──

function diffSchemas(oldSchema: Schema, newSchema: Schema): MigrationAction[] {
  const actions: MigrationAction[] = [];

  const oldTables = new Map(oldSchema.tables.map(t => [t.name.toLowerCase(), t]));
  const newTables = new Map(newSchema.tables.map(t => [t.name.toLowerCase(), t]));

  // Find dropped tables
  for (const [name, table] of oldTables) {
    if (!newTables.has(name)) {
      const colDefs = table.columns.map(col => {
        let def = `  ${col.name} ${col.type}`;
        if (!col.nullable) def += ' NOT NULL';
        if (col.defaultValue !== null) def += ` DEFAULT ${col.defaultValue}`;
        if (col.primaryKey) def += ' PRIMARY KEY';
        if (col.unique) def += ' UNIQUE';
        return def;
      }).join(',\n');

      actions.push({
        type: 'DROP_TABLE',
        table: table.name,
        details: `Drop table ${table.name}`,
        upSql: `DROP TABLE IF EXISTS ${table.name};`,
        downSql: `CREATE TABLE ${table.name} (\n${colDefs}\n);`,
      });
    }
  }

  // Find new tables
  for (const [name, table] of newTables) {
    if (!oldTables.has(name)) {
      const colDefs = table.columns.map(col => {
        let def = `  ${col.name} ${col.type}`;
        if (!col.nullable) def += ' NOT NULL';
        if (col.defaultValue !== null) def += ` DEFAULT ${col.defaultValue}`;
        if (col.primaryKey) def += ' PRIMARY KEY';
        if (col.unique) def += ' UNIQUE';
        if (col.references) def += ` REFERENCES ${col.references.table}(${col.references.column})`;
        return def;
      }).join(',\n');

      // Add constraints
      const constraintDefs = table.constraints.map(con => {
        if (con.type === 'PRIMARY KEY') return `  PRIMARY KEY (${con.columns.join(', ')})`;
        if (con.type === 'UNIQUE') return `  UNIQUE (${con.columns.join(', ')})`;
        if (con.type === 'FOREIGN KEY' && con.references) {
          return `  FOREIGN KEY (${con.columns.join(', ')}) REFERENCES ${con.references.table}(${con.references.columns.join(', ')})`;
        }
        if (con.type === 'CHECK' && con.expression) return `  CHECK (${con.expression})`;
        return '';
      }).filter(Boolean);

      const allDefs = constraintDefs.length > 0
        ? colDefs + ',\n' + constraintDefs.join(',\n')
        : colDefs;

      actions.push({
        type: 'CREATE_TABLE',
        table: table.name,
        details: `Create table ${table.name} with ${table.columns.length} columns`,
        upSql: `CREATE TABLE ${table.name} (\n${allDefs}\n);`,
        downSql: `DROP TABLE IF EXISTS ${table.name};`,
      });

      // Add indexes for new table
      for (const idx of table.indexes) {
        actions.push({
          type: 'ADD_INDEX',
          table: table.name,
          details: `Add ${idx.unique ? 'unique ' : ''}index ${idx.name} on (${idx.columns.join(', ')})`,
          upSql: `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${idx.name} ON ${table.name} (${idx.columns.join(', ')});`,
          downSql: `DROP INDEX IF EXISTS ${idx.name};`,
        });
      }

      continue;
    }

    // Compare existing tables
    const oldTable = oldTables.get(name)!;
    const oldCols = new Map(oldTable.columns.map(c => [c.name.toLowerCase(), c]));
    const newCols = new Map(table.columns.map(c => [c.name.toLowerCase(), c]));

    // Dropped columns
    for (const [colName, col] of oldCols) {
      if (!newCols.has(colName)) {
        actions.push({
          type: 'DROP_COLUMN',
          table: table.name,
          details: `Drop column ${col.name} (${col.type})`,
          upSql: `ALTER TABLE ${table.name} DROP COLUMN ${col.name};`,
          downSql: `ALTER TABLE ${table.name} ADD COLUMN ${col.name} ${col.type}${!col.nullable ? ' NOT NULL' : ''}${col.defaultValue !== null ? ` DEFAULT ${col.defaultValue}` : ''};`,
        });
      }
    }

    // New columns
    for (const [colName, col] of newCols) {
      if (!oldCols.has(colName)) {
        let def = `${col.name} ${col.type}`;
        if (!col.nullable) def += ' NOT NULL';
        if (col.defaultValue !== null) def += ` DEFAULT ${col.defaultValue}`;
        if (col.unique) def += ' UNIQUE';
        if (col.references) def += ` REFERENCES ${col.references.table}(${col.references.column})`;

        actions.push({
          type: 'ADD_COLUMN',
          table: table.name,
          details: `Add column ${col.name} (${col.type})`,
          upSql: `ALTER TABLE ${table.name} ADD COLUMN ${def};`,
          downSql: `ALTER TABLE ${table.name} DROP COLUMN ${col.name};`,
        });
      }
    }

    // Changed columns
    for (const [colName, newCol] of newCols) {
      const oldCol = oldCols.get(colName);
      if (!oldCol) continue;

      const changes: string[] = [];

      if (normalizeType(oldCol.type) !== normalizeType(newCol.type)) {
        changes.push(`type ${oldCol.type} -> ${newCol.type}`);
      }
      if (oldCol.nullable !== newCol.nullable) {
        changes.push(newCol.nullable ? 'make nullable' : 'make NOT NULL');
      }
      if (oldCol.defaultValue !== newCol.defaultValue) {
        changes.push(`default ${oldCol.defaultValue || 'none'} -> ${newCol.defaultValue || 'none'}`);
      }

      if (changes.length > 0) {
        const alterParts: string[] = [];
        const revertParts: string[] = [];

        if (normalizeType(oldCol.type) !== normalizeType(newCol.type)) {
          alterParts.push(`ALTER TABLE ${table.name} ALTER COLUMN ${newCol.name} TYPE ${newCol.type};`);
          revertParts.push(`ALTER TABLE ${table.name} ALTER COLUMN ${oldCol.name} TYPE ${oldCol.type};`);
        }

        if (oldCol.nullable !== newCol.nullable) {
          if (newCol.nullable) {
            alterParts.push(`ALTER TABLE ${table.name} ALTER COLUMN ${newCol.name} DROP NOT NULL;`);
            revertParts.push(`ALTER TABLE ${table.name} ALTER COLUMN ${oldCol.name} SET NOT NULL;`);
          } else {
            alterParts.push(`ALTER TABLE ${table.name} ALTER COLUMN ${newCol.name} SET NOT NULL;`);
            revertParts.push(`ALTER TABLE ${table.name} ALTER COLUMN ${oldCol.name} DROP NOT NULL;`);
          }
        }

        if (oldCol.defaultValue !== newCol.defaultValue) {
          if (newCol.defaultValue !== null) {
            alterParts.push(`ALTER TABLE ${table.name} ALTER COLUMN ${newCol.name} SET DEFAULT ${newCol.defaultValue};`);
          } else {
            alterParts.push(`ALTER TABLE ${table.name} ALTER COLUMN ${newCol.name} DROP DEFAULT;`);
          }
          if (oldCol.defaultValue !== null) {
            revertParts.push(`ALTER TABLE ${table.name} ALTER COLUMN ${oldCol.name} SET DEFAULT ${oldCol.defaultValue};`);
          } else {
            revertParts.push(`ALTER TABLE ${table.name} ALTER COLUMN ${oldCol.name} DROP DEFAULT;`);
          }
        }

        actions.push({
          type: 'ALTER_COLUMN',
          table: table.name,
          details: `Alter column ${newCol.name}: ${changes.join(', ')}`,
          upSql: alterParts.join('\n'),
          downSql: revertParts.join('\n'),
        });
      }
    }

    // Index changes
    const oldIndexes = new Map(oldTable.indexes.map(i => [i.name.toLowerCase(), i]));
    const newIndexes = new Map(table.indexes.map(i => [i.name.toLowerCase(), i]));

    for (const [idxName, idx] of oldIndexes) {
      if (!newIndexes.has(idxName)) {
        actions.push({
          type: 'DROP_INDEX',
          table: table.name,
          details: `Drop index ${idx.name}`,
          upSql: `DROP INDEX IF EXISTS ${idx.name};`,
          downSql: `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${idx.name} ON ${table.name} (${idx.columns.join(', ')});`,
        });
      }
    }

    for (const [idxName, idx] of newIndexes) {
      if (!oldIndexes.has(idxName)) {
        actions.push({
          type: 'ADD_INDEX',
          table: table.name,
          details: `Add ${idx.unique ? 'unique ' : ''}index ${idx.name} on (${idx.columns.join(', ')})`,
          upSql: `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${idx.name} ON ${table.name} (${idx.columns.join(', ')});`,
          downSql: `DROP INDEX IF EXISTS ${idx.name};`,
        });
      }
    }

    // Constraint changes
    const oldConstraints = new Map(oldTable.constraints.map(c => [c.name.toLowerCase(), c]));
    const newConstraints = new Map(table.constraints.map(c => [c.name.toLowerCase(), c]));

    for (const [cName, con] of oldConstraints) {
      if (!newConstraints.has(cName)) {
        actions.push({
          type: 'DROP_CONSTRAINT',
          table: table.name,
          details: `Drop ${con.type} constraint ${con.name}`,
          upSql: `ALTER TABLE ${table.name} DROP CONSTRAINT IF EXISTS ${con.name};`,
          downSql: buildConstraintSql(table.name, con),
        });
      }
    }

    for (const [cName, con] of newConstraints) {
      if (!oldConstraints.has(cName)) {
        actions.push({
          type: 'ADD_CONSTRAINT',
          table: table.name,
          details: `Add ${con.type} constraint ${con.name}`,
          upSql: buildConstraintSql(table.name, con),
          downSql: `ALTER TABLE ${table.name} DROP CONSTRAINT IF EXISTS ${con.name};`,
        });
      }
    }
  }

  return actions;
}

function buildConstraintSql(tableName: string, con: Constraint): string {
  switch (con.type) {
    case 'PRIMARY KEY':
      return `ALTER TABLE ${tableName} ADD CONSTRAINT ${con.name} PRIMARY KEY (${con.columns.join(', ')});`;
    case 'UNIQUE':
      return `ALTER TABLE ${tableName} ADD CONSTRAINT ${con.name} UNIQUE (${con.columns.join(', ')});`;
    case 'FOREIGN KEY':
      if (con.references) {
        return `ALTER TABLE ${tableName} ADD CONSTRAINT ${con.name} FOREIGN KEY (${con.columns.join(', ')}) REFERENCES ${con.references.table}(${con.references.columns.join(', ')});`;
      }
      return '';
    case 'CHECK':
      return `ALTER TABLE ${tableName} ADD CONSTRAINT ${con.name} CHECK (${con.expression || 'true'});`;
  }
}

// ── Migration Generation ──

function generateMigration(fromFile: string, toFile: string, actions: MigrationAction[]): MigrationResult {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);

  const upStatements = actions.map(a => a.upSql).join('\n\n');
  const downStatements = [...actions].reverse().map(a => a.downSql).join('\n\n');

  const upMigration = `-- Migration: ${timestamp}\n-- Generated by ai-migrate\n-- From: ${fromFile}\n-- To: ${toFile}\n\nBEGIN;\n\n${upStatements}\n\nCOMMIT;\n`;
  const downMigration = `-- Rollback: ${timestamp}\n-- Generated by ai-migrate\n-- Reverts migration from ${toFile} back to ${fromFile}\n\nBEGIN;\n\n${downStatements}\n\nCOMMIT;\n`;

  return {
    fromFile,
    toFile,
    timestamp,
    actions,
    upMigration,
    downMigration,
  };
}

// ── Display ──

function printBanner(): void {
  console.log('');
  console.log(`${c.bgMagenta}${c.white}${c.bold}  AI-MIGRATE  ${c.reset} ${c.magenta}Database Migration Generator${c.reset}`);
  console.log(`${c.dim}  by LXGIC Studios${c.reset}`);
  console.log('');
}

function actionColor(type: string): string {
  if (type.startsWith('CREATE') || type.startsWith('ADD')) return c.green;
  if (type.startsWith('DROP')) return c.red;
  if (type.startsWith('ALTER') || type.startsWith('RENAME')) return c.yellow;
  return c.white;
}

function actionIcon(type: string): string {
  if (type.startsWith('CREATE') || type.startsWith('ADD')) return `${c.green}+${c.reset}`;
  if (type.startsWith('DROP')) return `${c.red}-${c.reset}`;
  if (type.startsWith('ALTER') || type.startsWith('RENAME')) return `${c.yellow}~${c.reset}`;
  return `${c.white}?${c.reset}`;
}

function printMigration(result: MigrationResult, showRollback: boolean, dryRun: boolean): void {
  console.log(`${c.bold}${c.white}Schema Diff:${c.reset} ${c.cyan}${result.fromFile}${c.reset} -> ${c.cyan}${result.toFile}${c.reset}`);
  console.log(`${c.dim}Timestamp: ${result.timestamp}${c.reset}`);
  console.log('');

  if (result.actions.length === 0) {
    console.log(`${c.green}✓ No changes detected. Schemas are identical.${c.reset}`);
    console.log('');
    return;
  }

  // Summary
  const creates = result.actions.filter(a => a.type.startsWith('CREATE') || a.type.startsWith('ADD')).length;
  const drops = result.actions.filter(a => a.type.startsWith('DROP')).length;
  const alters = result.actions.filter(a => a.type.startsWith('ALTER') || a.type.startsWith('RENAME')).length;

  console.log(`${c.bold}Changes:${c.reset} ${c.green}+${creates} additions${c.reset}  ${c.red}-${drops} removals${c.reset}  ${c.yellow}~${alters} modifications${c.reset}`);
  console.log('');

  // Action list
  console.log(`${c.bold}${c.cyan}Actions:${c.reset}`);
  console.log(`  ${c.dim}${'─'.repeat(60)}${c.reset}`);

  for (const action of result.actions) {
    const icon = actionIcon(action.type);
    const ac = actionColor(action.type);
    console.log(`  ${icon} ${ac}${action.type.padEnd(16)}${c.reset} ${c.white}${action.table}${c.reset} ${c.dim}${action.details}${c.reset}`);
  }
  console.log(`  ${c.dim}${'─'.repeat(60)}${c.reset}`);
  console.log('');

  if (dryRun) {
    console.log(`${c.yellow}${c.bold}DRY RUN${c.reset} ${c.dim}(no files written)${c.reset}`);
    console.log('');
  }

  // Up migration
  console.log(`${c.bold}${c.green}UP Migration:${c.reset}`);
  console.log(`${c.dim}${'─'.repeat(60)}${c.reset}`);
  for (const line of result.upMigration.split('\n')) {
    if (line.startsWith('--')) {
      console.log(`${c.dim}${line}${c.reset}`);
    } else if (line.match(/^(CREATE|ALTER|DROP|BEGIN|COMMIT)/i)) {
      console.log(`${c.bold}${c.white}${line}${c.reset}`);
    } else {
      console.log(`${c.white}${line}${c.reset}`);
    }
  }
  console.log('');

  // Down migration
  if (showRollback) {
    console.log(`${c.bold}${c.red}DOWN Migration (Rollback):${c.reset}`);
    console.log(`${c.dim}${'─'.repeat(60)}${c.reset}`);
    for (const line of result.downMigration.split('\n')) {
      if (line.startsWith('--')) {
        console.log(`${c.dim}${line}${c.reset}`);
      } else if (line.match(/^(CREATE|ALTER|DROP|BEGIN|COMMIT)/i)) {
        console.log(`${c.bold}${c.white}${line}${c.reset}`);
      } else {
        console.log(`${c.white}${line}${c.reset}`);
      }
    }
    console.log('');
  }
}

function printHelp(): void {
  printBanner();
  console.log(`${c.bold}Usage:${c.reset} ai-migrate <old-schema.sql> <new-schema.sql> [options]`);
  console.log('');
  console.log(`${c.bold}Options:${c.reset}`);
  console.log(`  ${c.cyan}--dry-run${c.reset}        Show migration without writing files`);
  console.log(`  ${c.cyan}--rollback${c.reset}       Also generate the down (rollback) migration`);
  console.log(`  ${c.cyan}--output <dir>${c.reset}   Directory to write migration files (default: ./migrations)`);
  console.log(`  ${c.cyan}--json${c.reset}           Output results as JSON`);
  console.log(`  ${c.cyan}--help${c.reset}           Show this help message`);
  console.log('');
  console.log(`${c.bold}Examples:${c.reset}`);
  console.log(`  ${c.dim}$${c.reset} ai-migrate schema-v1.sql schema-v2.sql`);
  console.log(`  ${c.dim}$${c.reset} ai-migrate old.sql new.sql --rollback --dry-run`);
  console.log(`  ${c.dim}$${c.reset} ai-migrate old.sql new.sql --output ./db/migrations`);
  console.log(`  ${c.dim}$${c.reset} ai-migrate old.sql new.sql --json`);
  console.log('');
  console.log(`${c.bold}Supported SQL:${c.reset}`);
  console.log(`  CREATE TABLE, ALTER TABLE, CREATE INDEX, DROP TABLE`);
  console.log(`  Column types, NOT NULL, DEFAULT, UNIQUE, PRIMARY KEY`);
  console.log(`  FOREIGN KEY references, CHECK constraints`);
  console.log('');
  console.log(`${c.bold}What it detects:${c.reset}`);
  console.log(`  ${c.green}+${c.reset} New tables, columns, indexes, constraints`);
  console.log(`  ${c.red}-${c.reset} Dropped tables, columns, indexes, constraints`);
  console.log(`  ${c.yellow}~${c.reset} Type changes, nullability changes, default changes`);
  console.log('');
}

// ── Main ──

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const jsonOutput = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const showRollback = args.includes('--rollback');

  let outputDir = './migrations';
  const outIdx = args.indexOf('--output');
  if (outIdx !== -1 && args[outIdx + 1]) {
    outputDir = args[outIdx + 1];
  }

  // Find schema files
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (['--output'].includes(args[i])) i++; // skip value
      continue;
    }
    files.push(args[i]);
  }

  if (files.length < 2) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: 'Two SQL schema files are required' }));
    } else {
      console.error(`${c.red}${c.bold}Error:${c.reset} Please provide two SQL schema files to compare.`);
      console.error(`${c.dim}Usage: ai-migrate old-schema.sql new-schema.sql${c.reset}`);
    }
    process.exit(1);
  }

  const fromFile = path.resolve(files[0]);
  const toFile = path.resolve(files[1]);

  // Validate files exist
  if (!fs.existsSync(fromFile)) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: `File not found: ${fromFile}` }));
    } else {
      console.error(`${c.red}${c.bold}Error:${c.reset} File not found: ${fromFile}`);
    }
    process.exit(1);
  }

  if (!fs.existsSync(toFile)) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: `File not found: ${toFile}` }));
    } else {
      console.error(`${c.red}${c.bold}Error:${c.reset} File not found: ${toFile}`);
    }
    process.exit(1);
  }

  if (!jsonOutput) printBanner();

  try {
    const fromSql = fs.readFileSync(fromFile, 'utf-8');
    const toSql = fs.readFileSync(toFile, 'utf-8');

    const oldSchema = parseSchema(fromSql);
    const newSchema = parseSchema(toSql);

    if (!jsonOutput) {
      console.log(`${c.dim}Parsed ${oldSchema.tables.length} table(s) from ${files[0]}${c.reset}`);
      console.log(`${c.dim}Parsed ${newSchema.tables.length} table(s) from ${files[1]}${c.reset}`);
      console.log('');
    }

    const actions = diffSchemas(oldSchema, newSchema);
    const result = generateMigration(files[0], files[1], actions);

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }

    printMigration(result, showRollback, dryRun);

    // Write files unless dry-run
    if (!dryRun && actions.length > 0) {
      fs.mkdirSync(outputDir, { recursive: true });

      const upFile = path.join(outputDir, `${result.timestamp}_up.sql`);
      fs.writeFileSync(upFile, result.upMigration);
      console.log(`${c.green}✓${c.reset} Wrote: ${c.cyan}${upFile}${c.reset}`);

      if (showRollback) {
        const downFile = path.join(outputDir, `${result.timestamp}_down.sql`);
        fs.writeFileSync(downFile, result.downMigration);
        console.log(`${c.green}✓${c.reset} Wrote: ${c.cyan}${downFile}${c.reset}`);
      }
      console.log('');
    }
  } catch (err: any) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: err.message }));
    } else {
      console.error(`${c.red}${c.bold}Error:${c.reset} ${err.message}`);
    }
    process.exit(1);
  }
}

main();
