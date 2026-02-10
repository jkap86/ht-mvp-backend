/**
 * Bestball lineup optimizer using min-cost max-flow algorithm.
 *
 * This implements optimal player-to-slot assignment for bestball leagues,
 * ensuring the highest-scoring lineup is selected each week.
 */

import { LineupSlots, PositionSlot } from '../lineups/lineups.model';
import { canPositionFillSlot, getStarterSlotsList, isStarterSlot } from './slot-eligibility';
import { logger } from '../../config/logger.config';

export interface OptimizeInput {
  /** Starter slot counts (e.g., { QB: 1, RB: 2, WR: 2, FLEX: 1 }) */
  slotCounts: Partial<Record<PositionSlot, number>>;
  /** Players available for optimization (excludes IR/TAXI) */
  players: Array<{ id: number; position: string }>;
  /** Points scored by each player (playerId -> points) */
  pointsByPlayerId: Map<number, number>;
}

export interface OptimizeOutput {
  /** Optimized lineup slots with player IDs */
  lineupSlots: LineupSlots;
  /** Player IDs selected as starters */
  starterPlayerIds: number[];
  /** Player IDs on bench */
  benchPlayerIds: number[];
}

/**
 * Edge in the flow network
 */
interface Edge {
  to: number;
  rev: number; // Index of reverse edge in adj[to]
  cap: number;
  cost: number;
}

/**
 * Min-cost max-flow implementation using SPFA (Bellman-Ford variant).
 * Finds maximum flow with minimum cost in a directed graph.
 */
class MinCostMaxFlow {
  private graph: Edge[][];
  private n: number;

  constructor(n: number) {
    this.n = n;
    this.graph = Array.from({ length: n }, () => []);
  }

  /**
   * Add an edge with given capacity and cost.
   * Also adds reverse edge with 0 capacity and negative cost.
   */
  addEdge(from: number, to: number, cap: number, cost: number): void {
    this.graph[from].push({ to, cap, cost, rev: this.graph[to].length });
    this.graph[to].push({ to: from, cap: 0, cost: -cost, rev: this.graph[from].length - 1 });
  }

  /**
   * Run min-cost max-flow from source to sink.
   * Returns { flow, cost } where cost is minimized for the given flow.
   */
  minCostMaxFlow(source: number, sink: number, maxFlow: number): { flow: number; cost: number } {
    let totalFlow = 0;
    let totalCost = 0;
    const INF = Number.MAX_SAFE_INTEGER;

    while (totalFlow < maxFlow) {
      // SPFA to find shortest path (min cost path)
      const dist = new Array(this.n).fill(INF);
      const inQueue = new Array(this.n).fill(false);
      const parent = new Array(this.n).fill(-1);
      const parentEdge = new Array(this.n).fill(-1);

      dist[source] = 0;
      const queue: number[] = [source];
      inQueue[source] = true;

      while (queue.length > 0) {
        const u = queue.shift()!;
        inQueue[u] = false;

        for (let i = 0; i < this.graph[u].length; i++) {
          const edge = this.graph[u][i];
          if (edge.cap > 0 && dist[u] + edge.cost < dist[edge.to]) {
            dist[edge.to] = dist[u] + edge.cost;
            parent[edge.to] = u;
            parentEdge[edge.to] = i;
            if (!inQueue[edge.to]) {
              queue.push(edge.to);
              inQueue[edge.to] = true;
            }
          }
        }
      }

      // No augmenting path found
      if (dist[sink] === INF) break;

      // Find bottleneck capacity along the path
      let pathFlow = maxFlow - totalFlow;
      let v = sink;
      while (v !== source) {
        const u = parent[v];
        const edgeIdx = parentEdge[v];
        pathFlow = Math.min(pathFlow, this.graph[u][edgeIdx].cap);
        v = u;
      }

      // Augment flow along the path
      v = sink;
      while (v !== source) {
        const u = parent[v];
        const edgeIdx = parentEdge[v];
        this.graph[u][edgeIdx].cap -= pathFlow;
        this.graph[v][this.graph[u][edgeIdx].rev].cap += pathFlow;
        v = u;
      }

      totalFlow += pathFlow;
      totalCost += pathFlow * dist[sink];
    }

    return { flow: totalFlow, cost: totalCost };
  }

  /**
   * Get the graph for result extraction
   */
  getGraph(): Edge[][] {
    return this.graph;
  }
}

/**
 * Optimize bestball lineup using min-cost max-flow.
 *
 * Creates a bipartite graph:
 * - Source connects to all players (capacity 1, cost 0)
 * - Players connect to eligible slot instances (capacity 1, cost = -points * SCALE)
 * - Slot instances connect to sink (capacity 1, cost 0)
 *
 * Using negative costs converts max-cost to min-cost problem.
 */
export function optimizeBestballLineup(input: OptimizeInput): OptimizeOutput {
  const { slotCounts, players, pointsByPlayerId } = input;

  // Scale factor for integer costs (avoid floating point issues)
  const SCALE = 1000000;

  // Build slot instances (e.g., WR:2 -> WR#0, WR#1)
  const slotInstances: Array<{ slot: PositionSlot; index: number }> = [];
  const starterSlots = getStarterSlotsList();

  // Process slots in stable order for determinism
  for (const slot of starterSlots) {
    const count = slotCounts[slot] || 0;
    for (let i = 0; i < count; i++) {
      slotInstances.push({ slot, index: i });
    }
  }

  const totalStarters = slotInstances.length;

  if (totalStarters === 0) {
    logger.warn('No starter slots configured for bestball optimization');
    return createEmptyResult(players);
  }

  // Sort players by ID for determinism
  const sortedPlayers = [...players].sort((a, b) => a.id - b.id);

  // Node indices:
  // 0 = source
  // 1 to P = players
  // P+1 to P+S = slot instances
  // P+S+1 = sink
  const P = sortedPlayers.length;
  const S = slotInstances.length;
  const source = 0;
  const sink = P + S + 1;
  const totalNodes = sink + 1;

  const mcmf = new MinCostMaxFlow(totalNodes);

  // Player node index
  const playerNode = (idx: number) => idx + 1;
  // Slot instance node index
  const slotNode = (idx: number) => P + idx + 1;

  // Add edges: source -> players
  for (let i = 0; i < P; i++) {
    mcmf.addEdge(source, playerNode(i), 1, 0);
  }

  // Add edges: players -> eligible slot instances
  // Store edge info for result extraction
  const playerToSlotEdges: Array<{
    playerIdx: number;
    slotIdx: number;
    playerId: number;
    slot: PositionSlot;
  }> = [];

  for (let i = 0; i < P; i++) {
    const player = sortedPlayers[i];
    const points = pointsByPlayerId.get(player.id) || 0;
    // Use negative cost for max-score (min-cost algorithm finds minimum)
    // Higher points = more negative cost = preferred
    const cost = Math.round(-points * SCALE);

    for (let j = 0; j < S; j++) {
      const { slot } = slotInstances[j];
      if (canPositionFillSlot(player.position, slot)) {
        mcmf.addEdge(playerNode(i), slotNode(j), 1, cost);
        playerToSlotEdges.push({
          playerIdx: i,
          slotIdx: j,
          playerId: player.id,
          slot,
        });
      }
    }
  }

  // Add edges: slot instances -> sink
  for (let j = 0; j < S; j++) {
    mcmf.addEdge(slotNode(j), sink, 1, 0);
  }

  // Run min-cost max-flow
  const { flow } = mcmf.minCostMaxFlow(source, sink, totalStarters);

  if (flow < totalStarters) {
    logger.warn(
      `Bestball optimization: could only fill ${flow}/${totalStarters} starter slots`
    );
  }

  // Extract assignments from the flow graph
  const graph = mcmf.getGraph();
  const assignments = new Map<PositionSlot, number[]>();
  const starterPlayerIds: number[] = [];
  const usedPlayerIds = new Set<number>();

  // Initialize all slots with empty arrays
  for (const slot of starterSlots) {
    assignments.set(slot, []);
  }

  // Find used edges (cap reduced to 0 on forward edges from players to slots)
  for (const edgeInfo of playerToSlotEdges) {
    const { playerIdx, slotIdx, playerId, slot } = edgeInfo;
    const playerNodeIdx = playerNode(playerIdx);

    // Find the edge from this player to this slot
    for (const edge of graph[playerNodeIdx]) {
      if (edge.to === slotNode(slotIdx) && edge.cap === 0) {
        // This edge was used
        const slotArray = assignments.get(slot) || [];
        slotArray.push(playerId);
        assignments.set(slot, slotArray);
        starterPlayerIds.push(playerId);
        usedPlayerIds.add(playerId);
        break;
      }
    }
  }

  // Sort player IDs within each slot for determinism
  for (const [slot, playerIds] of assignments) {
    playerIds.sort((a, b) => a - b);
    assignments.set(slot, playerIds);
  }

  // Build full lineup with bench
  const benchPlayerIds = sortedPlayers
    .filter((p) => !usedPlayerIds.has(p.id))
    .map((p) => p.id);

  const lineupSlots: LineupSlots = {
    QB: assignments.get('QB') || [],
    RB: assignments.get('RB') || [],
    WR: assignments.get('WR') || [],
    TE: assignments.get('TE') || [],
    FLEX: assignments.get('FLEX') || [],
    SUPER_FLEX: assignments.get('SUPER_FLEX') || [],
    REC_FLEX: assignments.get('REC_FLEX') || [],
    K: assignments.get('K') || [],
    DEF: assignments.get('DEF') || [],
    DL: assignments.get('DL') || [],
    LB: assignments.get('LB') || [],
    DB: assignments.get('DB') || [],
    IDP_FLEX: assignments.get('IDP_FLEX') || [],
    BN: benchPlayerIds,
    IR: [], // IR players excluded from input
    TAXI: [], // TAXI players excluded from input
  };

  return {
    lineupSlots,
    starterPlayerIds: starterPlayerIds.sort((a, b) => a - b),
    benchPlayerIds,
  };
}

/**
 * Create empty result when no optimization possible
 */
function createEmptyResult(players: Array<{ id: number; position: string }>): OptimizeOutput {
  const allPlayerIds = players.map((p) => p.id).sort((a, b) => a - b);
  return {
    lineupSlots: {
      QB: [],
      RB: [],
      WR: [],
      TE: [],
      FLEX: [],
      SUPER_FLEX: [],
      REC_FLEX: [],
      K: [],
      DEF: [],
      DL: [],
      LB: [],
      DB: [],
      IDP_FLEX: [],
      BN: allPlayerIds,
      IR: [],
      TAXI: [],
    },
    starterPlayerIds: [],
    benchPlayerIds: allPlayerIds,
  };
}
