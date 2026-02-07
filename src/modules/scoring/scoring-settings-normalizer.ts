import { ScoringRules, DEFAULT_SCORING_RULES, ScoringType } from './scoring.model';

type AnyObj = Record<string, any>;

function toNumber(v: any, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Normalizes league scoring settings from either format into ScoringRules.
 * Supports:
 * 1) Nested: { type: 'ppr', rules: { passYards: 0.04, ... } }
 * 2) Flat (Flutter): { rec, pass_td, pass_yd, ... }
 *
 * This allows the backend to accept scoring settings in the format
 * sent by the Flutter frontend (flat snake_case keys) while maintaining
 * backward compatibility with any existing nested format.
 */
export function normalizeLeagueScoringSettings(
  scoringSettings: AnyObj | null | undefined
): {
  scoringType: ScoringType;
  rules: ScoringRules;
} {
  const ss = scoringSettings || {};

  // Format 1: nested (backend format)
  // Check if we have the structured { type, rules } format
  const nestedType = ss.type as ScoringType | undefined;
  const nestedRules = ss.rules as AnyObj | undefined;
  if (nestedType && nestedRules) {
    return {
      scoringType: nestedType,
      rules: { ...DEFAULT_SCORING_RULES[nestedType], ...nestedRules },
    };
  }

  // Format 2: flat (Flutter format)
  // Derive scoring type from 'rec' (receptions) field
  const rec = toNumber(ss.rec, 1);
  let scoringType: ScoringType = 'ppr';
  if (rec === 0) scoringType = 'standard';
  else if (rec === 0.5) scoringType = 'half_ppr';

  const base = DEFAULT_SCORING_RULES[scoringType];

  // Map flat snake_case keys -> backend ScoringRules camelCase
  const rules: ScoringRules = {
    ...base,
    // Passing
    passTd: toNumber(ss.pass_td, base.passTd),
    passYards: toNumber(ss.pass_yd, base.passYards),
    passInt: toNumber(ss.pass_int, base.passInt),
    // Rushing
    rushTd: toNumber(ss.rush_td, base.rushTd),
    rushYards: toNumber(ss.rush_yd, base.rushYards),
    // Receiving
    receptions: toNumber(ss.rec, base.receptions),
    recTd: toNumber(ss.rec_td, base.recTd),
    recYards: toNumber(ss.rec_yd, base.recYards),
    // Misc
    fumblesLost: toNumber(ss.fum_lost, base.fumblesLost),
    twoPtConversions: toNumber(ss.two_pt, base.twoPtConversions),
    // Bonuses
    bonus100YardRush: toNumber(ss.bonus_rush_yd_100, base.bonus100YardRush ?? 0),
    bonus100YardRec: toNumber(ss.bonus_rec_yd_100, base.bonus100YardRec ?? 0),
    bonus300YardPass: toNumber(ss.bonus_pass_yd_300, base.bonus300YardPass ?? 0),
    tePremium: toNumber(ss.te_premium, base.tePremium ?? 0),
  };

  return { scoringType, rules };
}
