import {
  calculatePlayerPoints,
  getDefensePointsAllowedScore,
  calculateRemainingStats,
  calculateProjectedBonuses,
} from '../../../modules/scoring/scoring-calculator';
import {
  PlayerStats,
  ScoringRules,
  DEFAULT_SCORING_RULES,
} from '../../../modules/scoring/scoring.model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a zeroed-out PlayerStats, overriding only the fields provided. */
function makeStats(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return {
    id: 0,
    playerId: 0,
    season: 2025,
    week: 1,
    passYards: 0,
    passTd: 0,
    passInt: 0,
    rushYards: 0,
    rushTd: 0,
    receptions: 0,
    recYards: 0,
    recTd: 0,
    fumblesLost: 0,
    twoPtConversions: 0,
    fgMade: 0,
    fgMissed: 0,
    patMade: 0,
    patMissed: 0,
    defTd: 0,
    defInt: 0,
    defSacks: 0,
    defFumbleRec: 0,
    defSafety: 0,
    defPointsAllowed: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Build scoring rules, starting from PPR defaults and overriding as needed. */
function makeRules(overrides: Partial<ScoringRules> = {}): ScoringRules {
  return { ...DEFAULT_SCORING_RULES.ppr, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scoring-calculator', () => {
  // -----------------------------------------------------------------------
  // getDefensePointsAllowedScore
  // -----------------------------------------------------------------------
  describe('getDefensePointsAllowedScore', () => {
    const rules = makeRules();

    it('returns shutout bonus when 0 points allowed', () => {
      expect(getDefensePointsAllowedScore(0, rules)).toBe(10);
    });

    it('returns 1-6 bracket score for 1 point', () => {
      expect(getDefensePointsAllowedScore(1, rules)).toBe(7);
    });

    it('returns 1-6 bracket score for 6 points (upper boundary)', () => {
      expect(getDefensePointsAllowedScore(6, rules)).toBe(7);
    });

    it('returns 7-13 bracket score for 7 points (lower boundary)', () => {
      expect(getDefensePointsAllowedScore(7, rules)).toBe(4);
    });

    it('returns 7-13 bracket score for 13 points (upper boundary)', () => {
      expect(getDefensePointsAllowedScore(13, rules)).toBe(4);
    });

    it('returns 14-20 bracket score for 14 points (lower boundary)', () => {
      expect(getDefensePointsAllowedScore(14, rules)).toBe(1);
    });

    it('returns 14-20 bracket score for 20 points (upper boundary)', () => {
      expect(getDefensePointsAllowedScore(20, rules)).toBe(1);
    });

    it('returns 21-27 bracket score for 21 points (lower boundary)', () => {
      expect(getDefensePointsAllowedScore(21, rules)).toBe(0);
    });

    it('returns 21-27 bracket score for 27 points (upper boundary)', () => {
      expect(getDefensePointsAllowedScore(27, rules)).toBe(0);
    });

    it('returns 28-34 bracket score for 28 points (lower boundary)', () => {
      expect(getDefensePointsAllowedScore(28, rules)).toBe(-1);
    });

    it('returns 28-34 bracket score for 34 points (upper boundary)', () => {
      expect(getDefensePointsAllowedScore(34, rules)).toBe(-1);
    });

    it('returns 35+ bracket score for 35 points (lower boundary)', () => {
      expect(getDefensePointsAllowedScore(35, rules)).toBe(-4);
    });

    it('returns 35+ bracket score for very high points allowed', () => {
      expect(getDefensePointsAllowedScore(55, rules)).toBe(-4);
    });
  });

  // -----------------------------------------------------------------------
  // calculatePlayerPoints - QB
  // -----------------------------------------------------------------------
  describe('calculatePlayerPoints - QB scoring', () => {
    const pprRules = makeRules();

    it('scores a standard QB game (Patrick Mahomes-style)', () => {
      // 280 pass yds, 3 pass TDs, 1 INT, 15 rush yds
      const stats = makeStats({
        passYards: 280,
        passTd: 3,
        passInt: 1,
        rushYards: 15,
      });
      // 280 * 0.04 = 11.2  +  3 * 4 = 12  +  1 * -2 = -2  +  15 * 0.1 = 1.5
      // + defPointsAllowed=0 -> +10 (shutout bracket auto-applied on zeroed stats)
      // Total: 11.2 + 12 - 2 + 1.5 + 10 = 32.7
      expect(calculatePlayerPoints(stats, pprRules, 'QB')).toBe(32.7);
    });

    it('scores a big QB game with 300-yard passing bonus', () => {
      const rules = makeRules({ bonus300YardPass: 3 });
      const stats = makeStats({
        passYards: 350,
        passTd: 4,
        passInt: 0,
      });
      // 350 * 0.04 = 14  +  4 * 4 = 16  +  bonus 3  +  defPA 0 -> 10
      // Total: 14 + 16 + 3 + 10 = 43
      expect(calculatePlayerPoints(stats, rules, 'QB')).toBe(43);
    });

    it('applies interception penalty', () => {
      const stats = makeStats({
        passYards: 150,
        passTd: 0,
        passInt: 3,
      });
      // 150 * 0.04 = 6  +  3 * -2 = -6  + 10 (shutout bracket)
      // Total: 6 - 6 + 10 = 10
      expect(calculatePlayerPoints(stats, pprRules, 'QB')).toBe(10);
    });

    it('counts two-point conversions for a QB', () => {
      const stats = makeStats({
        passYards: 200,
        passTd: 1,
        twoPtConversions: 1,
      });
      // 200 * 0.04 = 8  +  1 * 4 = 4  +  1 * 2 = 2  + 10 (shutout bracket)
      // Total: 8 + 4 + 2 + 10 = 24
      expect(calculatePlayerPoints(stats, pprRules, 'QB')).toBe(24);
    });
  });

  // -----------------------------------------------------------------------
  // calculatePlayerPoints - RB
  // -----------------------------------------------------------------------
  describe('calculatePlayerPoints - RB scoring', () => {
    const pprRules = makeRules();

    it('scores a standard RB game (Derrick Henry-style)', () => {
      const stats = makeStats({
        rushYards: 95,
        rushTd: 1,
        receptions: 2,
        recYards: 18,
      });
      // 95 * 0.1 = 9.5  +  1 * 6 = 6  +  2 * 1 = 2  +  18 * 0.1 = 1.8  + 10
      // Total: 9.5 + 6 + 2 + 1.8 + 10 = 29.3
      expect(calculatePlayerPoints(stats, pprRules, 'RB')).toBe(29.3);
    });

    it('applies 100-yard rush bonus', () => {
      const rules = makeRules({ bonus100YardRush: 2 });
      const stats = makeStats({
        rushYards: 120,
        rushTd: 1,
      });
      // 120 * 0.1 = 12  +  6  +  bonus 2  +  10 = 30
      expect(calculatePlayerPoints(stats, rules, 'RB')).toBe(30);
    });

    it('does not apply 100-yard rush bonus at 99 yards', () => {
      const rules = makeRules({ bonus100YardRush: 2 });
      const stats = makeStats({ rushYards: 99, rushTd: 0 });
      // 99 * 0.1 = 9.9  +  10 (shutout bracket)
      // Total: 19.9
      expect(calculatePlayerPoints(stats, rules, 'RB')).toBe(19.9);
    });

    it('applies exactly at 100-yard threshold', () => {
      const rules = makeRules({ bonus100YardRush: 2 });
      const stats = makeStats({ rushYards: 100 });
      // 100 * 0.1 = 10  +  bonus 2  +  10 (shutout bracket) = 22
      expect(calculatePlayerPoints(stats, rules, 'RB')).toBe(22);
    });

    it('penalizes fumbles lost', () => {
      const stats = makeStats({
        rushYards: 80,
        rushTd: 1,
        fumblesLost: 2,
      });
      // 80 * 0.1 = 8  +  6  +  2 * -2 = -4  + 10
      // Total: 8 + 6 - 4 + 10 = 20
      expect(calculatePlayerPoints(stats, pprRules, 'RB')).toBe(20);
    });

    it('scores an RB in standard (non-PPR) scoring', () => {
      const standardRules = makeRules({ receptions: 0 });
      const stats = makeStats({
        rushYards: 70,
        rushTd: 1,
        receptions: 4,
        recYards: 35,
      });
      // 70 * 0.1 = 7  +  6  +  4 * 0 = 0  +  35 * 0.1 = 3.5  + 10
      // Total: 7 + 6 + 0 + 3.5 + 10 = 26.5
      expect(calculatePlayerPoints(stats, standardRules, 'RB')).toBe(26.5);
    });
  });

  // -----------------------------------------------------------------------
  // calculatePlayerPoints - WR
  // -----------------------------------------------------------------------
  describe('calculatePlayerPoints - WR scoring', () => {
    const pprRules = makeRules();

    it('scores a standard WR game (Davante Adams-style)', () => {
      const stats = makeStats({
        receptions: 8,
        recYards: 105,
        recTd: 1,
      });
      // 8 * 1 = 8  +  105 * 0.1 = 10.5  +  6  + 10 (shutout bracket)
      // Total: 8 + 10.5 + 6 + 10 = 34.5
      expect(calculatePlayerPoints(stats, pprRules, 'WR')).toBe(34.5);
    });

    it('applies 100-yard receiving bonus', () => {
      const rules = makeRules({ bonus100YardRec: 2 });
      const stats = makeStats({
        receptions: 6,
        recYards: 112,
        recTd: 0,
      });
      // 6 * 1 = 6  +  112 * 0.1 = 11.2  +  bonus 2  +  10
      // Total: 6 + 11.2 + 2 + 10 = 29.2
      expect(calculatePlayerPoints(stats, rules, 'WR')).toBe(29.2);
    });

    it('scores WR in half-PPR', () => {
      const halfPprRules = makeRules({ receptions: 0.5 });
      const stats = makeStats({
        receptions: 6,
        recYards: 80,
        recTd: 1,
      });
      // 6 * 0.5 = 3  +  80 * 0.1 = 8  +  6  +  10
      // Total: 3 + 8 + 6 + 10 = 27
      expect(calculatePlayerPoints(stats, halfPprRules, 'WR')).toBe(27);
    });
  });

  // -----------------------------------------------------------------------
  // calculatePlayerPoints - TE / TE Premium
  // -----------------------------------------------------------------------
  describe('calculatePlayerPoints - TE Premium', () => {
    it('applies TE premium on receptions for TE position', () => {
      const rules = makeRules({ tePremium: 0.5 });
      const stats = makeStats({
        receptions: 5,
        recYards: 60,
        recTd: 1,
      });
      // Base: 5 * 1 = 5  +  60 * 0.1 = 6  +  6  + 10 (shutout bracket)
      // TE premium: 5 * 0.5 = 2.5
      // Total: 5 + 6 + 6 + 10 + 2.5 = 29.5
      expect(calculatePlayerPoints(stats, rules, 'TE')).toBe(29.5);
    });

    it('does not apply TE premium for WR position', () => {
      const rules = makeRules({ tePremium: 0.5 });
      const stats = makeStats({
        receptions: 5,
        recYards: 60,
        recTd: 1,
      });
      // No TE premium: 5 + 6 + 6 + 10 = 27
      expect(calculatePlayerPoints(stats, rules, 'WR')).toBe(27);
    });

    it('does not apply TE premium when tePremium is 0', () => {
      const rules = makeRules({ tePremium: 0 });
      const stats = makeStats({
        receptions: 5,
        recYards: 60,
        recTd: 1,
      });
      // 5 + 6 + 6 + 10 = 27
      expect(calculatePlayerPoints(stats, rules, 'TE')).toBe(27);
    });

    it('does not apply TE premium when tePremium is undefined', () => {
      const rules = makeRules();
      // Remove tePremium entirely
      delete (rules as any).tePremium;
      const stats = makeStats({
        receptions: 5,
        recYards: 60,
        recTd: 1,
      });
      // 5 + 6 + 6 + 10 = 27
      expect(calculatePlayerPoints(stats, rules, 'TE')).toBe(27);
    });

    it('does not apply TE premium when position is null', () => {
      const rules = makeRules({ tePremium: 0.5 });
      const stats = makeStats({ receptions: 4 });
      const withPremium = calculatePlayerPoints(stats, rules, 'TE');
      const withNull = calculatePlayerPoints(stats, rules, null);
      expect(withPremium).not.toBe(withNull);
    });
  });

  // -----------------------------------------------------------------------
  // calculatePlayerPoints - Kicker
  // -----------------------------------------------------------------------
  describe('calculatePlayerPoints - Kicker scoring', () => {
    const rules = makeRules();

    it('scores field goals made', () => {
      const stats = makeStats({ fgMade: 3 });
      // 3 * 3 = 9  + 10 (shutout bracket)
      expect(calculatePlayerPoints(stats, rules, 'K')).toBe(19);
    });

    it('penalizes field goals missed', () => {
      const stats = makeStats({ fgMade: 2, fgMissed: 1 });
      // 2 * 3 = 6  +  1 * -1 = -1  + 10 = 15
      expect(calculatePlayerPoints(stats, rules, 'K')).toBe(15);
    });

    it('scores PATs made', () => {
      const stats = makeStats({ patMade: 4 });
      // 4 * 1 = 4  + 10 = 14
      expect(calculatePlayerPoints(stats, rules, 'K')).toBe(14);
    });

    it('penalizes PATs missed', () => {
      const stats = makeStats({ patMade: 3, patMissed: 1 });
      // 3 * 1 = 3  +  1 * -1 = -1  + 10 = 12
      expect(calculatePlayerPoints(stats, rules, 'K')).toBe(12);
    });

    it('scores a realistic kicker game (Justin Tucker-style)', () => {
      const stats = makeStats({
        fgMade: 3,
        fgMissed: 1,
        patMade: 2,
        patMissed: 0,
      });
      // 3 * 3 = 9  +  1 * -1 = -1  +  2 * 1 = 2  + 10 = 20
      expect(calculatePlayerPoints(stats, rules, 'K')).toBe(20);
    });
  });

  // -----------------------------------------------------------------------
  // calculatePlayerPoints - DEF/ST
  // -----------------------------------------------------------------------
  describe('calculatePlayerPoints - Defense/Special Teams', () => {
    const rules = makeRules();

    it('scores defensive TDs', () => {
      const stats = makeStats({ defTd: 2, defPointsAllowed: 14 });
      // 2 * 6 = 12  +  14 pts allowed -> 1
      // Total: 12 + 1 = 13
      expect(calculatePlayerPoints(stats, rules, 'DEF')).toBe(13);
    });

    it('scores interceptions', () => {
      const stats = makeStats({ defInt: 3, defPointsAllowed: 10 });
      // 3 * 2 = 6  +  10 pts allowed -> 4
      // Total: 6 + 4 = 10
      expect(calculatePlayerPoints(stats, rules, 'DEF')).toBe(10);
    });

    it('scores sacks', () => {
      const stats = makeStats({ defSacks: 5, defPointsAllowed: 17 });
      // 5 * 1 = 5  +  17 pts allowed -> 1
      // Total: 5 + 1 = 6
      expect(calculatePlayerPoints(stats, rules, 'DEF')).toBe(6);
    });

    it('scores fumble recoveries', () => {
      const stats = makeStats({ defFumbleRec: 2, defPointsAllowed: 21 });
      // 2 * 2 = 4  +  21 pts allowed -> 0
      // Total: 4
      expect(calculatePlayerPoints(stats, rules, 'DEF')).toBe(4);
    });

    it('scores safeties', () => {
      const stats = makeStats({ defSafety: 1, defPointsAllowed: 3 });
      // 1 * 2 = 2  +  3 pts allowed -> 7
      // Total: 9
      expect(calculatePlayerPoints(stats, rules, 'DEF')).toBe(9);
    });

    it('scores a dominant defensive performance (shutout)', () => {
      const stats = makeStats({
        defTd: 1,
        defInt: 3,
        defSacks: 6,
        defFumbleRec: 2,
        defSafety: 1,
        defPointsAllowed: 0,
      });
      // 6 + 6 + 6 + 4 + 2 + 10 = 34
      expect(calculatePlayerPoints(stats, rules, 'DEF')).toBe(34);
    });

    it('scores a bad defensive game (35+ points allowed)', () => {
      const stats = makeStats({
        defSacks: 1,
        defPointsAllowed: 42,
      });
      // 1 * 1 = 1  +  42 pts allowed -> -4
      // Total: -3
      expect(calculatePlayerPoints(stats, rules, 'DEF')).toBe(-3);
    });
  });

  // -----------------------------------------------------------------------
  // calculatePlayerPoints - Edge cases
  // -----------------------------------------------------------------------
  describe('calculatePlayerPoints - edge cases', () => {
    const pprRules = makeRules();

    it('returns points for all-zero stats (only shutout bracket)', () => {
      const stats = makeStats();
      // Only defPointsAllowed = 0 contributes -> shutout bracket = 10
      expect(calculatePlayerPoints(stats, pprRules)).toBe(10);
    });

    it('returns points for all-zero stats with non-defense rules zeroed', () => {
      const rules = makeRules({
        defPointsAllowed0: 0,
        defPointsAllowed1to6: 0,
        defPointsAllowed7to13: 0,
        defPointsAllowed14to20: 0,
        defPointsAllowed21to27: 0,
        defPointsAllowed28to34: 0,
        defPointsAllowed35plus: 0,
      });
      const stats = makeStats();
      expect(calculatePlayerPoints(stats, rules)).toBe(0);
    });

    it('rounds to exactly 2 decimal places', () => {
      // Create a scenario that would produce more than 2 decimals
      const rules = makeRules({
        passYards: 0.04,
        defPointsAllowed0: 0,
        defPointsAllowed1to6: 0,
        defPointsAllowed7to13: 0,
        defPointsAllowed14to20: 0,
        defPointsAllowed21to27: 0,
        defPointsAllowed28to34: 0,
        defPointsAllowed35plus: 0,
      });
      const stats = makeStats({ passYards: 1 });
      // 1 * 0.04 = 0.04 (already 2 decimal places)
      expect(calculatePlayerPoints(stats, rules)).toBe(0.04);
    });

    it('handles fractional sacks (e.g., 3.5 sacks)', () => {
      const rules = makeRules({
        defPointsAllowed0: 0,
        defPointsAllowed1to6: 0,
        defPointsAllowed7to13: 0,
        defPointsAllowed14to20: 0,
        defPointsAllowed21to27: 0,
        defPointsAllowed28to34: 0,
        defPointsAllowed35plus: 0,
      });
      const stats = makeStats({ defSacks: 3.5 });
      // 3.5 * 1 = 3.5
      expect(calculatePlayerPoints(stats, rules)).toBe(3.5);
    });

    it('handles position being undefined', () => {
      const rules = makeRules({ tePremium: 1 });
      const stats = makeStats({ receptions: 5 });
      // No TE premium applied - should not crash
      const result = calculatePlayerPoints(stats, rules);
      expect(typeof result).toBe('number');
    });

    it('applies all bonuses simultaneously', () => {
      const rules = makeRules({
        bonus100YardRush: 2,
        bonus100YardRec: 2,
        bonus300YardPass: 3,
        defPointsAllowed0: 0,
        defPointsAllowed1to6: 0,
        defPointsAllowed7to13: 0,
        defPointsAllowed14to20: 0,
        defPointsAllowed21to27: 0,
        defPointsAllowed28to34: 0,
        defPointsAllowed35plus: 0,
      });
      const stats = makeStats({
        passYards: 350,
        rushYards: 110,
        recYards: 105,
      });
      // pass: 350 * 0.04 = 14  +  rush: 110 * 0.1 = 11  +  rec: 105 * 0.1 = 10.5
      // bonuses: 2 + 2 + 3 = 7
      // Total: 14 + 11 + 10.5 + 7 = 42.5
      expect(calculatePlayerPoints(stats, rules)).toBe(42.5);
    });

    it('does not apply bonuses when bonus fields are 0', () => {
      const rules = makeRules({
        bonus100YardRush: 0,
        bonus100YardRec: 0,
        bonus300YardPass: 0,
        defPointsAllowed0: 0,
        defPointsAllowed1to6: 0,
        defPointsAllowed7to13: 0,
        defPointsAllowed14to20: 0,
        defPointsAllowed21to27: 0,
        defPointsAllowed28to34: 0,
        defPointsAllowed35plus: 0,
      });
      const stats = makeStats({
        rushYards: 150,
        recYards: 120,
        passYards: 400,
      });
      // rush: 15  +  rec: 12  +  pass: 16  = 43 (no bonuses)
      expect(calculatePlayerPoints(stats, rules)).toBe(43);
    });
  });

  // -----------------------------------------------------------------------
  // calculatePlayerPoints - full realistic stat lines
  // -----------------------------------------------------------------------
  describe('calculatePlayerPoints - realistic stat lines', () => {
    it('scores Josh Allen week 1 type game (PPR)', () => {
      const rules = makeRules({
        defPointsAllowed0: 0,
        defPointsAllowed1to6: 0,
        defPointsAllowed7to13: 0,
        defPointsAllowed14to20: 0,
        defPointsAllowed21to27: 0,
        defPointsAllowed28to34: 0,
        defPointsAllowed35plus: 0,
      });
      const stats = makeStats({
        passYards: 297,
        passTd: 3,
        passInt: 1,
        rushYards: 56,
        rushTd: 1,
        fumblesLost: 0,
        twoPtConversions: 0,
      });
      // Pass: 297 * 0.04 = 11.88  +  3 * 4 = 12  +  1 * -2 = -2
      // Rush: 56 * 0.1 = 5.6  +  1 * 6 = 6
      // Total: 11.88 + 12 - 2 + 5.6 + 6 = 33.48
      expect(calculatePlayerPoints(stats, rules, 'QB')).toBe(33.48);
    });

    it('scores Christian McCaffrey type game (PPR)', () => {
      const rules = makeRules({
        defPointsAllowed0: 0,
        defPointsAllowed1to6: 0,
        defPointsAllowed7to13: 0,
        defPointsAllowed14to20: 0,
        defPointsAllowed21to27: 0,
        defPointsAllowed28to34: 0,
        defPointsAllowed35plus: 0,
      });
      const stats = makeStats({
        rushYards: 89,
        rushTd: 1,
        receptions: 7,
        recYards: 52,
        recTd: 1,
        fumblesLost: 0,
      });
      // Rush: 89 * 0.1 = 8.9  +  6
      // Rec: 7 * 1 = 7  +  52 * 0.1 = 5.2  +  6
      // Total: 8.9 + 6 + 7 + 5.2 + 6 = 33.1
      expect(calculatePlayerPoints(stats, rules, 'RB')).toBe(33.1);
    });

    it('scores Tyreek Hill type game (half PPR)', () => {
      const rules = makeRules({
        receptions: 0.5,
        defPointsAllowed0: 0,
        defPointsAllowed1to6: 0,
        defPointsAllowed7to13: 0,
        defPointsAllowed14to20: 0,
        defPointsAllowed21to27: 0,
        defPointsAllowed28to34: 0,
        defPointsAllowed35plus: 0,
      });
      const stats = makeStats({
        receptions: 11,
        recYards: 145,
        recTd: 2,
        rushYards: 8,
      });
      // Rec: 11 * 0.5 = 5.5  +  145 * 0.1 = 14.5  +  2 * 6 = 12
      // Rush: 8 * 0.1 = 0.8
      // Total: 5.5 + 14.5 + 12 + 0.8 = 32.8
      expect(calculatePlayerPoints(stats, rules, 'WR')).toBe(32.8);
    });

    it('scores Travis Kelce type game with TE premium', () => {
      const rules = makeRules({
        tePremium: 0.5,
        defPointsAllowed0: 0,
        defPointsAllowed1to6: 0,
        defPointsAllowed7to13: 0,
        defPointsAllowed14to20: 0,
        defPointsAllowed21to27: 0,
        defPointsAllowed28to34: 0,
        defPointsAllowed35plus: 0,
      });
      const stats = makeStats({
        receptions: 8,
        recYards: 92,
        recTd: 1,
      });
      // Rec: 8 * 1 = 8  +  92 * 0.1 = 9.2  +  6
      // TE Premium: 8 * 0.5 = 4
      // Total: 8 + 9.2 + 6 + 4 = 27.2
      expect(calculatePlayerPoints(stats, rules, 'TE')).toBe(27.2);
    });
  });

  // -----------------------------------------------------------------------
  // calculateRemainingStats
  // -----------------------------------------------------------------------
  describe('calculateRemainingStats', () => {
    it('subtracts actual from projected for positive remainder', () => {
      const actual = makeStats({
        passYards: 150,
        passTd: 1,
        rushYards: 20,
        receptions: 0,
        recYards: 0,
        recTd: 0,
      });
      const projected = makeStats({
        passYards: 280,
        passTd: 2,
        rushYards: 35,
        receptions: 0,
        recYards: 0,
        recTd: 0,
      });

      const remaining = calculateRemainingStats(actual, projected);

      expect(remaining.passYards).toBe(130);
      expect(remaining.passTd).toBe(1);
      expect(remaining.rushYards).toBe(15);
    });

    it('clamps negative remaining to zero', () => {
      const actual = makeStats({
        passYards: 300,
        passTd: 3,
        rushYards: 50,
      });
      const projected = makeStats({
        passYards: 250,
        passTd: 2,
        rushYards: 30,
      });

      const remaining = calculateRemainingStats(actual, projected);

      expect(remaining.passYards).toBe(0);
      expect(remaining.passTd).toBe(0);
      expect(remaining.rushYards).toBe(0);
    });

    it('handles zero actuals (game not started)', () => {
      const actual = makeStats();
      const projected = makeStats({
        passYards: 275,
        passTd: 2,
        passInt: 1,
        rushYards: 30,
        rushTd: 0,
        receptions: 0,
        recYards: 0,
        recTd: 0,
        fumblesLost: 0,
      });

      const remaining = calculateRemainingStats(actual, projected);

      expect(remaining.passYards).toBe(275);
      expect(remaining.passTd).toBe(2);
      expect(remaining.passInt).toBe(1);
      expect(remaining.rushYards).toBe(30);
    });

    it('always sets defPointsAllowed to 0 (handled separately)', () => {
      const actual = makeStats({ defPointsAllowed: 14 });
      const projected = makeStats({ defPointsAllowed: 21 });

      const remaining = calculateRemainingStats(actual, projected);

      expect(remaining.defPointsAllowed).toBe(0);
    });

    it('calculates remaining for receiving stats', () => {
      const actual = makeStats({
        receptions: 3,
        recYards: 40,
        recTd: 0,
      });
      const projected = makeStats({
        receptions: 6,
        recYards: 85,
        recTd: 1,
      });

      const remaining = calculateRemainingStats(actual, projected);

      expect(remaining.receptions).toBe(3);
      expect(remaining.recYards).toBe(45);
      expect(remaining.recTd).toBe(1);
    });

    it('calculates remaining for kicking stats', () => {
      const actual = makeStats({
        fgMade: 1,
        fgMissed: 0,
        patMade: 2,
        patMissed: 0,
      });
      const projected = makeStats({
        fgMade: 2,
        fgMissed: 1,
        patMade: 3,
        patMissed: 0,
      });

      const remaining = calculateRemainingStats(actual, projected);

      expect(remaining.fgMade).toBe(1);
      expect(remaining.fgMissed).toBe(1);
      expect(remaining.patMade).toBe(1);
      expect(remaining.patMissed).toBe(0);
    });

    it('calculates remaining for defensive stats', () => {
      const actual = makeStats({
        defTd: 0,
        defInt: 1,
        defSacks: 2,
        defFumbleRec: 0,
        defSafety: 0,
      });
      const projected = makeStats({
        defTd: 1,
        defInt: 2,
        defSacks: 4,
        defFumbleRec: 1,
        defSafety: 0,
      });

      const remaining = calculateRemainingStats(actual, projected);

      expect(remaining.defTd).toBe(1);
      expect(remaining.defInt).toBe(1);
      expect(remaining.defSacks).toBe(2);
      expect(remaining.defFumbleRec).toBe(1);
      expect(remaining.defSafety).toBe(0);
    });

    it('calculates remaining for turnovers', () => {
      const actual = makeStats({
        passInt: 1,
        fumblesLost: 0,
      });
      const projected = makeStats({
        passInt: 1,
        fumblesLost: 1,
      });

      const remaining = calculateRemainingStats(actual, projected);

      expect(remaining.passInt).toBe(0);
      expect(remaining.fumblesLost).toBe(1);
    });

    it('calculates remaining for two-point conversions', () => {
      const actual = makeStats({ twoPtConversions: 0 });
      const projected = makeStats({ twoPtConversions: 1 });

      const remaining = calculateRemainingStats(actual, projected);

      expect(remaining.twoPtConversions).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // calculateProjectedBonuses
  // -----------------------------------------------------------------------
  describe('calculateProjectedBonuses', () => {
    it('returns 0 when no bonus rules are set', () => {
      const rules = makeRules({
        bonus100YardRush: 0,
        bonus100YardRec: 0,
        bonus300YardPass: 0,
      });
      const actual = makeStats({ rushYards: 80 });
      const projected = makeStats({ rushYards: 120 });

      expect(calculateProjectedBonuses(actual, projected, rules)).toBe(0);
    });

    it('awards rush bonus when projected to reach 100 but not yet earned', () => {
      const rules = makeRules({ bonus100YardRush: 2 });
      const actual = makeStats({ rushYards: 60 });
      const projected = makeStats({ rushYards: 110 });

      expect(calculateProjectedBonuses(actual, projected, rules)).toBe(2);
    });

    it('does not award rush bonus when already earned', () => {
      const rules = makeRules({ bonus100YardRush: 2 });
      const actual = makeStats({ rushYards: 105 });
      const projected = makeStats({ rushYards: 130 });

      expect(calculateProjectedBonuses(actual, projected, rules)).toBe(0);
    });

    it('does not award rush bonus when not projected to reach threshold', () => {
      const rules = makeRules({ bonus100YardRush: 2 });
      const actual = makeStats({ rushYards: 40 });
      const projected = makeStats({ rushYards: 80 });

      expect(calculateProjectedBonuses(actual, projected, rules)).toBe(0);
    });

    it('awards receiving bonus when projected to reach 100', () => {
      const rules = makeRules({ bonus100YardRec: 2 });
      const actual = makeStats({ recYards: 70 });
      const projected = makeStats({ recYards: 115 });

      expect(calculateProjectedBonuses(actual, projected, rules)).toBe(2);
    });

    it('does not award receiving bonus when already earned', () => {
      const rules = makeRules({ bonus100YardRec: 2 });
      const actual = makeStats({ recYards: 110 });
      const projected = makeStats({ recYards: 130 });

      expect(calculateProjectedBonuses(actual, projected, rules)).toBe(0);
    });

    it('awards passing bonus when projected to reach 300', () => {
      const rules = makeRules({ bonus300YardPass: 3 });
      const actual = makeStats({ passYards: 180 });
      const projected = makeStats({ passYards: 320 });

      expect(calculateProjectedBonuses(actual, projected, rules)).toBe(3);
    });

    it('does not award passing bonus when already earned', () => {
      const rules = makeRules({ bonus300YardPass: 3 });
      const actual = makeStats({ passYards: 310 });
      const projected = makeStats({ passYards: 380 });

      expect(calculateProjectedBonuses(actual, projected, rules)).toBe(0);
    });

    it('awards multiple bonuses simultaneously', () => {
      const rules = makeRules({
        bonus100YardRush: 2,
        bonus100YardRec: 2,
        bonus300YardPass: 3,
      });
      const actual = makeStats({
        rushYards: 50,
        recYards: 60,
        passYards: 200,
      });
      const projected = makeStats({
        rushYards: 120,
        recYards: 110,
        passYards: 350,
      });

      expect(calculateProjectedBonuses(actual, projected, rules)).toBe(7);
    });

    it('awards only unearned bonuses when some are already achieved', () => {
      const rules = makeRules({
        bonus100YardRush: 2,
        bonus100YardRec: 2,
        bonus300YardPass: 3,
      });
      const actual = makeStats({
        rushYards: 110, // already earned
        recYards: 60,
        passYards: 200,
      });
      const projected = makeStats({
        rushYards: 140,
        recYards: 105,
        passYards: 330,
      });

      // Only rec (2) + pass (3) = 5, rush already earned
      expect(calculateProjectedBonuses(actual, projected, rules)).toBe(5);
    });

    it('returns 0 when all bonuses already earned', () => {
      const rules = makeRules({
        bonus100YardRush: 2,
        bonus100YardRec: 2,
        bonus300YardPass: 3,
      });
      const actual = makeStats({
        rushYards: 120,
        recYards: 110,
        passYards: 330,
      });
      const projected = makeStats({
        rushYards: 140,
        recYards: 130,
        passYards: 380,
      });

      expect(calculateProjectedBonuses(actual, projected, rules)).toBe(0);
    });
  });
});
