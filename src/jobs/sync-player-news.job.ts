/**
 * Player News Sync Job
 * Stream A: Player News System (A1.4)
 * Runs every 15 minutes to fetch player news/status changes
 */

import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { logger } from '../config/logger.config';
import { getLockId, LockDomain } from '../shared/locks';
import { SleeperApiClient } from '../integrations/sleeper/sleeper-api-client';
import { NewsRepository } from '../modules/players/news.repository';
import { PlayerRepository } from '../modules/players/players.repository';
import { ImpactLevel, NewsType } from '../modules/players/news.model';

let intervalId: NodeJS.Timeout | null = null;

// 15 minutes in milliseconds
const SYNC_INTERVAL_MS = 15 * 60 * 1000;

// Job lock ID (in JOB domain namespace: 900_000_000+)
const NEWS_SYNC_JOB_ID = 5; // 900_000_005

// Cache for previous player data (for change detection)
let previousPlayersCache: Record<string, any> | null = null;

/**
 * Run the player news sync from Sleeper API
 * Detects player status changes and generates news items
 */
export async function runPlayerNewsSync(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const lockId = getLockId(LockDomain.JOB, NEWS_SYNC_JOB_ID);
  const client = await pool.connect();

  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [lockId]
    );

    if (!lockResult.rows[0].acquired) {
      logger.debug('Player news sync lock not acquired, skipping');
      return;
    }

    try {
      const tickStart = Date.now();
      logger.info('Starting player news sync...');

      // Note: News derivation is Sleeper-specific (compares snapshots)
      // For non-Sleeper providers, this job should be skipped or reimplemented
      const sleeperClient = new SleeperApiClient();
      const newsRepo = new NewsRepository(pool);
      const playerRepo = new PlayerRepository(pool);

      // Fetch current player data
      const currentPlayers = await sleeperClient.fetchNflPlayers();

      let newsCount = 0;
      let breakingNewsCount = 0;

      // Detect changes if we have previous data
      if (previousPlayersCache) {
        const newsItems = await sleeperClient.derivePlayerNewsFromChanges(
          currentPlayers,
          previousPlayersCache
        );

        logger.info(`Detected ${newsItems.length} player status changes`);

        // Process each news item
        for (const newsItem of newsItems) {
          try {
            // Find player in our database
            const player = await playerRepo.findBySleeperId(newsItem.player_id);
            if (!player) {
              logger.warn(`Player not found for sleeper_id: ${newsItem.player_id}`);
              continue;
            }

            // Create news entry
            const news = await newsRepo.createNews({
              playerId: player.id,
              title: newsItem.title,
              summary: newsItem.description,
              source: 'sleeper',
              publishedAt: new Date(newsItem.timestamp),
              newsType: newsItem.news_type as NewsType,
              impactLevel: newsItem.impact_level as ImpactLevel,
            });

            newsCount++;

            // Handle breaking news (critical/high impact)
            if (news.impactLevel === 'critical' || news.impactLevel === 'high') {
              breakingNewsCount++;

              // Emit socket.io event for real-time updates
              // TODO: Integrate with socket.io service
              // io.emit('player:news', { news, player });

              // TODO: Send push notifications to users who own this player
              // const owners = await newsRepo.getUsersOwningPlayer(player.id);
              // await notificationService.sendBreakingNews(owners, news, player);
            }
          } catch (error) {
            logger.error(`Failed to process news for player ${newsItem.player_id}: ${error}`);
          }
        }
      }

      // Update cache for next run
      previousPlayersCache = currentPlayers;

      logger.info(
        `Player news sync complete: ${newsCount} news items created (${breakingNewsCount} breaking)`,
        { durationMs: Date.now() - tickStart }
      );
    } catch (error) {
      logger.error(`Player news sync error: ${error}`);
    } finally {
      // Release the advisory lock
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
  } finally {
    client.release();
  }
}

/**
 * Start the player news sync job
 * Runs immediately and then every 15 minutes
 */
export function startPlayerNewsSync() {
  if (intervalId) {
    logger.warn('Player news sync already running');
    return;
  }

  logger.info(`Starting player news sync job (every ${SYNC_INTERVAL_MS / 1000 / 60} minutes)`);

  // Run immediately
  runPlayerNewsSync().catch((error) => {
    logger.error(`Initial player news sync failed: ${error}`);
  });

  // Then run on interval
  intervalId = setInterval(() => {
    runPlayerNewsSync().catch((error) => {
      logger.error(`Scheduled player news sync failed: ${error}`);
    });
  }, SYNC_INTERVAL_MS);
}

/**
 * Stop the player news sync job
 */
export function stopPlayerNewsSync() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Player news sync job stopped');
  }
}
