import { PoolClient } from 'pg';
import { RosterPlayersRepository } from './rosters.repository';
import { LeagueRepository } from '../leagues/leagues.repository';
import { DraftPickAssetRepository } from '../drafts/draft-pick-asset.repository';
import { AcquiredType } from './rosters.model';
import { DraftPickAsset } from '../drafts/draft-pick-asset.model';

/**
 * Validation result for roster transitions
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Individual validation error
 */
export interface ValidationError {
  code: RosterRuleErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Error codes for roster rule violations
 */
export enum RosterRuleErrorCode {
  // Player-related errors
  DUPLICATE_PLAYER = 'DUPLICATE_PLAYER',
  PLAYER_NOT_ON_ROSTER = 'PLAYER_NOT_ON_ROSTER',
  PLAYER_ALREADY_OWNED = 'PLAYER_ALREADY_OWNED',

  // Roster size errors
  ROSTER_SIZE_EXCEEDED = 'ROSTER_SIZE_EXCEEDED',
  ROSTER_SIZE_BELOW_MINIMUM = 'ROSTER_SIZE_BELOW_MINIMUM',

  // Pick asset errors
  PICK_ASSET_NOT_OWNED = 'PICK_ASSET_NOT_OWNED',
  PICK_ASSET_ORPHANED = 'PICK_ASSET_ORPHANED',

  // Positional slot errors
  POSITIONAL_LIMIT_EXCEEDED = 'POSITIONAL_LIMIT_EXCEEDED',

  // General errors
  INVALID_ROSTER = 'INVALID_ROSTER',
  INVALID_LEAGUE = 'INVALID_LEAGUE',
}

/**
 * Player operation in a roster transition
 */
export interface PlayerOperation {
  type: 'add' | 'remove';
  playerId: number;
  position?: string | null;
  acquiredType?: AcquiredType;
}

/**
 * Pick asset operation in a roster transition
 */
export interface PickAssetOperation {
  type: 'add' | 'remove';
  pickAssetId: number;
}

/**
 * Input for validating a single roster transition
 */
export interface ValidateTransitionInput {
  leagueId: number;
  rosterId: number;
  playerOperations?: PlayerOperation[];
  pickAssetOperations?: PickAssetOperation[];
}

/**
 * Roster snapshot for validation (current state)
 */
interface RosterSnapshot {
  rosterId: number;
  playerIds: Set<number>;
  playerCount: number;
  pickAssetIds: Set<number>;
}

/**
 * League rules for validation
 */
interface LeagueRules {
  maxRosterSize: number;
  minRosterSize?: number;
  positionalLimits?: Record<string, number>;
}

/**
 * Roster Rules Validator Service
 *
 * Provides unified validation for roster state transitions.
 * Used by:
 * - Trade execution (validateMultiRosterTransition)
 * - Waiver processing (validateTransition)
 * - Draft completion (validateTransition)
 * - Free agency (validateTransition)
 *
 * This service is STATELESS and PURE - it only validates, never mutates.
 * All validation is done against provided snapshots or fresh DB reads.
 */
export class RosterRulesService {
  constructor(
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly pickAssetRepo?: DraftPickAssetRepository
  ) {}

  /**
   * Validate a single roster transition.
   * Checks roster rules after applying the operations.
   *
   * @param input - Transition to validate
   * @param client - Optional transaction client for consistent reads
   */
  async validateTransition(
    input: ValidateTransitionInput,
    client?: PoolClient
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = [];

    // Get league rules
    const league = await this.leagueRepo.findById(input.leagueId);
    if (!league) {
      errors.push({
        code: RosterRuleErrorCode.INVALID_LEAGUE,
        message: `League ${input.leagueId} not found`,
      });
      return { valid: false, errors };
    }

    const rules: LeagueRules = {
      maxRosterSize: league.settings?.roster_size || 15,
      minRosterSize: league.settings?.min_roster_size,
      positionalLimits: league.settings?.positional_limits,
    };

    // Get current roster snapshot
    const snapshot = await this.getRosterSnapshot(input.rosterId, input.leagueId, client);
    if (!snapshot) {
      errors.push({
        code: RosterRuleErrorCode.INVALID_ROSTER,
        message: `Roster ${input.rosterId} not found`,
      });
      return { valid: false, errors };
    }

    // Apply operations to snapshot and validate
    const transitionErrors = await this.validateTransitionInternal(
      snapshot,
      input,
      rules,
      input.leagueId,
      client
    );
    errors.push(...transitionErrors);

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate multiple roster transitions together (e.g., a trade).
   * Validates that the combined effect of all transitions is valid.
   *
   * @param inputs - Array of transitions to validate together
   * @param client - Optional transaction client for consistent reads
   */
  async validateMultiRosterTransition(
    inputs: ValidateTransitionInput[],
    client?: PoolClient
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = [];

    if (inputs.length === 0) {
      return { valid: true, errors: [] };
    }

    // All inputs must be for the same league
    const leagueId = inputs[0].leagueId;
    if (!inputs.every((i) => i.leagueId === leagueId)) {
      errors.push({
        code: RosterRuleErrorCode.INVALID_LEAGUE,
        message: 'All transitions must be for the same league',
      });
      return { valid: false, errors };
    }

    // Get league rules
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      errors.push({
        code: RosterRuleErrorCode.INVALID_LEAGUE,
        message: `League ${leagueId} not found`,
      });
      return { valid: false, errors };
    }

    const rules: LeagueRules = {
      maxRosterSize: league.settings?.roster_size || 15,
      minRosterSize: league.settings?.min_roster_size,
      positionalLimits: league.settings?.positional_limits,
    };

    // Get all roster snapshots
    const snapshots = new Map<number, RosterSnapshot>();
    for (const input of inputs) {
      if (!snapshots.has(input.rosterId)) {
        const snapshot = await this.getRosterSnapshot(input.rosterId, leagueId, client);
        if (!snapshot) {
          errors.push({
            code: RosterRuleErrorCode.INVALID_ROSTER,
            message: `Roster ${input.rosterId} not found`,
          });
        } else {
          snapshots.set(input.rosterId, snapshot);
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    // Track cross-roster player movements to catch duplicates
    const playerMovements = new Map<number, { from: number | null; to: number | null }>();

    // Collect all player operations across rosters
    for (const input of inputs) {
      for (const op of input.playerOperations || []) {
        const existing = playerMovements.get(op.playerId) || { from: null, to: null };
        if (op.type === 'remove') {
          existing.from = input.rosterId;
        } else {
          existing.to = input.rosterId;
        }
        playerMovements.set(op.playerId, existing);
      }
    }

    // Check for duplicate players (same player added to multiple rosters)
    for (const [playerId, movement] of playerMovements) {
      // If a player is being added but not removed from any roster in this transaction,
      // check they're not already owned by another roster
      if (movement.to && !movement.from) {
        // Check all snapshots except the destination
        for (const [rosterId, snapshot] of snapshots) {
          if (rosterId !== movement.to && snapshot.playerIds.has(playerId)) {
            errors.push({
              code: RosterRuleErrorCode.PLAYER_ALREADY_OWNED,
              message: `Player ${playerId} is already on roster ${rosterId}`,
              details: { playerId, ownedByRosterId: rosterId },
            });
          }
        }
      }
    }

    // Apply all operations to snapshots and validate each
    for (const input of inputs) {
      const snapshot = snapshots.get(input.rosterId)!;
      const transitionErrors = await this.validateTransitionInternal(
        snapshot,
        input,
        rules,
        leagueId,
        client,
        playerMovements
      );
      errors.push(...transitionErrors);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate a transition against a snapshot (internal helper).
   */
  private async validateTransitionInternal(
    snapshot: RosterSnapshot,
    input: ValidateTransitionInput,
    rules: LeagueRules,
    leagueId: number,
    client?: PoolClient,
    crossRosterMovements?: Map<number, { from: number | null; to: number | null }>
  ): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    // Apply player operations to a copy of the snapshot
    const resultingPlayerIds = new Set(snapshot.playerIds);
    let playerCountDelta = 0;

    for (const op of input.playerOperations || []) {
      if (op.type === 'remove') {
        if (!resultingPlayerIds.has(op.playerId)) {
          errors.push({
            code: RosterRuleErrorCode.PLAYER_NOT_ON_ROSTER,
            message: `Player ${op.playerId} is not on roster ${input.rosterId}`,
            details: { playerId: op.playerId, rosterId: input.rosterId },
          });
        } else {
          resultingPlayerIds.delete(op.playerId);
          playerCountDelta--;
        }
      } else {
        // Check for duplicates (player already on this roster)
        if (resultingPlayerIds.has(op.playerId)) {
          errors.push({
            code: RosterRuleErrorCode.DUPLICATE_PLAYER,
            message: `Player ${op.playerId} is already on roster ${input.rosterId}`,
            details: { playerId: op.playerId, rosterId: input.rosterId },
          });
        } else {
          // Check cross-roster: is this player owned by another roster (not being removed)?
          if (crossRosterMovements) {
            const movement = crossRosterMovements.get(op.playerId);
            // If no movement record or not being removed from another roster
            if (!movement || !movement.from || movement.from === input.rosterId) {
              // Need to check if player is owned in league by another roster
              const owner = await this.rosterPlayersRepo.findOwner(leagueId, op.playerId, client);
              if (owner && owner !== input.rosterId) {
                errors.push({
                  code: RosterRuleErrorCode.PLAYER_ALREADY_OWNED,
                  message: `Player ${op.playerId} is already owned by roster ${owner}`,
                  details: { playerId: op.playerId, ownedByRosterId: owner },
                });
              }
            }
          }
          resultingPlayerIds.add(op.playerId);
          playerCountDelta++;
        }
      }
    }

    // Validate roster size
    const finalPlayerCount = snapshot.playerCount + playerCountDelta;
    if (finalPlayerCount > rules.maxRosterSize) {
      errors.push({
        code: RosterRuleErrorCode.ROSTER_SIZE_EXCEEDED,
        message: `Roster would have ${finalPlayerCount} players, max is ${rules.maxRosterSize}`,
        details: {
          rosterId: input.rosterId,
          resultingSize: finalPlayerCount,
          maxSize: rules.maxRosterSize,
        },
      });
    }

    if (rules.minRosterSize && finalPlayerCount < rules.minRosterSize) {
      errors.push({
        code: RosterRuleErrorCode.ROSTER_SIZE_BELOW_MINIMUM,
        message: `Roster would have ${finalPlayerCount} players, min is ${rules.minRosterSize}`,
        details: {
          rosterId: input.rosterId,
          resultingSize: finalPlayerCount,
          minSize: rules.minRosterSize,
        },
      });
    }

    // Validate pick asset operations (dynasty/keeper)
    if (input.pickAssetOperations && input.pickAssetOperations.length > 0) {
      const pickAssetErrors = await this.validatePickAssetOperations(
        snapshot,
        input.pickAssetOperations,
        input.rosterId,
        leagueId,
        client
      );
      errors.push(...pickAssetErrors);
    }

    return errors;
  }

  /**
   * Validate pick asset operations for dynasty/keeper modes.
   */
  private async validatePickAssetOperations(
    snapshot: RosterSnapshot,
    operations: PickAssetOperation[],
    rosterId: number,
    leagueId: number,
    client?: PoolClient
  ): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    if (!this.pickAssetRepo) {
      return errors;
    }

    for (const op of operations) {
      if (op.type === 'remove') {
        // Verify the pick asset is owned by this roster
        if (!snapshot.pickAssetIds.has(op.pickAssetId)) {
          // Double-check in DB in case snapshot is stale
          const pickAsset = await this.pickAssetRepo.findById(op.pickAssetId, client);
          if (!pickAsset || pickAsset.currentOwnerRosterId !== rosterId) {
            errors.push({
              code: RosterRuleErrorCode.PICK_ASSET_NOT_OWNED,
              message: `Pick asset ${op.pickAssetId} is not owned by roster ${rosterId}`,
              details: { pickAssetId: op.pickAssetId, rosterId },
            });
          }
        }
      } else {
        // For adding pick assets, just verify it exists and isn't orphaned
        const pickAsset = await this.pickAssetRepo.findById(op.pickAssetId, client);
        if (!pickAsset) {
          errors.push({
            code: RosterRuleErrorCode.PICK_ASSET_ORPHANED,
            message: `Pick asset ${op.pickAssetId} does not exist`,
            details: { pickAssetId: op.pickAssetId },
          });
        }
      }
    }

    return errors;
  }

  /**
   * Get a snapshot of roster state for validation.
   */
  private async getRosterSnapshot(
    rosterId: number,
    leagueId: number,
    client?: PoolClient
  ): Promise<RosterSnapshot | null> {
    // Get current players on roster
    // Note: getByRosterId doesn't support client parameter, so we use it directly
    const players = await this.rosterPlayersRepo.getByRosterId(rosterId);

    const playerIds = new Set(players.map((p: { playerId: number }) => p.playerId));

    // Get pick assets if available
    let pickAssetIds = new Set<number>();
    if (this.pickAssetRepo) {
      try {
        // findByOwner returns assets owned by this roster
        const pickAssets = await this.pickAssetRepo.findByOwner(rosterId, leagueId);
        pickAssetIds = new Set(pickAssets.map((pa: { id: number }) => pa.id));
      } catch {
        // Pick assets not available, continue without them
      }
    }

    return {
      rosterId,
      playerIds,
      playerCount: playerIds.size,
      pickAssetIds,
    };
  }

  /**
   * Quick validation: check if adding a player would exceed roster size.
   * Convenience method for common single-player-add case.
   */
  async canAddPlayer(
    leagueId: number,
    rosterId: number,
    playerId: number,
    client?: PoolClient
  ): Promise<ValidationResult> {
    return this.validateTransition(
      {
        leagueId,
        rosterId,
        playerOperations: [{ type: 'add', playerId }],
      },
      client
    );
  }

  /**
   * Quick validation: check if a swap (add one, drop one) is valid.
   * Convenience method for common swap case.
   */
  async canSwapPlayers(
    leagueId: number,
    rosterId: number,
    addPlayerId: number,
    dropPlayerId: number,
    client?: PoolClient
  ): Promise<ValidationResult> {
    return this.validateTransition(
      {
        leagueId,
        rosterId,
        playerOperations: [
          { type: 'remove', playerId: dropPlayerId },
          { type: 'add', playerId: addPlayerId },
        ],
      },
      client
    );
  }
}
