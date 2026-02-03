/**
 * Bet Manager
 *
 * In-memory storage for bets organized by market and round.
 */

import type { BetData, RoundBets } from "./types.js";

/**
 * Manages bet storage in memory, organized by market and round.
 *
 * Note: Bets are lost on restart (MVP limitation).
 * Future enhancement: Recover from ClearNode via get_app_sessions + sessionData.
 */
export class BetManager {
  // Key format: `${marketId}:${roundId}`
  private rounds = new Map<string, RoundBets>();

  private makeKey(marketId: number, roundId: number): string {
    return `${marketId}:${roundId}`;
  }

  /**
   * Add a bet to the manager.
   * Creates the round entry if it doesn't exist.
   */
  addBet(betData: BetData): void {
    const key = this.makeKey(betData.marketId, betData.roundId);
    let roundBets = this.rounds.get(key);

    if (!roundBets) {
      roundBets = {
        marketId: betData.marketId,
        roundId: betData.roundId,
        bets: [],
        totalPool: 0n,
      };
      this.rounds.set(key, roundBets);
    }

    // Check if player already has a bet in this round
    const existingIndex = roundBets.bets.findIndex((b) => b.player === betData.player);

    if (existingIndex >= 0) {
      // Update existing bet
      const existing = roundBets.bets[existingIndex];
      roundBets.totalPool -= existing.totalAmount;
      roundBets.bets[existingIndex] = betData;
    } else {
      // Add new bet
      roundBets.bets.push(betData);
    }

    roundBets.totalPool += betData.totalAmount;

    console.log(
      `[BetManager] Added bet: player=${betData.player.slice(0, 10)}... market=${betData.marketId} round=${betData.roundId} amount=${betData.totalAmount}`
    );
    console.log(`[BetManager] Round total pool: ${roundBets.totalPool}`);
  }

  /**
   * Get all bets for a specific round.
   */
  getRoundBets(marketId: number, roundId: number): RoundBets | undefined {
    return this.rounds.get(this.makeKey(marketId, roundId));
  }

  /**
   * Clear all bets for a specific round (after settlement).
   */
  clearRound(marketId: number, roundId: number): void {
    const key = this.makeKey(marketId, roundId);
    this.rounds.delete(key);
    console.log(`[BetManager] Cleared round: market=${marketId} round=${roundId}`);
  }

  /**
   * Get all active rounds (rounds with bets).
   */
  getActiveRounds(): RoundBets[] {
    return Array.from(this.rounds.values());
  }

  /**
   * Get summary of all active rounds.
   */
  getSummary(): { marketId: number; roundId: number; betCount: number; totalPool: string }[] {
    return Array.from(this.rounds.values()).map((r) => ({
      marketId: r.marketId,
      roundId: r.roundId,
      betCount: r.bets.length,
      totalPool: r.totalPool.toString(),
    }));
  }
}
