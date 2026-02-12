const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function applyMigrations() {
  const client = await pool.connect();

  try {
    // Manually mark 095 as applied if not already
    await client.query(`
      INSERT INTO migrations (name)
      VALUES ('095_add_composite_indexes_hot_paths.notx.sql')
      ON CONFLICT (name) DO NOTHING
    `);
    console.log('✓ Marked migration 095 as applied');

    // Migration 100: Overnight pause
    const migration100 = fs.readFileSync(
      path.join(__dirname, 'migrations', '100_add_overnight_pause_to_drafts.sql'),
      'utf8'
    );

    const applied100 = await client.query(
      "SELECT 1 FROM migrations WHERE name = '100_add_overnight_pause_to_drafts.sql'"
    );

    if (applied100.rows.length === 0) {
      await client.query('BEGIN');
      await client.query(migration100);
      await client.query(`
        INSERT INTO migrations (name)
        VALUES ('100_add_overnight_pause_to_drafts.sql')
      `);
      await client.query('COMMIT');
      console.log('✓ Applied migration 100: add_overnight_pause_to_drafts');
    } else {
      console.log('↩️  Migration 100 already applied');
    }

    // Migration 101: Chat search indexes (simplified version without CONCURRENTLY)
    const migration101 = fs.readFileSync(
      path.join(__dirname, 'migrations', '101_add_chat_search_indexes_simple.sql'),
      'utf8'
    );

    const applied101 = await client.query(
      "SELECT 1 FROM migrations WHERE name = '101_add_chat_search_indexes.sql'"
    );

    if (applied101.rows.length === 0) {
      await client.query('BEGIN');
      await client.query(migration101);
      await client.query(`
        INSERT INTO migrations (name)
        VALUES ('101_add_chat_search_indexes.sql')
      `);
      await client.query('COMMIT');
      console.log('✓ Applied migration 101: add_chat_search_indexes');
    } else {
      console.log('↩️  Migration 101 already applied');
    }

    // Migration 102: Matchups draft support
    const migration102 = fs.readFileSync(
      path.join(__dirname, 'migrations', '102_add_matchups_draft_support.sql'),
      'utf8'
    );

    const applied102 = await client.query(
      "SELECT 1 FROM migrations WHERE name = '102_add_matchups_draft_support.sql'"
    );

    if (applied102.rows.length === 0) {
      await client.query('BEGIN');
      await client.query(migration102);
      await client.query(`
        INSERT INTO migrations (name)
        VALUES ('102_add_matchups_draft_support.sql')
      `);
      await client.query('COMMIT');
      console.log('✓ Applied migration 102: add_matchups_draft_support');
    } else {
      console.log('↩️  Migration 102 already applied');
    }

    // Migration 103: Fix auction roster cascade
    const migration103 = fs.readFileSync(
      path.join(__dirname, 'migrations', '103_fix_auction_roster_cascade.sql'),
      'utf8'
    );

    const applied103 = await client.query(
      "SELECT 1 FROM migrations WHERE name = '103_fix_auction_roster_cascade.sql'"
    );

    if (applied103.rows.length === 0) {
      await client.query('BEGIN');
      await client.query(migration103);
      await client.query(`
        INSERT INTO migrations (name)
        VALUES ('103_fix_auction_roster_cascade.sql')
      `);
      await client.query('COMMIT');
      console.log('✓ Applied migration 103: fix_auction_roster_cascade');
    } else {
      console.log('↩️  Migration 103 already applied');
    }

    console.log('\n✅ All migrations applied successfully!');
  } catch (error) {
    console.error('❌ Migration error:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

applyMigrations().catch(console.error);
