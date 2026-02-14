/**
 * Player News Sync Job
 * Stream A: Player News System (A1.4)
 * Runs every 15 minutes to fetch player news/status changes
 */

import { Pool } from 'pg';
import { createHash } from 'crypto';
import { container, KEYS } from '../container';
import { logger } from '../config/logger.config';
import { getLockId, LockDomain } from '../shared/locks';
import { SleeperApiClient } from '../integrations/sleeper/sleeper-api-client';
import { NewsRepository } from '../modules/players/news.repository';
import { PlayerRepository } from '../modules/players/players.repository';
import { NotificationService } from '../modules/notifications/notification.service';
import { tryGetSocketService } from '../socket/socket.service';
import { ImpactLevel, NewsType } from '../modules/players/news.model';

let intervalId: NodeJS.Timeout | null = null;

// 15 minutes in milliseconds
const SYNC_INTERVAL_MS = 15 * 60 * 1000;

// Job lock ID (in JOB domain namespace: 900_000_000+)
const NEWS_SYNC_JOB_ID = 10; // 900_000_010

/**
 * Lightweight cache for change detection.
 * Stores an MD5 hash per player instead of the full object (~32 chars vs full JSON).
 * Also stores a compact snapshot of the fields needed for news derivation,
 * so derivePlayerNewsFromChanges can still produce accurate news descriptions.
 */
let previousHashCache: Map<string, string> | null = null;

interface CompactPlayerSnapshot {
  injury_status: string | null;
  team: string | null;
  active: boolean;
  full_name: string;
}
let previousSnapshotCache: Map<string, CompactPlayerSnapshot> | null = null;

/** Compute an MD5 hash of a player's JSON representation for change detection. */
function hashPlayer(player: Record<string, any>): string {
  return createHash('md5').update(JSON.stringify(player)).digest('hex');
}

/** Extract only the fields needed for news derivation from a player object. */
function extractSnapshot(player: Record<string, any>): CompactPlayerSnapshot {
  return {
    injury_status: player.injury_status ?? null,
    team: player.team ?? null,
    active: !!player.active,
    full_name: player.full_name ?? '',
  };
}

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

      // Detect changes using hash comparison if we have previous data
      if (previousHashCache && previousSnapshotCache) {
        // Build a filtered previousPlayers record containing only players whose hash changed.
        // This avoids deep-comparing every player and keeps the derivePlayerNewsFromChanges
        // contract intact — it receives only the subset of players that actually differ.
        const changedPreviousPlayers: Record<string, any> = {};

        for (const [playerId, currentPlayer] of Object.entries(currentPlayers)) {
          const previousHash = previousHashCache.get(playerId);
          if (!previousHash) continue; // New player, no previous data to compare

          const currentHash = hashPlayer(currentPlayer);
          if (currentHash !== previousHash) {
            // Hash mismatch — player data changed; include compact snapshot as previous
            const snapshot = previousSnapshotCache.get(playerId);
            if (snapshot) {
              changedPreviousPlayers[playerId] = snapshot;
            }
          }
        }

        // Only call derive if there are actually changed players
        const changedPlayerCount = Object.keys(changedPreviousPlayers).length;
        if (changedPlayerCount > 0) {
          logger.info(`Hash comparison found ${changedPlayerCount} changed players`);

          const newsItems = await sleeperClient.derivePlayerNewsFromChanges(
            currentPlayers,
            changedPreviousPlayers
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

                // Get owners of this player for targeted notifications
                const ownerUserIds = await newsRepo.getUsersOwningPlayer(player.id);

                // Emit socket.io event for real-time updates to player owners
                const socketService = tryGetSocketService();
                if (socketService && ownerUserIds.length > 0) {
                  socketService.emitPlayerNews(ownerUserIds, { news, player });
                }

                // Send push notifications to users who own this player
                if (ownerUserIds.length > 0) {
                  try {
                    const notificationService = new NotificationService(pool);
                    await notificationService.sendPlayerNewsNotification(ownerUserIds, news, player);
                  } catch (notifError) {
                    logger.error(`Failed to send player news notifications: ${notifError}`);
                  }
                }
              }
            } catch (error) {
              logger.error(`Failed to process news for player ${newsItem.player_id}: ${error}`);
            }
          }
        } else {
          logger.info('No player data changes detected (all hashes match)');
        }
      }

      // Update hash and snapshot caches for next run
      const newHashCache = new Map<string, string>();
      const newSnapshotCache = new Map<string, CompactPlayerSnapshot>();
      for (const [playerId, player] of Object.entries(currentPlayers)) {
        newHashCache.set(playerId, hashPlayer(player));
        newSnapshotCache.set(playerId, extractSnapshot(player));
      }
      previousHashCache = newHashCache;
      previousSnapshotCache = newSnapshotCache;

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
