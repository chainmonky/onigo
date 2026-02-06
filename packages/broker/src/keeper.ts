/**
 * Keeper Client
 *
 * HTTP client for fetching hit cells from the keeper service.
 */

import { config } from "./config.js";
import type { GridCell } from "./types.js";

type RoundPhase = "BETTING" | "LIVE" | "SETTLING" | "SETTLED";

type KeeperRoundInfo = {
  roundId: number;
  phase: RoundPhase;
  roundStartTime: number;
  roundEndTime: number;
};

type KeeperHitCellsResponse = {
  marketId: number;
  roundId: number;
  hitCells: {
    timeSlotStart: string;
    dataRangeStart: string;
  }[];
};

/**
 * Client for interacting with the keeper service.
 */
export class KeeperClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    // this.baseUrl = baseUrl ?? config.KEEPER_URL;
    this.baseUrl = "http://localhost:3003";
    console.log(`[KeeperClient] Initialized with URL: ${this.baseUrl}`);
  }

  /**
   * Get hit cells for a specific round.
   *
   * @throws Error if keeper is unavailable or round not found
   */
  async getHitCells(marketId: number, roundId: number): Promise<GridCell[]> {
    const url = `${this.baseUrl}/api/markets/${marketId}/rounds/${roundId}/hit-cells`;
    console.log(`[KeeperClient] Fetching hit cells: ${url}`);

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Keeper returned ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as KeeperHitCellsResponse;

      const hitCells: GridCell[] = data.hitCells.map((cell) => ({
        timeSlotStart: BigInt(cell.timeSlotStart),
        dataRangeStart: BigInt(cell.dataRangeStart),
      }));

      console.log(`[KeeperClient] Got ${hitCells.length} hit cells`);
      return hitCells;
    } catch (error) {
      console.error(`[KeeperClient] Error fetching hit cells:`, error);
      throw error;
    }
  }

  /**
   * Get current round phase for a market.
   */
  async getRoundPhase(marketId: number): Promise<KeeperRoundInfo> {
    const url = `${this.baseUrl}/api/markets/${marketId}/current-round`;
    console.log(`[KeeperClient] Fetching round phase: ${url}`);

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Keeper returned ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as KeeperRoundInfo;
      console.log(`[KeeperClient] Round ${data.roundId} phase: ${data.phase}`);
      return data;
    } catch (error) {
      console.error(`[KeeperClient] Error fetching round phase:`, error);
      throw error;
    }
  }

  /**
   * Check if keeper is available.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Mock hit cells for testing when keeper is not available.
 *
 * @param marketId - Market ID
 * @param roundId - Round ID
 * @param count - Number of mock cells to generate
 * @returns Array of mock grid cells
 */
export function getMockHitCells(marketId: number, roundId: number, count = 5): GridCell[] {
  console.log(`[KeeperClient] Using MOCK hit cells (keeper unavailable)`);

  // Generate mock cells based on market/round for deterministic testing
  const baseTime = BigInt(Math.floor(Date.now() / 1000) - 300); // 5 minutes ago
  const cells: GridCell[] = [];

  for (let i = 0; i < count; i++) {
    cells.push({
      timeSlotStart: baseTime + BigInt(i * 10), // 60 second slots
      dataRangeStart: BigInt(3000 + i * 200), // Mock price ranges
    });
  }

  return cells;
}
