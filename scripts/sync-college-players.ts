/**
 * One-time script to sync college football players from CFBD API
 * Usage: npx ts-node scripts/sync-college-players.ts [year]
 */
import 'dotenv/config';
import { pool } from '../src/db/pool';
import { CFBDApiClient } from '../src/modules/players/cfbd.client';
import { PlayerRepository } from '../src/modules/players/players.repository';

async function main() {
  const year = process.argv[2] ? parseInt(process.argv[2], 10) : 2025;

  const apiKey = process.env.CFBD_API_KEY;
  if (!apiKey) {
    console.error('ERROR: CFBD_API_KEY environment variable is not set');
    process.exit(1);
  }

  console.log(`Starting college player sync for year ${year}...`);

  const cfbdClient = new CFBDApiClient(apiKey);
  const playerRepo = new PlayerRepository(pool);

  try {
    const players = await cfbdClient.fetchAllFBSRosters(year);

    // Debug: Show all unique positions in the data
    const positions = new Set(players.map((p) => p.position).filter(Boolean));
    console.log(`\nUnique positions in data: ${[...positions].sort().join(', ')}`);

    // Filter for fantasy-relevant positions (case-insensitive, various formats)
    const relevantPositions = ['QB', 'RB', 'WR', 'TE', 'K', 'ATH', 'FB', 'HB', 'TB', 'FL', 'SE', 'PK'];
    const playersToSync = players.filter((player) => {
      if (!player.position) {
        return false;
      }
      const pos = player.position.toUpperCase();
      if (!relevantPositions.includes(pos)) {
        return false;
      }
      if (!player.first_name && !player.last_name) {
        return false;
      }
      return true;
    });

    console.log(`Found ${playersToSync.length} fantasy-relevant college players to sync...`);

    if (playersToSync.length > 0) {
      const syncedCount = await playerRepo.batchUpsertFromCFBD(playersToSync, 100);
      console.log(`\nSync complete!`);
      console.log(`  Synced: ${syncedCount} players`);
    } else {
      console.log('\nNo players to sync.');
    }

    const totalCount = await playerRepo.getCollegePlayerCount();
    console.log(`  Total college players in database: ${totalCount}`);
  } catch (error) {
    console.error('Sync failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
