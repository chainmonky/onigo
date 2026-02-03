/**
 * Payout Computation
 *
 * Implements the parimutuel payout algorithm from tech-spec Section 9.
 */

import type { BetData, GridCell, PayoutResult } from "./types.js";

/**
 * Check if two grid cells are equal.
 */
function cellsEqual(a: GridCell, b: GridCell): boolean {
  return a.timeSlotStart === b.timeSlotStart && a.dataRangeStart === b.dataRangeStart;
}

/**
 * Count how many cells from a bet appear in the hit cells array.
 */
function countHits(betCells: GridCell[], hitCells: GridCell[]): number {
  let count = 0;
  for (const betCell of betCells) {
    if (hitCells.some((hit) => cellsEqual(betCell, hit))) {
      count++;
    }
  }
  return count;
}

/**
 * Compute payouts using parimutuel algorithm.
 *
 * Algorithm (from tech-spec Section 9):
 * 1. totalPool = sum of all bet amounts
 * 2. prizePool = totalPool - commission
 * 3. For each bet: winningStake = amount * hitCount / totalCells
 * 4. totalWinningStake = sum of all winning stakes
 * 5. For each winner: payout = winningStake * prizePool / totalWinningStake
 *
 * @param bets - All bets for the round
 * @param hitCells - Cells that were hit (from keeper)
 * @param commissionBps - Commission in basis points (e.g., 200 = 2%)
 * @returns Payout result with players and their payouts
 */
export function computePayouts(
  bets: BetData[],
  hitCells: GridCell[],
  commissionBps: number
): PayoutResult {
  // Step 1: Calculate total pool
  let totalPool = 0n;
  for (const betData of bets) {
    totalPool += betData.totalAmount;
  }

  if (totalPool === 0n) {
    return { players: [], payouts: [], totalPayout: 0n };
  }

  // Step 2: Calculate prize pool (after commission)
  const commission = (totalPool * BigInt(commissionBps)) / 10000n;
  const prizePool = totalPool - commission;

  // Step 3: Calculate winning stake for each player
  // Aggregate by player (sum all bets from same player)
  const playerWinningStakes = new Map<`0x${string}`, bigint>();

  for (const betData of bets) {
    let playerWinningStake = playerWinningStakes.get(betData.player) ?? 0n;

    // Process each individual bet within this BetData
    for (const bet of betData.bets) {
      const hitCount = countHits(bet.cells, hitCells);
      const totalCells = bet.cells.length;

      if (hitCount > 0 && totalCells > 0) {
        // winningStake = bet.amount * hitCount / totalCells
        const winningStake = (bet.amount * BigInt(hitCount)) / BigInt(totalCells);
        playerWinningStake += winningStake;
      }
    }

    if (playerWinningStake > 0n) {
      playerWinningStakes.set(betData.player, playerWinningStake);
    }
  }

  // Step 4: Calculate total winning stake
  let totalWinningStake = 0n;
  for (const stake of playerWinningStakes.values()) {
    totalWinningStake += stake;
  }

  // Edge case: No winners
  if (totalWinningStake === 0n) {
    // Refund all players their original amounts (minus commission)
    // Commission is still taken per the spec
    const players: `0x${string}`[] = [];
    const payouts: bigint[] = [];
    let totalPayout = 0n;

    // Aggregate original amounts per player
    const playerTotals = new Map<`0x${string}`, bigint>();
    for (const betData of bets) {
      const current = playerTotals.get(betData.player) ?? 0n;
      playerTotals.set(betData.player, current + betData.totalAmount);
    }

    for (const [player, amount] of playerTotals) {
      // Refund minus commission
      const refund = amount - (amount * BigInt(commissionBps)) / 10000n;
      players.push(player);
      payouts.push(refund);
      totalPayout += refund;
    }

    return { players, payouts, totalPayout };
  }

  // Step 5: Calculate payouts for each winner
  const players: `0x${string}`[] = [];
  const payouts: bigint[] = [];
  let totalPayout = 0n;

  for (const [player, winningStake] of playerWinningStakes) {
    // payout = winningStake * prizePool / totalWinningStake
    const payout = (winningStake * prizePool) / totalWinningStake;
    players.push(player);
    payouts.push(payout);
    totalPayout += payout;
  }

  return { players, payouts, totalPayout };
}
