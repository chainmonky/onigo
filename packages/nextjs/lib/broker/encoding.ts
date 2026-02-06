/**
 * Broker Encoding Utilities
 *
 * Functions for encoding bet data and building session payloads.
 */
import { BET_DATA_ABI, RPC_PROTOCOL_VERSION, usdToUnits } from "./constants";
import { encodeAbiParameters, keccak256, toBytes } from "viem";
import type { BetCell } from "~~/lib/game/types";

export type BrokerBet = {
  amount: string; // In USDC units (6 decimals)
  cells: {
    timeSlotStart: string;
    dataRangeStart: string;
  }[];
};

export type SessionPayload = {
  requestId: number;
  method: "create_app_session";
  params: {
    definition: {
      application: string;
      protocol: string;
      participants: [`0x${string}`, `0x${string}`];
      weights: [number, number];
      quorum: number;
      challenge: number;
      nonce: number;
    };
    allocations: {
      participant: `0x${string}`;
      asset: string;
      amount: string;
    }[];
    session_data: `0x${string}`;
  };
  timestamp: number;
};

/**
 * Encode bet data for session_data field
 */
export function encodeBetData(roundId: number, bets: BrokerBet[]): `0x${string}` {
  const encoded = encodeAbiParameters(BET_DATA_ABI, [
    {
      roundId: BigInt(roundId),
      bets: bets.map(b => ({
        amount: BigInt(b.amount),
        cells: b.cells.map(c => ({
          timeSlotStart: BigInt(c.timeSlotStart),
          dataRangeStart: BigInt(c.dataRangeStart),
        })),
      })),
    },
  ]);
  return encoded;
}

/**
 * Build the create_app_session payload
 */
export function buildSessionPayload(
  playerAddress: `0x${string}`,
  brokerAddress: `0x${string}`,
  marketId: number,
  roundId: number,
  betAmountUsd: number,
  cells: BetCell[],
): { payload: unknown[]; bets: BrokerBet[] } {
  const amountUnits = usdToUnits(betAmountUsd);

  // Convert cells to broker format
  const brokerCells = cells.map(cell => ({
    timeSlotStart: cell.timeSlotStart.toString(),
    dataRangeStart: cell.dataRangeStart.toString(),
  }));

  const bets: BrokerBet[] = [
    {
      amount: amountUnits,
      cells: brokerCells,
    },
  ];

  // Encode bet data for session_data
  const encodedBetData = encodeBetData(roundId, bets);

  // Build payload
  const requestId = Math.floor(Math.random() * 1000000);
  const timestamp = Date.now();

  const appDefinition = {
    application: "onigo",
    protocol: RPC_PROTOCOL_VERSION,
    participants: [playerAddress, brokerAddress] as [`0x${string}`, `0x${string}`],
    weights: [0, 100], // Broker-controlled
    quorum: 100,
    challenge: 0,
    nonce: Date.now(),
  };

  const allocations = [
    { participant: playerAddress, asset: "ytest.usd", amount: amountUnits },
    { participant: brokerAddress, asset: "ytest.usd", amount: "0" },
  ];

  const payload = [
    requestId,
    "create_app_session",
    {
      definition: appDefinition,
      allocations,
      session_data: encodedBetData,
    },
    timestamp,
  ];

  return { payload, bets };
}

/**
 * Get the message hash for signing
 * Matches the broker's signPayload function
 */
export function getPayloadHash(payload: unknown[]): `0x${string}` {
  const message = JSON.stringify(payload);
  return keccak256(toBytes(message));
}
