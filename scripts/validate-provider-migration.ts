/**
 * Validation script for provider migration
 * Run this after deploying the provider-agnostic stats system to verify everything is working
 *
 * Usage: npm run validate:provider-migration
 */

import { pool } from '../src/db/pool';
import { logger } from '../src/config/logger.config';

async function validateMigration() {
  logger.info('========================================');
  logger.info('Provider Migration Validation');
  logger.info('========================================\n');

  let hasErrors = false;

  try {
    // 1. Check external_ids table exists and is populated
    logger.info('1. Checking player_external_ids table...');
    const tableExistsResult = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'player_external_ids')"
    );

    if (!tableExistsResult.rows[0].exists) {
      logger.error('❌ player_external_ids table does not exist! Run migrations first.');
      hasErrors = true;
    } else {
      logger.info('✓ player_external_ids table exists');

      // Check sleeper provider mappings
      const sleeperIdsCount = await pool.query(
        "SELECT COUNT(*) as count FROM player_external_ids WHERE provider = 'sleeper'"
      );
      const sleeperCount = parseInt(sleeperIdsCount.rows[0].count, 10);

      if (sleeperCount === 0) {
        logger.warn('⚠️  No Sleeper external IDs found. Run backfill migration (090).');
      } else {
        logger.info(`✓ Found ${sleeperCount} Sleeper player mappings`);
      }

      // Check cfbd provider mappings
      const cfbdIdsCount = await pool.query(
        "SELECT COUNT(*) as count FROM player_external_ids WHERE provider = 'cfbd'"
      );
      const cfbdCount = parseInt(cfbdIdsCount.rows[0].count, 10);
      logger.info(`✓ Found ${cfbdCount} CFBD player mappings`);
    }

    // 2. Verify player_stats table integrity
    logger.info('\n2. Checking player_stats table integrity...');
    const statsCount = await pool.query('SELECT COUNT(*) as count FROM player_stats');
    logger.info(`✓ Found ${statsCount.rows[0].count} stat records`);

    // Check for broken foreign keys
    const brokenStatsFK = await pool.query(`
      SELECT COUNT(*) as count
      FROM player_stats ps
      LEFT JOIN players p ON ps.player_id = p.id
      WHERE p.id IS NULL
    `);

    if (parseInt(brokenStatsFK.rows[0].count, 10) > 0) {
      logger.error(
        `❌ Found ${brokenStatsFK.rows[0].count} player_stats records with broken player_id FK`
      );
      hasErrors = true;
    } else {
      logger.info('✓ No broken foreign keys in player_stats');
    }

    // 3. Verify player_projections table integrity
    logger.info('\n3. Checking player_projections table integrity...');
    const projectionsCount = await pool.query(
      'SELECT COUNT(*) as count FROM player_projections'
    );
    logger.info(`✓ Found ${projectionsCount.rows[0].count} projection records`);

    const brokenProjectionsFK = await pool.query(`
      SELECT COUNT(*) as count
      FROM player_projections pp
      LEFT JOIN players p ON pp.player_id = p.id
      WHERE p.id IS NULL
    `);

    if (parseInt(brokenProjectionsFK.rows[0].count, 10) > 0) {
      logger.error(
        `❌ Found ${brokenProjectionsFK.rows[0].count} player_projections records with broken player_id FK`
      );
      hasErrors = true;
    } else {
      logger.info('✓ No broken foreign keys in player_projections');
    }

    // 4. Check league_seasons.stats_provider column
    logger.info('\n4. Checking league_seasons.stats_provider column...');
    const statsProviderExists = await pool.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'league_seasons' AND column_name = 'stats_provider'
      )
    `);

    if (!statsProviderExists.rows[0].exists) {
      logger.warn('⚠️  league_seasons.stats_provider column missing. Run migration 091.');
    } else {
      logger.info('✓ league_seasons.stats_provider column exists');

      const leagueProviders = await pool.query(`
        SELECT stats_provider, COUNT(*) as count
        FROM league_seasons
        GROUP BY stats_provider
      `);

      for (const row of leagueProviders.rows) {
        logger.info(`  - ${row.count} league seasons using provider: ${row.stats_provider}`);
      }
    }

    // 5. Verify players table still has legacy columns (backward compatibility)
    logger.info('\n5. Checking backward compatibility...');
    const sleeperIdExists = await pool.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'players' AND column_name = 'sleeper_id'
      )
    `);

    if (sleeperIdExists.rows[0].exists) {
      logger.info('✓ Legacy sleeper_id column still present (backward compatibility)');
    } else {
      logger.warn(
        '⚠️  Legacy sleeper_id column removed. Ensure all code uses external_ids table.'
      );
    }

    // 6. Sample verification: Check a random player has external ID
    logger.info('\n6. Sample data verification...');
    const samplePlayer = await pool.query(`
      SELECT p.id, p.full_name, p.position, p.team,
             pe.provider, pe.external_id
      FROM players p
      LEFT JOIN player_external_ids pe ON p.id = pe.player_id
      WHERE p.active = true
      LIMIT 5
    `);

    if (samplePlayer.rows.length === 0) {
      logger.warn('⚠️  No active players found');
    } else {
      logger.info('✓ Sample player data:');
      for (const player of samplePlayer.rows) {
        if (player.provider) {
          logger.info(
            `  - ${player.full_name} (${player.position}/${player.team}): ${player.provider}:${player.external_id}`
          );
        } else {
          logger.warn(
            `  ⚠️  ${player.full_name} (${player.position}/${player.team}): No external ID!`
          );
        }
      }
    }

    // 7. Environment configuration check
    logger.info('\n7. Checking environment configuration...');
    const statsProvider = process.env.STATS_PROVIDER || 'sleeper';
    logger.info(`✓ STATS_PROVIDER=${statsProvider}`);

    if (statsProvider === 'fantasypros' && !process.env.FANTASYPROS_API_KEY) {
      logger.error('❌ FANTASYPROS_API_KEY not set but provider is fantasypros');
      hasErrors = true;
    }

    // Summary
    logger.info('\n========================================');
    if (hasErrors) {
      logger.error('❌ Validation FAILED - Fix errors above');
      process.exit(1);
    } else {
      logger.info('✅ Validation PASSED - Provider migration successful!');
      logger.info('========================================\n');
      process.exit(0);
    }
  } catch (error) {
    logger.error(`❌ Validation failed with error: ${error}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run validation
validateMigration().catch((error) => {
  logger.error(`Fatal error: ${error}`);
  process.exit(1);
});
