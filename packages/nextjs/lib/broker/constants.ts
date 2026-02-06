/**
 * Broker Constants
 */

// RPC Protocol Version from @erc7824/nitrolite
export const RPC_PROTOCOL_VERSION = "NitroRPC/0.2";

// ABI for encoding BetData in session_data field
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

// Default bet amount in smallest units (6 decimals for USDC)
// 1000000 = 1 USDC
export const USDC_DECIMALS = 6;

// Convert USD amount to USDC units
export function usdToUnits(usd: number): string {
  return Math.floor(usd * Math.pow(10, USDC_DECIMALS)).toString();
}

// Convert USDC units to USD
export function unitsToUsd(units: string | bigint): number {
  const value = typeof units === "string" ? BigInt(units) : units;
  return Number(value) / Math.pow(10, USDC_DECIMALS);
}
