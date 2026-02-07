import { PlayerStats, ScoringRules } from './scoring.model';

/**
 * Pure scoring calculation utilities.
 * These functions have no dependencies and can be used anywhere scoring is needed.
 */

/**
 * Get defense points allowed score based on points allowed bracket
 */
function getDefensePointsAllowedScore(pointsAllowed: number, rules: ScoringRules): number {
  if (pointsAllowed === 0) return rules.defPointsAllowed0;
  if (pointsAllowed <= 6) return rules.defPointsAllowed1to6;
  if (pointsAllowed <= 13) return rules.defPointsAllowed7to13;
  if (pointsAllowed <= 20) return rules.defPointsAllowed14to20;
  if (pointsAllowed <= 27) return rules.defPointsAllowed21to27;
  if (pointsAllowed <= 34) return rules.defPointsAllowed28to34;
  return rules.defPointsAllowed35plus;
}

/**
 * Calculate points for a player's stats using the given scoring rules
 */
export function calculatePlayerPoints(stats: PlayerStats, rules: ScoringRules): number {
  let points = 0;

  // Passing
  points += stats.passYards * rules.passYards;
  points += stats.passTd * rules.passTd;
  points += stats.passInt * rules.passInt;

  // Rushing
  points += stats.rushYards * rules.rushYards;
  points += stats.rushTd * rules.rushTd;

  // Receiving
  points += stats.receptions * rules.receptions;
  points += stats.recYards * rules.recYards;
  points += stats.recTd * rules.recTd;

  // Misc
  points += stats.fumblesLost * rules.fumblesLost;
  points += stats.twoPtConversions * rules.twoPtConversions;

  // Kicking
  points += stats.fgMade * rules.fgMade;
  points += stats.fgMissed * rules.fgMissed;
  points += stats.patMade * rules.patMade;
  points += stats.patMissed * rules.patMissed;

  // Defense
  points += stats.defTd * rules.defTd;
  points += stats.defInt * rules.defInt;
  points += stats.defSacks * rules.defSack;
  points += stats.defFumbleRec * rules.defFumbleRec;
  points += stats.defSafety * rules.defSafety;

  // Defense points allowed
  points += getDefensePointsAllowedScore(stats.defPointsAllowed, rules);

  // Apply yardage bonuses
  if (rules.bonus100YardRush && stats.rushYards >= 100) {
    points += rules.bonus100YardRush;
  }
  if (rules.bonus100YardRec && stats.recYards >= 100) {
    points += rules.bonus100YardRec;
  }
  if (rules.bonus300YardPass && stats.passYards >= 300) {
    points += rules.bonus300YardPass;
  }

  return Math.round(points * 100) / 100; // Round to 2 decimal places
}

/**
 * Calculate remaining projected stats by subtracting actual from projection.
 * Used for live projections: projectedFinal = score(actual) + score(remaining)
 *
 * Negative stats (INT, fumbles) are set to 0 - we don't project more turnovers.
 */
export function calculateRemainingStats(
  actualStats: PlayerStats,
  projectionStats: PlayerStats
): PlayerStats {
  return {
    ...actualStats,
    // Passing - don't project negative stats like INTs
    passYards: Math.max(0, projectionStats.passYards - actualStats.passYards),
    passTd: Math.max(0, projectionStats.passTd - actualStats.passTd),
    passInt: 0,
    // Rushing
    rushYards: Math.max(0, projectionStats.rushYards - actualStats.rushYards),
    rushTd: Math.max(0, projectionStats.rushTd - actualStats.rushTd),
    // Receiving
    receptions: Math.max(0, projectionStats.receptions - actualStats.receptions),
    recYards: Math.max(0, projectionStats.recYards - actualStats.recYards),
    recTd: Math.max(0, projectionStats.recTd - actualStats.recTd),
    // Misc - don't project negative
    fumblesLost: 0,
    twoPtConversions: Math.max(0, projectionStats.twoPtConversions - actualStats.twoPtConversions),
    // Kicking
    fgMade: Math.max(0, projectionStats.fgMade - actualStats.fgMade),
    fgMissed: 0,
    patMade: Math.max(0, projectionStats.patMade - actualStats.patMade),
    patMissed: 0,
    // Defense
    defTd: Math.max(0, projectionStats.defTd - actualStats.defTd),
    defInt: Math.max(0, projectionStats.defInt - actualStats.defInt),
    defSacks: Math.max(0, projectionStats.defSacks - actualStats.defSacks),
    defFumbleRec: Math.max(0, projectionStats.defFumbleRec - actualStats.defFumbleRec),
    defSafety: Math.max(0, projectionStats.defSafety - actualStats.defSafety),
    defPointsAllowed: 0, // Points allowed not projected for remaining
  };
}

/**
 * Calculate projected bonus points for live projections.
 * Only counts bonuses that haven't been earned yet but are projected to be earned.
 */
export function calculateProjectedBonuses(
  actualStats: PlayerStats,
  projectedStats: PlayerStats,
  rules: ScoringRules
): number {
  let bonusPoints = 0;

  // Rush yards bonus - only if not already earned
  if (rules.bonus100YardRush) {
    const alreadyEarned = actualStats.rushYards >= 100;
    const projectedToEarn = projectedStats.rushYards >= 100;
    if (!alreadyEarned && projectedToEarn) {
      bonusPoints += rules.bonus100YardRush;
    }
  }

  // Receiving yards bonus
  if (rules.bonus100YardRec) {
    const alreadyEarned = actualStats.recYards >= 100;
    const projectedToEarn = projectedStats.recYards >= 100;
    if (!alreadyEarned && projectedToEarn) {
      bonusPoints += rules.bonus100YardRec;
    }
  }

  // Passing yards bonus
  if (rules.bonus300YardPass) {
    const alreadyEarned = actualStats.passYards >= 300;
    const projectedToEarn = projectedStats.passYards >= 300;
    if (!alreadyEarned && projectedToEarn) {
      bonusPoints += rules.bonus300YardPass;
    }
  }

  return bonusPoints;
}
