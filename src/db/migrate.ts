import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { getDatabaseConfig } from '../config/database.config';

const pool = new Pool(getDatabaseConfig());

const MIGRATIONS_TABLE = 'migrations';

async function ensureMigrationsTable() {
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await pool.query(createTableSql);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const res = await pool.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE};`);
  return new Set(res.rows.map((row) => row.name));
}

function getMigrationsDir(): string {
  return path.join(__dirname, '..', '..', 'migrations');
}

function loadMigrationFiles(): string[] {
  const migrationsDir = getMigrationsDir();

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  return files;
}

async function runMigrationFile(fileName: string) {
  const migrationsDir = getMigrationsDir();
  const filePath = path.join(migrationsDir, fileName);
  const sql = fs.readFileSync(filePath, 'utf8');
  const noTransaction = fileName.includes('.notx.');

  console.log(`➡️  Running migration: ${fileName}${noTransaction ? ' (no transaction)' : ''}`);

  if (noTransaction) {
    // Migrations like CREATE INDEX CONCURRENTLY cannot run in a transaction
    try {
      await pool.query(sql);
      await pool.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1) ON CONFLICT (name) DO NOTHING;`,
        [fileName]
      );
      console.log(`✅ Migration completed: ${fileName}`);
    } catch (err) {
      console.error(`❌ Migration failed: ${fileName}`);
      console.error(err);
      throw err;
    }
  } else {
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1) ON CONFLICT (name) DO NOTHING;`,
        [fileName]
      );
      await pool.query('COMMIT');
      console.log(`✅ Migration completed: ${fileName}`);
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error(`❌ Migration failed: ${fileName}`);
      console.error(err);
      throw err;
    }
  }
}

async function runMigrations() {
  try {
    console.log('🔗 Connecting to database...');
    await ensureMigrationsTable();

    const applied = await getAppliedMigrations();
    const files = loadMigrationFiles();

    console.log(`📦 Found ${files.length} migration(s).`);
    console.log(
      `📚 Already applied: ${applied.size > 0 ? Array.from(applied).join(', ') : 'none'}`
    );

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`↩️  Skipping already applied migration: ${file}`);
        continue;
      }
      await runMigrationFile(file);
    }

    console.log('🎉 All migrations completed.');
  } finally {
    await pool.end();
  }
}

// Run as a script
runMigrations().catch((err) => {
  console.error('❌ Migration process failed:', err);
  process.exit(1);
});
