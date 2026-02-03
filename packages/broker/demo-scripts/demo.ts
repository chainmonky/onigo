/**
 * Demo Client: Submit bets to the Onigo Broker
 *
 * The player signs the create_session request, and the broker co-signs.
 * After session creation, the broker can update state unilaterally (weights [0, 100]).
 *
 * Usage:
 *   PLAYER_PRIVATE_KEY=0x... yarn demo
 */

import "dotenv/config";
import WebSocket from "ws";
import { ethers } from "ethers";
import { encodeAbiParameters, type Hex } from "viem";
import { RPCProtocolVersion } from "@erc7824/nitrolite";

// --- BetData ABI encoding ---

const BET_DATA_ABI = [
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

function encodeBetData(
  roundId: bigint,
  bets: { amount: bigint; cells: { timeSlotStart: bigint; dataRangeStart: bigint }[] }[]
): Hex {
  return encodeAbiParameters(BET_DATA_ABI, [{ roundId, bets }]);
}

// --- Config ---

const PLAYER_PRIVATE_KEY = process.env.PLAYER_PRIVATE_KEY ?? process.env.SENDER_PRIVATE_KEY;
const BROKER_URL = process.env.BROKER_URL ?? "ws://localhost:3001";
const BET_AMOUNT = process.env.BET_AMOUNT ?? "1000000"; // 1 USDC (6 decimals)

if (!PLAYER_PRIVATE_KEY) {
  console.error("Required: PLAYER_PRIVATE_KEY (or SENDER_PRIVATE_KEY)");
  process.exit(1);
}

const wallet = new ethers.Wallet(PLAYER_PRIVATE_KEY);
const PLAYER_ADDRESS = wallet.address as `0x${string}`;

console.log(`Player:  ${PLAYER_ADDRESS}`);
console.log(`Broker:  ${BROKER_URL}`);
console.log(`Amount:  ${BET_AMOUNT}\n`);

// --- Signer ---

async function signPayload(payload: unknown[]): Promise<`0x${string}`> {
  const message = JSON.stringify(payload);
  const digestHex = ethers.id(message);
  const messageBytes = ethers.getBytes(digestHex);
  const { serialized: signature } = wallet.signingKey.sign(messageBytes);
  return signature as `0x${string}`;
}

// --- Types ---

interface CreateSessionRequest {
  type: "create_session";
  playerAddress: string;
  amount: string;
  roundId: string;
  bets: {
    amount: string;
    cells: { timeSlotStart: string; dataRangeStart: string }[];
  }[];
  payload: unknown[];
  playerSignature: string;
}

interface SessionResponse {
  type: "session_created" | "session_error" | "state_updated";
  appSessionId?: string;
  error?: string;
}

// --- Main ---

async function main() {
  console.log("1. Connecting to broker...");
  const ws = new WebSocket(BROKER_URL);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(err);
  });
  console.log("   Connected.\n");

  // Helper to send request and wait for response
  function sendRequest<T>(request: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for response"));
      }, 30000);

      ws.once("message", (data) => {
        clearTimeout(timeout);
        const raw = typeof data === "string" ? data : data.toString();
        try {
          resolve(JSON.parse(raw) as T);
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err}`));
        }
      });

      ws.send(JSON.stringify(request));
    });
  }

  // 2. Get broker address
  console.log("2. Getting broker address...");
  const brokerInfo = await sendRequest<{ type: "broker_address"; address: string }>({
    type: "get_broker_address",
  });
  const BROKER_ADDRESS = brokerInfo.address as `0x${string}`;
  console.log(`   Broker: ${BROKER_ADDRESS}\n`);

  // 3. Create and sign a session request
  console.log("3. Creating session with bet...");

  const now = Math.floor(Date.now() / 1000);
  const roundId = "1";

  const bets = [
    {
      amount: BET_AMOUNT,
      cells: [
        { timeSlotStart: now.toString(), dataRangeStart: "3100" },
        { timeSlotStart: (now + 300).toString(), dataRangeStart: "3200" },
      ],
    },
  ];

  // Encode BetData
  const encodedBetData = encodeBetData(
    BigInt(roundId),
    bets.map((b) => ({
      amount: BigInt(b.amount),
      cells: b.cells.map((c) => ({
        timeSlotStart: BigInt(c.timeSlotStart),
        dataRangeStart: BigInt(c.dataRangeStart),
      })),
    }))
  );

  // Build the create_app_session payload that ClearNode expects
  const timestamp = Date.now();
  const requestId = Math.floor(Math.random() * 1000000);

  const appDefinition = {
    application: "onigo",
    protocol: RPCProtocolVersion.NitroRPC_0_2,
    participants: [PLAYER_ADDRESS, BROKER_ADDRESS],
    weights: [0, 100], // Broker-controlled
    quorum: 100,
    challenge: 0,
    nonce: Date.now(),
  };

  const allocations = [
    { participant: PLAYER_ADDRESS, asset: "ytest.usd", amount: BET_AMOUNT },
    { participant: BROKER_ADDRESS, asset: "ytest.usd", amount: "0" },
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

  // Sign the payload
  const playerSignature = await signPayload(payload);
  console.log(`   Player signature: ${playerSignature.slice(0, 20)}...`);
  console.log(`   Round: ${roundId}`);
  console.log(`   Cells: [${now}, 3100], [${now + 300}, 3200]`);

  const createRequest: CreateSessionRequest = {
    type: "create_session",
    playerAddress: PLAYER_ADDRESS,
    amount: BET_AMOUNT,
    roundId,
    bets,
    payload,
    playerSignature,
  };

  const createResponse = await sendRequest<SessionResponse>(createRequest);

  if (createResponse.type === "session_error") {
    console.error(`   Error: ${createResponse.error}`);
    ws.close();
    process.exit(1);
  }

  console.log(`   Session created! App session: ${createResponse.appSessionId}\n`);

  console.log("Done! Bet submitted to broker (session auto-closed).");

  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
