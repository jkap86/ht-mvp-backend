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
    .filter((file) => file.endsWith('.sql') && /^\d+_/.test(file))
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

// One-time renames from the migration renumbering (084+ duplicates resolved).
// Each entry maps old filename -> new filename. Safe to run repeatedly.
const MIGRATION_RENAMES: Record<string, string> = {
  '084_create_player_news.sql': '085_create_player_news.sql',
  '085_add_draft_constraints.sql': '086_add_draft_constraints.sql',
  '085_add_player_headshots.sql': '087_add_player_headshots.sql',
  '086_add_processing_run_status.sql': '088_add_processing_run_status.sql',
  '087_add_trades_idempotency.sql': '089_add_trades_idempotency.sql',
  '087_create_notification_preferences.sql': '090_create_notification_preferences.sql',
  '088_add_active_league_season.sql': '091_add_active_league_season.sql',
  '088_create_trending_players.sql': '092_create_trending_players.sql',
  '089_create_player_external_ids.sql': '093_create_player_external_ids.sql',
  '089_fix_league_operations_type.sql': '094_fix_league_operations_type.sql',
  '090_backfill_sleeper_external_ids.sql': '095_backfill_sleeper_external_ids.sql',
  '090_fix_waiver_partial_index.sql': '096_fix_waiver_partial_index.sql',
  '091_add_stats_provider_to_league_seasons.sql': '097_add_stats_provider_to_league_seasons.sql',
  '091_create_player_rankings.sql': '098_create_player_rankings.sql',
  '092_add_performance_indexes.sql': '099_add_performance_indexes.sql',
  '093_add_draft_completion_guards.sql': '100_add_draft_completion_guards.sql',
  '093_create_reaction_tables.sql': '101_create_reaction_tables.sql',
  '094_add_league_timezone.sql': '102_add_league_timezone.sql',
  '094_drop_canonical_roster_order_check.sql': '103_drop_canonical_roster_order_check.sql',
  '095_add_composite_indexes_hot_paths.notx.sql': '104_add_composite_indexes_hot_paths.notx.sql',
  '096_add_roster_population_status.sql': '105_add_roster_population_status.sql',
  '097_add_trade_failed_status.sql': '106_add_trade_failed_status.sql',
  '098_add_users_updated_at_trigger.sql': '107_add_users_updated_at_trigger.sql',
  '099_add_missing_fk_indexes.sql': '108_add_missing_fk_indexes.sql',
  '100_add_overnight_pause_to_drafts.sql': '109_add_overnight_pause_to_drafts.sql',
  '101_add_chat_search_indexes_simple.sql': '110_add_chat_search_indexes_simple.sql',
  '101_add_chat_search_indexes.sql': '110_add_chat_search_indexes_simple.sql',
  '102_add_matchups_draft_support.sql': '111_add_matchups_draft_support.sql',
  '103_fix_auction_roster_cascade.sql': '112_fix_auction_roster_cascade.sql',
  '104_remove_redundant_username_index.sql': '113_remove_redundant_username_index.sql',
};

async function applyMigrationRenames() {
  let renamed = 0;
  for (const [oldName, newName] of Object.entries(MIGRATION_RENAMES)) {
    const result = await pool.query(
      `UPDATE ${MIGRATIONS_TABLE} SET name = $1 WHERE name = $2 AND NOT EXISTS (SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE name = $1)`,
      [newName, oldName]
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(`🔄 Renamed migration: ${oldName} → ${newName}`);
      renamed++;
    }
  }
  if (renamed > 0) {
    console.log(`🔄 Renamed ${renamed} migration(s) in tracking table.`);
  }
}

async function runMigrations() {
  try {
    console.log('🔗 Connecting to database...');
    await ensureMigrationsTable();
    await applyMigrationRenames();

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
