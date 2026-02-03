/**
 * Broker Service Types
 *
 * Shared type definitions for the broker service.
 */

// Core grid cell - matches Onigo.sol GridCell struct
export type GridCell = {
  timeSlotStart: bigint;
  dataRangeStart: bigint;
};

// Single bet within a player's BetData
export type Bet = {
  amount: bigint;
  cells: GridCell[];
};

// BetData - stored per player per round
export type BetData = {
  player: `0x${string}`;
  marketId: number;
  roundId: number;
  totalAmount: bigint;
  bets: Bet[];
};

// RoundBets - all bets for a round
export type RoundBets = {
  marketId: number;
  roundId: number;
  bets: BetData[];
  totalPool: bigint;
};

// Payout result - matches settleRound() contract args
export type PayoutResult = {
  players: `0x${string}`[];
  payouts: bigint[];
  totalPayout: bigint;
};

// Market config from Onigo.sol
export type Market = {
  commissionBps: number;
  dataPower: number;
  marketId: number;
  dataIncrement: number;
  timeSlotWidth: number;
  marketStartTime: bigint;
  roundLength: bigint;
  marketName: string;
};

// ABI for encoding/decoding BetData in session_data field
export const BET_DATA_ABI = [
  {
    type: "tuple",
    components: [
      { name: "roundId", type: "uint256" },
      {
        name: "bets",
        type: "tuple[]",
        components: [
          { name: "amount", type: "uint256" },
          {
            name: "cells",
            type: "tuple[]",
            components: [
              { name: "timeSlotStart", type: "uint256" },
              { name: "dataRangeStart", type: "int256" },
            ],
          },
        ],
      },
    ],
  },
] as const;
