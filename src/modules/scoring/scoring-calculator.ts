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

  return Math.round(points * 100) / 100; // Round to 2 decimal places
}
