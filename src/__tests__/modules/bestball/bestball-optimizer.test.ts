import { optimizeBestballLineup, OptimizeInput } from '../../../modules/bestball/bestball-optimizer';
import { PositionSlot, LineupSlots } from '../../../modules/lineups/lineups.model';

describe('BestballOptimizer', () => {
  const createPlayer = (id: number, position: string) => ({ id, position });

  const createInput = (
    slotCounts: Partial<Record<PositionSlot, number>>,
    players: Array<{ id: number; position: string }>,
    points: Record<number, number>
  ): OptimizeInput => ({
    slotCounts,
    players,
    pointsByPlayerId: new Map(Object.entries(points).map(([k, v]) => [parseInt(k), v])),
  });

  describe('basic assignment', () => {
    it('assigns QB to QB slot', () => {
      const input = createInput(
        { QB: 1 },
        [createPlayer(1, 'QB')],
        { 1: 20 }
      );

      const result = optimizeBestballLineup(input);

      expect(result.lineupSlots.QB).toEqual([1]);
      expect(result.starterPlayerIds).toEqual([1]);
      expect(result.benchPlayerIds).toEqual([]);
    });

    it('assigns multiple RBs to RB slots', () => {
      const input = createInput(
        { RB: 2 },
        [createPlayer(1, 'RB'), createPlayer(2, 'RB'), createPlayer(3, 'RB')],
        { 1: 15, 2: 20, 3: 10 }
      );

      const result = optimizeBestballLineup(input);

      // RB2 (20pts) and RB1 (15pts) should start
      expect(result.lineupSlots.RB).toHaveLength(2);
      expect(result.lineupSlots.RB).toContain(1);
      expect(result.lineupSlots.RB).toContain(2);
      expect(result.benchPlayerIds).toEqual([3]);
    });

    it('fills multiple position slots correctly', () => {
      const input = createInput(
        { QB: 1, RB: 2, WR: 2, TE: 1 },
        [
          createPlayer(1, 'QB'),
          createPlayer(2, 'RB'),
          createPlayer(3, 'RB'),
          createPlayer(4, 'WR'),
          createPlayer(5, 'WR'),
          createPlayer(6, 'TE'),
        ],
        { 1: 25, 2: 18, 3: 15, 4: 20, 5: 12, 6: 8 }
      );

      const result = optimizeBestballLineup(input);

      expect(result.lineupSlots.QB).toEqual([1]);
      expect(result.lineupSlots.RB).toHaveLength(2);
      expect(result.lineupSlots.WR).toHaveLength(2);
      expect(result.lineupSlots.TE).toEqual([6]);
      expect(result.starterPlayerIds).toHaveLength(6);
      expect(result.benchPlayerIds).toEqual([]);
    });
  });

  describe('FLEX slot optimization', () => {
    it('uses FLEX for highest-scoring eligible player', () => {
      const input = createInput(
        { RB: 1, WR: 1, FLEX: 1 },
        [
          createPlayer(1, 'RB'),
          createPlayer(2, 'RB'),
          createPlayer(3, 'WR'),
        ],
        { 1: 20, 2: 18, 3: 15 }
      );

      const result = optimizeBestballLineup(input);

      // RB1 (20pts) goes to RB, RB2 (18pts) goes to FLEX, WR3 goes to WR
      expect(result.lineupSlots.RB).toContain(1);
      expect(result.lineupSlots.FLEX).toHaveLength(1);
      expect(result.starterPlayerIds).toContain(2); // RB2 in FLEX
    });

    it('puts higher-scoring WR in FLEX when better than TE', () => {
      const input = createInput(
        { WR: 2, TE: 1, FLEX: 1 },
        [
          createPlayer(1, 'WR'),
          createPlayer(2, 'WR'),
          createPlayer(3, 'WR'),
          createPlayer(4, 'TE'),
        ],
        { 1: 20, 2: 18, 3: 15, 4: 8 }
      );

      const result = optimizeBestballLineup(input);

      // WR1 and WR2 in WR slots, WR3 in FLEX, TE4 in TE
      expect(result.lineupSlots.WR).toHaveLength(2);
      expect(result.lineupSlots.TE).toEqual([4]);
      expect(result.lineupSlots.FLEX).toHaveLength(1);
      expect(result.starterPlayerIds).toContain(3);
    });
  });

  describe('SUPER_FLEX optimization', () => {
    it('puts QB in SUPER_FLEX when optimal', () => {
      const input = createInput(
        { QB: 1, RB: 1, SUPER_FLEX: 1 },
        [
          createPlayer(1, 'QB'),
          createPlayer(2, 'QB'),
          createPlayer(3, 'RB'),
        ],
        { 1: 25, 2: 22, 3: 15 }
      );

      const result = optimizeBestballLineup(input);

      // QB1 in QB slot, QB2 in SUPER_FLEX (beats RB)
      expect(result.lineupSlots.QB).toContain(1);
      expect(result.lineupSlots.SUPER_FLEX).toContain(2);
      expect(result.lineupSlots.RB).toContain(3);
    });

    it('puts RB in SUPER_FLEX when higher than backup QB', () => {
      const input = createInput(
        { QB: 1, RB: 1, SUPER_FLEX: 1 },
        [
          createPlayer(1, 'QB'),
          createPlayer(2, 'QB'),
          createPlayer(3, 'RB'),
          createPlayer(4, 'RB'),
        ],
        { 1: 25, 2: 10, 3: 22, 4: 18 }
      );

      const result = optimizeBestballLineup(input);

      // QB1 in QB, RB3 (22) in SUPER_FLEX, RB4 in RB, QB2 benched
      expect(result.lineupSlots.QB).toContain(1);
      expect(result.starterPlayerIds).toContain(3); // RB3 should start
      expect(result.benchPlayerIds).toContain(2); // QB2 benched
    });
  });

  describe('REC_FLEX optimization', () => {
    it('only allows WR and TE in REC_FLEX', () => {
      const input = createInput(
        { WR: 1, TE: 1, REC_FLEX: 1 },
        [
          createPlayer(1, 'WR'),
          createPlayer(2, 'WR'),
          createPlayer(3, 'TE'),
          createPlayer(4, 'RB'), // RB not eligible for REC_FLEX
        ],
        { 1: 20, 2: 18, 3: 10, 4: 25 }
      );

      const result = optimizeBestballLineup(input);

      // RB should be benched despite highest points (not eligible)
      expect(result.benchPlayerIds).toContain(4);
      expect(result.lineupSlots.REC_FLEX).toHaveLength(1);
      // WR2 or TE should be in REC_FLEX
      expect(
        result.lineupSlots.REC_FLEX.includes(2) || result.lineupSlots.REC_FLEX.includes(3)
      ).toBe(true);
    });
  });

  describe('IDP slots', () => {
    it('assigns IDP positions correctly', () => {
      const input = createInput(
        { DL: 1, LB: 1, DB: 1 },
        [
          createPlayer(1, 'DL'),
          createPlayer(2, 'LB'),
          createPlayer(3, 'DB'),
        ],
        { 1: 10, 2: 12, 3: 8 }
      );

      const result = optimizeBestballLineup(input);

      expect(result.lineupSlots.DL).toEqual([1]);
      expect(result.lineupSlots.LB).toEqual([2]);
      expect(result.lineupSlots.DB).toEqual([3]);
    });

    it('optimizes IDP_FLEX correctly', () => {
      const input = createInput(
        { LB: 1, IDP_FLEX: 1 },
        [
          createPlayer(1, 'LB'),
          createPlayer(2, 'LB'),
          createPlayer(3, 'DL'),
        ],
        { 1: 15, 2: 12, 3: 18 }
      );

      const result = optimizeBestballLineup(input);

      // DL3 (18pts) should go to IDP_FLEX, LB1 (15pts) to LB
      expect(result.starterPlayerIds).toContain(1);
      expect(result.starterPlayerIds).toContain(3);
      expect(result.benchPlayerIds).toContain(2);
    });
  });

  describe('determinism', () => {
    it('produces same output for same input', () => {
      const input = createInput(
        { QB: 1, RB: 2, WR: 2, FLEX: 1 },
        [
          createPlayer(5, 'QB'),
          createPlayer(3, 'RB'),
          createPlayer(1, 'RB'),
          createPlayer(4, 'WR'),
          createPlayer(2, 'WR'),
          createPlayer(6, 'RB'),
        ],
        { 1: 15, 2: 18, 3: 20, 4: 12, 5: 25, 6: 16 }
      );

      const result1 = optimizeBestballLineup(input);
      const result2 = optimizeBestballLineup(input);

      expect(result1.lineupSlots).toEqual(result2.lineupSlots);
      expect(result1.starterPlayerIds).toEqual(result2.starterPlayerIds);
      expect(result1.benchPlayerIds).toEqual(result2.benchPlayerIds);
    });

    it('tie-breaker uses lower player ID', () => {
      const input = createInput(
        { RB: 1 },
        [
          createPlayer(10, 'RB'),
          createPlayer(5, 'RB'),
        ],
        { 10: 15, 5: 15 } // Same points
      );

      const result = optimizeBestballLineup(input);

      // Lower ID (5) should win the tie
      expect(result.lineupSlots.RB).toEqual([5]);
      expect(result.benchPlayerIds).toEqual([10]);
    });
  });

  describe('edge cases', () => {
    it('handles partial fill when fewer eligible players than slots', () => {
      const input = createInput(
        { QB: 2, RB: 2 },
        [
          createPlayer(1, 'QB'),
          createPlayer(2, 'RB'),
        ],
        { 1: 20, 2: 15 }
      );

      const result = optimizeBestballLineup(input);

      expect(result.lineupSlots.QB).toEqual([1]);
      expect(result.lineupSlots.RB).toEqual([2]);
      expect(result.benchPlayerIds).toEqual([]);
    });

    it('handles empty player list', () => {
      const input = createInput(
        { QB: 1, RB: 2 },
        [],
        {}
      );

      const result = optimizeBestballLineup(input);

      expect(result.lineupSlots.QB).toEqual([]);
      expect(result.lineupSlots.RB).toEqual([]);
      expect(result.starterPlayerIds).toEqual([]);
      expect(result.benchPlayerIds).toEqual([]);
    });

    it('handles zero-point players', () => {
      const input = createInput(
        { QB: 1, RB: 1 },
        [
          createPlayer(1, 'QB'),
          createPlayer(2, 'RB'),
        ],
        { 1: 0, 2: 0 }
      );

      const result = optimizeBestballLineup(input);

      // Should still assign players even with 0 points
      expect(result.lineupSlots.QB).toEqual([1]);
      expect(result.lineupSlots.RB).toEqual([2]);
    });

    it('handles negative points (defensive stats)', () => {
      const input = createInput(
        { RB: 1 },
        [
          createPlayer(1, 'RB'),
          createPlayer(2, 'RB'),
        ],
        { 1: -2, 2: 5 }
      );

      const result = optimizeBestballLineup(input);

      // Player 2 with positive points should be preferred
      expect(result.lineupSlots.RB).toEqual([2]);
      expect(result.benchPlayerIds).toEqual([1]);
    });

    it('handles players with missing points (defaults to 0)', () => {
      const input = createInput(
        { RB: 1 },
        [
          createPlayer(1, 'RB'),
          createPlayer(2, 'RB'),
        ],
        { 1: 10 } // Player 2 has no points entry
      );

      const result = optimizeBestballLineup(input);

      // Player 1 with 10 points should start
      expect(result.lineupSlots.RB).toEqual([1]);
      expect(result.benchPlayerIds).toEqual([2]);
    });
  });

  describe('complex lineup configurations', () => {
    it('optimizes full standard lineup', () => {
      const input = createInput(
        { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 },
        [
          createPlayer(1, 'QB'),
          createPlayer(2, 'RB'),
          createPlayer(3, 'RB'),
          createPlayer(4, 'RB'),
          createPlayer(5, 'WR'),
          createPlayer(6, 'WR'),
          createPlayer(7, 'WR'),
          createPlayer(8, 'TE'),
          createPlayer(9, 'K'),
          createPlayer(10, 'DEF'),
        ],
        { 1: 25, 2: 20, 3: 18, 4: 15, 5: 22, 6: 16, 7: 10, 8: 8, 9: 10, 10: 12 }
      );

      const result = optimizeBestballLineup(input);

      expect(result.lineupSlots.QB).toEqual([1]);
      expect(result.lineupSlots.RB).toHaveLength(2);
      expect(result.lineupSlots.WR).toHaveLength(2);
      expect(result.lineupSlots.TE).toEqual([8]);
      expect(result.lineupSlots.FLEX).toHaveLength(1);
      expect(result.lineupSlots.K).toEqual([9]);
      expect(result.lineupSlots.DEF).toEqual([10]);
      expect(result.starterPlayerIds).toHaveLength(9);
      expect(result.benchPlayerIds).toHaveLength(1);
    });

    it('optimizes superflex league configuration', () => {
      const input = createInput(
        { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER_FLEX: 1 },
        [
          createPlayer(1, 'QB'),
          createPlayer(2, 'QB'),
          createPlayer(3, 'RB'),
          createPlayer(4, 'RB'),
          createPlayer(5, 'RB'),
          createPlayer(6, 'WR'),
          createPlayer(7, 'WR'),
          createPlayer(8, 'TE'),
        ],
        { 1: 30, 2: 25, 3: 20, 4: 18, 5: 15, 6: 17, 7: 14, 8: 10 }
      );

      const result = optimizeBestballLineup(input);

      expect(result.lineupSlots.QB).toHaveLength(1);
      expect(result.lineupSlots.SUPER_FLEX).toHaveLength(1);
      // Both QBs should start (one in QB, one in SUPER_FLEX)
      expect(result.starterPlayerIds).toContain(1);
      expect(result.starterPlayerIds).toContain(2);
    });
  });
});
