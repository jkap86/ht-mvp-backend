import { PoolClient } from 'pg';
import { Draft, DraftSettings, PlayerPoolType } from './drafts.model';
import { Player } from '../players/players.model';
import { PlayerRepository } from '../players/players.repository';
import { NotFoundException, ValidationException } from '../../utils/exceptions';

/**
 * Check whether a player belongs to any of the specified player pool types.
 *
 * Classification logic:
 *   - veteran: NFL player with yearsExp > 0 (or null, which indicates an established vet)
 *   - rookie:  NFL player with yearsExp === 0
 *   - college: college player (playerType === 'college')
 */
export function isPlayerInPool(player: Player, playerPool: PlayerPoolType[]): boolean {
  for (const poolType of playerPool) {
    if (poolType === 'veteran' && player.playerType === 'nfl' &&
        (player.yearsExp === null || player.yearsExp > 0)) {
      return true;
    }
    if (poolType === 'rookie' && player.playerType === 'nfl' && player.yearsExp === 0) {
      return true;
    }
    if (poolType === 'college' && player.playerType === 'college') {
      return true;
    }
  }
  return false;
}

/**
 * Validate that a player is eligible for a draft's configured player pool.
 *
 * If the draft has no playerPool restriction (empty or undefined), all players are allowed.
 * Otherwise the player is looked up via the provided repository and checked against the pool.
 *
 * @param client      - Active transaction client (avoids connection churn during peak drafts)
 * @param draft       - The draft whose settings define the player pool
 * @param playerId    - The player to validate
 * @param playerRepo  - Repository used to fetch the player record
 */
export async function validatePlayerPoolEligibility(
  client: PoolClient,
  draft: Draft,
  playerId: number,
  playerRepo: PlayerRepository
): Promise<void> {
  const settings = draft.settings as DraftSettings;
  const playerPool = settings?.playerPool;

  // Default: allow all NFL players (no restriction)
  if (!playerPool || playerPool.length === 0) {
    return;
  }

  const player = await playerRepo.findByIdWithClient(client, playerId);
  if (!player) {
    throw new NotFoundException('Player not found');
  }

  if (!isPlayerInPool(player, playerPool)) {
    const poolLabels = playerPool
      .map((p) => (p === 'veteran' ? 'veterans' : p === 'rookie' ? 'rookies' : 'college players'))
      .join(', ');
    throw new ValidationException(
      `This draft only allows ${poolLabels}. ${player.fullName} is not eligible.`
    );
  }
}
