/**
 * End-to-End Simulation: Full betting round lifecycle
 *
 * This script simulates the complete flow:
 * 1. Connect to Broker and Keeper services
 * 2. User places a bet during betting phase
 * 3. Monitor live round with real-time price/hit updates from Keeper
 * 4. Keeper calculates hit cells when round ends
 * 5. Trigger settlement via Broker
 *
 * Prerequisites:
 * - Keeper service running on ws://localhost:3001 (Socket.IO)
 * - Broker service running on ws://localhost:3002 (native WebSocket)
 *
 * Usage:
 *   PLAYER_PRIVATE_KEY=0x... yarn e2e-sim
 *
 * Environment:
 *   PLAYER_PRIVATE_KEY - Player's wallet private key
 *   BROKER_URL - Broker WebSocket URL (default: ws://localhost:3002)
 *   KEEPER_URL - Keeper WebSocket URL (default: ws://localhost:3001)
 *   BET_AMOUNT - Amount to bet in smallest units (default: 1000000 = 1 USDC)
 */

import "dotenv/config";
import WebSocket from "ws";
import { io, Socket } from "socket.io-client";
import { ethers } from "ethers";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, localhost } from "viem/chains";
import { RPCProtocolVersion } from "@erc7824/nitrolite";

// ============================================================================
// Configuration
// ============================================================================

const PLAYER_PRIVATE_KEY = process.env.PLAYER_PRIVATE_KEY ?? process.env.SENDER_PRIVATE_KEY;
const BROKER_PRIVATE_KEY = process.env.RECEIVER_PRIVATE_KEY; // For market creation (owner)
const BROKER_URL = process.env.BROKER_URL ?? "ws://localhost:3002";
const KEEPER_URL = process.env.KEEPER_URL ?? "ws://localhost:3001";
const BET_AMOUNT = "5000000";
const MARKET_ID = parseInt(process.env.MARKET_ID ?? "1");
const RPC_URL = process.env.RPC_URL ?? "https://base-sepolia-rpc.publicnode.com ";
const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "84532");
const ONIGO_CONTRACT_ADDRESS = process.env.ONIGO_CONTRACT_ADDRESS as `0x${string}`;

if (!PLAYER_PRIVATE_KEY) {
  console.error("Required: PLAYER_PRIVATE_KEY (or SENDER_PRIVATE_KEY)");
  process.exit(1);
}

if (!BROKER_PRIVATE_KEY) {
  console.error("Required: RECEIVER_PRIVATE_KEY (broker/owner key for market creation)");
  process.exit(1);
}

if (!ONIGO_CONTRACT_ADDRESS) {
  console.error("Required: ONIGO_CONTRACT_ADDRESS");
  process.exit(1);
}

const wallet = new ethers.Wallet(PLAYER_PRIVATE_KEY);
const PLAYER_ADDRESS = wallet.address as `0x${string}`;

// ============================================================================
// Onigo Contract ABI (minimal for market creation)
// ============================================================================

const ONIGO_ABI = [
  {
    name: "createMarket",
    type: "function",
    inputs: [
      { name: "_marketName", type: "string" },
      { name: "_dataPower", type: "int8" },
      { name: "_dataIncrement", type: "uint32" },
      { name: "_timeSlotWidth", type: "uint32" },
      { name: "_roundLength", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "numMarkets",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
    stateMutability: "view",
  },
  {
    name: "markets",
    type: "function",
    inputs: [{ name: "marketId", type: "uint16" }],
    outputs: [
      { name: "commissionBps", type: "uint8" },
      { name: "dataPower", type: "int8" },
      { name: "marketId", type: "uint16" },
      { name: "dataIncrement", type: "uint32" },
      { name: "timeSlotWidth", type: "uint32" },
      { name: "marketStartTime", type: "uint256" },
      { name: "roundLength", type: "uint256" },
      { name: "marketName", type: "string" },
    ],
    stateMutability: "view",
  },
  {
    name: "owner",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

// Market config matching keeper settings
const MARKET_CONFIGS = [
  {
    name: "BTC/USDC",
    dataPower: 0,
    dataIncrement: 200,
    timeSlotWidth: 10,
    roundLength: 120,
  },
  {
    name: "ETH/USDC",
    dataPower: 0,
    dataIncrement: 20,
    timeSlotWidth: 10,
    roundLength: 120,
  },
];

// ============================================================================
// ABI Encoding for BetData
// ============================================================================

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

// ============================================================================
// Types
// ============================================================================

// Keeper message types (Socket.IO)
interface KeeperGridCell {
  priceRangeStart: number;
  priceRangeEnd: number;
  timeRangeStart: number;
  timeRangeEnd: number;
}

interface KeeperRoundStartPayload {
  marketId: number;
  roundId: number;
  phase: "BETTING" | "LIVE" | "SETTLING";
  initialPrice: number;
  gridBounds: {
    rows: number[];
    columns: number[];
    minPrice: number;
    maxPrice: number;
    startTime: number;
    endTime: number;
  };
  timing: {
    roundStartTime: number;
    bettingEndTime: number;
    liveEndTime: number;
  };
  config: {
    priceIncrement: number;
    timeIncrement: number;
  };
}

interface KeeperPriceUpdatePayload {
  marketId: number;
  roundId: number;
  price: number;
  timestamp: number;
  source: string;
  hitCells: KeeperGridCell[];
  gridBounds: KeeperRoundStartPayload["gridBounds"] | null;
}

interface KeeperRoundEndPayload {
  marketId: number;
  roundId: number;
  phase: "SETTLING";
  hitCells: KeeperGridCell[];
  priceHistory: { price: number; timestamp: number; source: string }[];
  summary: {
    startPrice: number | null;
    endPrice: number | null;
    pricePoints: number;
    hitCellCount: number;
  };
}

type KeeperMessage =
  | { type: "CONNECTED" }
  | { type: "SUBSCRIBED"; payload: { marketId: number } }
  | { type: "ROUND_START"; payload: KeeperRoundStartPayload }
  | { type: "PHASE_CHANGE"; payload: { marketId: number; roundId: number; phase: string } }
  | { type: "PRICE_UPDATE"; payload: KeeperPriceUpdatePayload }
  | { type: "ROUND_END"; payload: KeeperRoundEndPayload };

// Broker message types (native WebSocket)
interface BrokerRoundSettled {
  type: "round_settled";
  marketId: number;
  roundId: number;
  txHash: string;
  winners: number;
  totalPayout: string;
}

interface BrokerSessionCreated {
  type: "session_created";
  appSessionId: string;
}

interface BrokerSessionError {
  type: "session_error";
  error: string;
}

interface BrokerBrokerAddress {
  type: "broker_address";
  address: `0x${string}`;
}

// ============================================================================
// Utility Functions
// ============================================================================

async function signPayload(payload: unknown[]): Promise<`0x${string}`> {
  const message = JSON.stringify(payload);
  const digestHex = ethers.id(message);
  const messageBytes = ethers.getBytes(digestHex);
  
  // Use RAW ECDSA signing (NO EIP-191 prefix) - matches ClearNode expectation
  const { serialized: signature } = wallet.signingKey.sign(messageBytes);
  return signature as `0x${string}`;
}

function formatPrice(price: number): string {
  return `$${price.toLocaleString()}`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString();
}

// ============================================================================
// Simulation State
// ============================================================================

// Bet cell tracking
interface BetCell {
  timeSlotStart: string;
  dataRangeStart: string;
}

interface SimulationState {
  brokerWs: WebSocket | null;
  keeperSocket: Socket | null;
  brokerAddress: `0x${string}` | null;
  currentRound: {
    roundId: number;
    phase: string;
    initialPrice: number;
    gridBounds: KeeperRoundStartPayload["gridBounds"] | null;
    config: KeeperRoundStartPayload["config"] | null;
    timing: KeeperRoundStartPayload["timing"] | null;
    hitCells: KeeperGridCell[];
    priceUpdates: number;
  } | null;
  betPlaced: boolean;
  appSessionId: string | null;
  betCells: BetCell[]; // Track which cells were bet on
  betAmount: string;
}

const state: SimulationState = {
  brokerWs: null,
  keeperSocket: null,
  brokerAddress: null,
  currentRound: null,
  betPlaced: false,
  appSessionId: null,
  betCells: [],
  betAmount: "0",
};

// ============================================================================
// Broker Connection (Native WebSocket)
// ============================================================================

async function connectToBroker(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("STEP 1: Connecting to Broker Service (WebSocket)");
  console.log("=".repeat(60));
  console.log(`Broker URL: ${BROKER_URL}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BROKER_URL);

    ws.on("open", () => {
      console.log("  Connected to Broker via WebSocket.");
      state.brokerWs = ws;
      resolve();
    });

    ws.on("error", (err: Error) => {
      console.error("  Broker connection error:", err.message);
      reject(err);
    });

    ws.on("close", () => {
      console.log("  Broker connection closed.");
      state.brokerWs = null;
    });
  });
}

async function getBrokerAddress(): Promise<void> {
  if (!state.brokerWs) throw new Error("Broker not connected");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout getting broker address")), 10000);

    const messageHandler = (data: WebSocket.Data) => {
      try {
        const raw = typeof data === "string" ? data : data.toString();
        const msg = JSON.parse(raw) as BrokerBrokerAddress;

        if (msg.type === "broker_address") {
          clearTimeout(timeout);
          state.brokerWs!.removeListener("message", messageHandler);
          state.brokerAddress = msg.address;
          console.log(`  Broker address: ${state.brokerAddress}`);
          resolve();
        }
      } catch {
        // ignore parse errors
      }
    };

    state.brokerWs!.on("message", messageHandler);
    state.brokerWs!.send(JSON.stringify({ type: "get_broker_address" }));
  });
}

// ============================================================================
// Keeper Connection (Socket.IO)
// ============================================================================

async function connectToKeeper(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("STEP 2: Connecting to Keeper Service (Socket.IO)");
  console.log("=".repeat(60));
  console.log(`Keeper URL: ${KEEPER_URL}`);

  return new Promise((resolve, reject) => {
    const socket = io(KEEPER_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 10000,
    });

    socket.on("connect", () => {
      console.log("  Connected to Keeper via Socket.IO.");
      state.keeperSocket = socket;
      resolve();
    });

    socket.on("connect_error", (err: Error) => {
      console.error("  Keeper connection error:", err.message);
      reject(err);
    });

    socket.on("disconnect", (reason: string) => {
      console.log("  Keeper connection closed:", reason);
      state.keeperSocket = null;
    });
  });
}

async function subscribeToMarket(): Promise<void> {
  if (!state.keeperSocket) throw new Error("Keeper not connected");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout subscribing to market")), 10000);

    state.keeperSocket!.once("SUBSCRIBED", (data: { marketId: number }) => {
      if (data.marketId === MARKET_ID) {
        clearTimeout(timeout);
        console.log(`  Subscribed to market ${MARKET_ID}`);
        resolve();
      }
    });

    state.keeperSocket!.emit("SUBSCRIBE", { marketId: MARKET_ID });
  });
}

// ============================================================================
// Bet Placement
// ============================================================================

async function placeBet(roundId: number, gridBounds: KeeperRoundStartPayload["gridBounds"]): Promise<void> {
  if (!state.brokerWs || !state.brokerAddress || !state.currentRound?.config) {
    throw new Error("Broker not connected or round config not available");
  }

  console.log("\n" + "=".repeat(60));
  console.log("STEP 3: Placing Bet");
  console.log("=".repeat(60));

  const priceIncrement = state.currentRound.config.priceIncrement;

  // Choose cells strategically based on current grid bounds
  // Place bets on cells near the center of the grid (where price is likely to stay)
  const centerPriceIndex = Math.floor(gridBounds.rows.length / 2);
  const centerPrice = gridBounds.rows[centerPriceIndex];

  // Bet on 3 cells across different time slots - spread across price range
  const cells: BetCell[] = [
    {
      timeSlotStart: gridBounds.columns[0].toString(),
      dataRangeStart: centerPrice.toString(),
    },
    {
      timeSlotStart: gridBounds.columns[1].toString(),
      dataRangeStart: centerPrice.toString(),
    },
    {
      timeSlotStart: gridBounds.columns[2].toString(),
      dataRangeStart: (centerPrice + priceIncrement).toString(), // One row up
    },
  ];

  // Store bet cells for later comparison
  state.betCells = cells;
  state.betAmount = BET_AMOUNT;

  const bets = [{ amount: BET_AMOUNT, cells }];

  // Calculate per-cell cost
  const totalBetUnits = parseInt(BET_AMOUNT);
  const perCellUnits = Math.floor(totalBetUnits / cells.length);
  const perCellUSD = (perCellUnits / 1000000).toFixed(2); // Assuming 6 decimals

  console.log(`  Player: ${PLAYER_ADDRESS}`);
  console.log(`  Total Amount: ${BET_AMOUNT} units (${(totalBetUnits / 1000000).toFixed(2)} USDC)`);
  console.log(`  Per Cell: ~${perCellUSD} USDC`);
  console.log(`  Round ID: ${roundId}`);
  console.log(`  Market ID: ${MARKET_ID}`);
  console.log(`  Number of cells: ${cells.length}`);
  console.log(`  Bet Cells:`);
  cells.forEach((c, i) => {
    const timeStr = formatTime(parseInt(c.timeSlotStart));
    console.log(`    [${i}] Time: ${timeStr} (${c.timeSlotStart}), Price: ${formatPrice(parseInt(c.dataRangeStart))}`);
  });

  // Encode BetData for session_data
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

  // Build create_app_session payload
  const timestamp = Date.now();
  const requestId = Math.floor(Math.random() * 1000000);

  const appDefinition = {
    application: "onigo",
    protocol: RPCProtocolVersion.NitroRPC_0_2,
    participants: [PLAYER_ADDRESS, state.brokerAddress],
    weights: [0, 100], // Broker-controlled
    quorum: 100,
    challenge: 0,
    nonce: Date.now(),
  };

  const allocations = [
    { participant: PLAYER_ADDRESS, asset: "ytest.usd", amount: BET_AMOUNT },
    { participant: state.brokerAddress, asset: "ytest.usd", amount: "0" },
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
  console.log(`  Player signature: ${playerSignature.slice(0, 20)}...`);


console.log("[DEBUG] Player signing:");
console.log("  Payload:", JSON.stringify(payload));
console.log("  Signature:", playerSignature);

  const createRequest = {
    type: "create_session",
    playerAddress: PLAYER_ADDRESS,
    amount: BET_AMOUNT,
    marketId: MARKET_ID.toString(),
    roundId: roundId.toString(),
    bets,
    payload,
    playerSignature,
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout creating session")), 60000);

    const messageHandler = (data: WebSocket.Data) => {
      try {
        const raw = typeof data === "string" ? data : data.toString();
        const msg = JSON.parse(raw) as BrokerSessionCreated | BrokerSessionError;

        if (msg.type === "session_created") {
          clearTimeout(timeout);
          state.brokerWs!.removeListener("message", messageHandler);
          state.appSessionId = msg.appSessionId;
          state.betPlaced = true;
          console.log(`  Session created: ${msg.appSessionId}`);
          console.log("  Bet placed successfully!");
          resolve();
        } else if (msg.type === "session_error") {
          clearTimeout(timeout);
          state.brokerWs!.removeListener("message", messageHandler);
          console.error(`  Error: ${msg.error}`);
          reject(new Error(msg.error));
        }
      } catch {
        // ignore parse errors
      }
    };

    state.brokerWs!.on("message", messageHandler);
    state.brokerWs!.send(JSON.stringify(createRequest));
  });
}

// ============================================================================
// Round Monitoring
// ============================================================================

function setupKeeperEventHandlers(): void {
  if (!state.keeperSocket) return;

  state.keeperSocket.on("ROUND_START", (payload: KeeperRoundStartPayload) => {
    handleRoundStart(payload);
  });

  state.keeperSocket.on("PHASE_CHANGE", (payload: { marketId: number; roundId: number; phase: string }) => {
    handlePhaseChange(payload);
  });

  state.keeperSocket.on("PRICE_UPDATE", (payload: KeeperPriceUpdatePayload) => {
    handlePriceUpdate(payload);
  });

  state.keeperSocket.on("ROUND_END", (payload: KeeperRoundEndPayload) => {
    handleRoundEnd(payload);
  });
}

function handleRoundStart(payload: KeeperRoundStartPayload): void {
  console.log("\n" + "=".repeat(60));
  console.log(`ROUND ${payload.roundId} STARTED`);
  console.log("=".repeat(60));
  console.log(`  Phase: ${payload.phase}`);
  console.log(`  Initial price: ${formatPrice(payload.initialPrice)}`);
  console.log(`  Betting ends: ${formatTime(payload.timing.bettingEndTime)}`);
  console.log(`  Round ends: ${formatTime(payload.timing.liveEndTime)}`);
  console.log(`  Grid: ${payload.gridBounds.rows.length} rows x ${payload.gridBounds.columns.length} columns`);
  console.log(`  Price increment: ${formatPrice(payload.config.priceIncrement)}`);
  console.log(`  Time increment: ${payload.config.timeIncrement}s`);

  state.currentRound = {
    roundId: payload.roundId,
    phase: payload.phase,
    initialPrice: payload.initialPrice,
    gridBounds: payload.gridBounds,
    config: payload.config,
    timing: payload.timing,
    hitCells: [],
    priceUpdates: 0,
  };

  // If we're in betting phase and haven't placed a bet, place one now
  if (payload.phase === "BETTING" && !state.betPlaced) {
    placeBet(payload.roundId, payload.gridBounds).catch(console.error);
  }
}

function handlePhaseChange(payload: { marketId: number; roundId: number; phase: string }): void {
  console.log("\n" + "-".repeat(40));
  console.log(`PHASE CHANGE: ${payload.phase}`);
  console.log("-".repeat(40));

  if (state.currentRound) {
    state.currentRound.phase = payload.phase;
  }

  if (payload.phase === "LIVE") {
    console.log("  Live phase started - monitoring price updates...");
  }
}

function handlePriceUpdate(payload: KeeperPriceUpdatePayload): void {
  if (!state.currentRound) return;

  state.currentRound.priceUpdates++;
  state.currentRound.hitCells = payload.hitCells;

  // Print update every 5 seconds (or every 5 updates)
  if (state.currentRound.priceUpdates % 5 === 1) {
    console.log(
      `  [${formatTime(payload.timestamp)}] Price: ${formatPrice(payload.price)} | ` +
        `Cells hit: ${payload.hitCells.length} | Source: ${payload.source}`
    );
  }
}

async function handleRoundEnd(payload: KeeperRoundEndPayload): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log(`ROUND ${payload.roundId} ENDED`);
  console.log("=".repeat(60));
  console.log(`  Price points collected: ${payload.summary.pricePoints}`);
  console.log(`  Start price: ${formatPrice(payload.summary.startPrice ?? 0)}`);
  console.log(`  End price: ${formatPrice(payload.summary.endPrice ?? 0)}`);
  console.log(`  Total cells hit by price: ${payload.summary.hitCellCount}`);

  // Print hit cells grid visualization
  printHitCellsVisualization(payload.hitCells, state.currentRound?.gridBounds);
  

  // Convert keeper hit cells to broker format for settlement
  // Keeper uses: priceRangeStart, timeRangeStart
  // Broker uses: dataRangeStart, timeSlotStart
  const hitCellsForBroker = payload.hitCells.map((cell) => ({
    timeSlotStart: cell.timeRangeStart.toString(),
    dataRangeStart: cell.priceRangeStart.toString(),
  }));

  // Build hit set for quick lookup
  const hitSet = new Set(
    payload.hitCells.map((c) => `${c.priceRangeStart}:${c.timeRangeStart}`)
  );

  // ========== BET vs HIT COMPARISON ==========
  if (state.betPlaced && state.betCells.length > 0) {
    console.log("\n" + "-".repeat(40));
    console.log("BET RESULTS:");
    console.log("-".repeat(40));

    let hitCount = 0;
    let missCount = 0;

    state.betCells.forEach((betCell, i) => {
      const key = `${betCell.dataRangeStart}:${betCell.timeSlotStart}`;
      const isHit = hitSet.has(key);
      const status = isHit ? "✓ HIT" : "✗ MISS";

      if (isHit) hitCount++;
      else missCount++;

      const timeStr = formatTime(parseInt(betCell.timeSlotStart));
      console.log(
        `  [${i}] ${status} - Price: ${formatPrice(parseInt(betCell.dataRangeStart))}, Time: ${timeStr}`
      );
    });

    console.log("-".repeat(40));
    console.log(`  Total Bet Cells: ${state.betCells.length}`);
    console.log(`  Cells Hit: ${hitCount} (${((hitCount / state.betCells.length) * 100).toFixed(1)}%)`);
    console.log(`  Cells Missed: ${missCount}`);
    console.log(`  Bet Amount: ${state.betAmount} units`);

    // Calculate estimated winnings (simplified)
    if (hitCount > 0) {
      const hitRatio = hitCount / state.betCells.length;
      const estimatedWinUnits = Math.floor(parseInt(state.betAmount) * hitRatio);
      const estimatedWinUSD = (estimatedWinUnits / 1000000).toFixed(2);
      console.log(`  Estimated Win Ratio: ${(hitRatio * 100).toFixed(1)}% of stake`);
      console.log(`  Estimated Win: ~${estimatedWinUSD} USDC (before pool distribution)`);
    } else {
      console.log(`  Result: No winning cells - bet lost`);
    }
    console.log("-".repeat(40));
  }

  // Show hit cells for reference
  console.log("\n  All hit cells from keeper:");
  hitCellsForBroker.slice(0, 10).forEach((c, i) => {
    const timeStr = formatTime(parseInt(c.timeSlotStart));
    console.log(`    [${i}] Price: ${formatPrice(parseInt(c.dataRangeStart))}, Time: ${timeStr}`);
  });
  if (hitCellsForBroker.length > 10) {
    console.log(`    ... and ${hitCellsForBroker.length - 10} more`);
  }

  // Trigger settlement if we placed a bet
  if (state.betPlaced) {
    await triggerSettlement(payload.roundId, hitCellsForBroker);
  }
}

function printHitCellsVisualization(
  hitCells: KeeperGridCell[],
  gridBounds: KeeperRoundStartPayload["gridBounds"] | null | undefined
): void {
  if (!gridBounds) return;

  console.log("\n  Grid visualization (X=hit, B=bet, W=WIN!):");

  const hitSet = new Set(hitCells.map((c) => `${c.priceRangeStart}:${c.timeRangeStart}`));

  // Build bet set from state
  const betSet = new Set(
    state.betCells.map((c) => `${c.dataRangeStart}:${c.timeSlotStart}`)
  );

  // Print header row (column indices)
  const header =
    "         " +
    gridBounds.columns
      .slice(0, 8)
      .map((_, i) => `Col${i}`.padStart(6))
      .join("");
  console.log(header);

  // Print each row (limited to first 8 rows for readability)
  for (const row of gridBounds.rows.slice(0, 8)) {
    const rowLabel = `$${row}`.padStart(8);
    const cells = gridBounds.columns.slice(0, 8).map((col) => {
      const key = `${row}:${col}`;
      const isHit = hitSet.has(key);
      const isBet = betSet.has(key);

      if (isHit && isBet) return "  [W] "; // WIN - both hit and bet
      if (isHit) return "  [X] ";          // Hit by price
      if (isBet) return "  [B] ";          // Bet placed but missed
      return "  [ ] ";                      // Empty
    });
    console.log(rowLabel + cells.join(""));
  }

  if (gridBounds.rows.length > 8 || gridBounds.columns.length > 8) {
    console.log("         ... (grid truncated for display)");
  }
  console.log("  Legend: X=price hit, B=your bet, W=WIN (bet+hit)");
}

// ============================================================================
// Settlement
// ============================================================================

async function triggerSettlement(roundId: number, hitCells: { timeSlotStart: string; dataRangeStart: string }[]): Promise<void> {
  if (!state.brokerWs) {
    console.error("Broker not connected for settlement");
    return;
  }

  console.log("\n" + "=".repeat(60));
  console.log("STEP 4: Triggering Settlement");
  console.log("=".repeat(60));
  console.log(`  Market ID: ${MARKET_ID}`);
  console.log(`  Round ID: ${roundId}`);
  console.log(`  Hit cells: ${hitCells.length}`);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log("  Settlement request timed out (this is expected if no on-chain contract)");
      state.brokerWs!.removeListener("message", messageHandler);
      resolve();
    }, 60000);

    const messageHandler = (data: WebSocket.Data) => {
      try {
        const raw = typeof data === "string" ? data : data.toString();
        const msg = JSON.parse(raw) as BrokerRoundSettled | BrokerSessionError;

        if (msg.type === "round_settled") {
          clearTimeout(timeout);
          state.brokerWs!.removeListener("message", messageHandler);
          console.log("  Settlement successful!");
          console.log(`    TX Hash: ${msg.txHash}`);
          console.log(`    Winners: ${msg.winners}`);
          console.log(`    Total Payout: ${msg.totalPayout}`);
          resolve();
        } 
      } catch {
        // ignore parse errors
      }
    };

    state.brokerWs!.on("message", messageHandler);
    state.brokerWs!.send(JSON.stringify({
      type: "settle_round",
      marketId: MARKET_ID,
      roundId,
      hitCells,
    }));
  });
}

// ============================================================================
// On-Chain Market Setup
// ============================================================================

async function ensureMarketExists(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("STEP 0: Checking/Creating Market On-Chain");
  console.log("=".repeat(60));

  const chain = CHAIN_ID === 31337 ? localhost : baseSepolia;
  const brokerAccount = privateKeyToAccount(BROKER_PRIVATE_KEY as `0x${string}`);

  console.log(`  Contract: ${ONIGO_CONTRACT_ADDRESS}`);
  console.log(`  Owner/Broker: ${brokerAccount.address}`);
  console.log(`  Chain: ${chain.name} (${CHAIN_ID})`);

  const publicClient = createPublicClient({
    chain,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    account: brokerAccount,
    chain,
    transport: http(RPC_URL),
  });

  // Check how many markets exist
  const numMarkets = await publicClient.readContract({
    address: ONIGO_CONTRACT_ADDRESS,
    abi: ONIGO_ABI,
    functionName: "numMarkets",
  });

  console.log(`  Existing markets: ${numMarkets}`);

  // Check if our market ID exists
  if (MARKET_ID <= numMarkets) {
    const market = await publicClient.readContract({
      address: ONIGO_CONTRACT_ADDRESS,
      abi: ONIGO_ABI,
      functionName: "markets",
      args: [MARKET_ID],
    });
    console.log(`  Market ${MARKET_ID} exists: ${market[7]}    ${market}`);
    console.log(`    DataIncrement: ${market[3]}, TimeSlotWidth: ${market[4]}s, RoundLength: ${market[6]}s`);
    return;
  }

  // Need to create markets up to MARKET_ID
  console.log(`  Market ${MARKET_ID} does not exist. Creating...`);

  // Verify ownership
  const owner = await publicClient.readContract({
    address: ONIGO_CONTRACT_ADDRESS,
    abi: ONIGO_ABI,
    functionName: "owner",
  });

  if ((owner as string).toLowerCase() !== brokerAccount.address.toLowerCase()) {
    throw new Error(`Account ${brokerAccount.address} is not the contract owner (${owner}). Cannot create market.`);
  }

  // Create markets up to MARKET_ID
  for (let i = numMarkets + 1; i <= MARKET_ID; i++) {
    const configIndex = i - 1;
    const config = MARKET_CONFIGS[configIndex] ?? MARKET_CONFIGS[0]; // Default to BTC config

    console.log(`\n  Creating market ${i}: ${config.name}...`);

    const txHash = await walletClient.writeContract({
      address: ONIGO_CONTRACT_ADDRESS,
      abi: ONIGO_ABI,
      functionName: "createMarket",
      args: [
        config.name,
        config.dataPower,
        config.dataIncrement,
        config.timeSlotWidth,
        BigInt(config.roundLength),
      ],
    });

    console.log(`    TX: ${txHash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === "reverted") {
      throw new Error(`Market creation reverted: ${txHash}`);
    }

    console.log(`    Market ${i} created! Block: ${receipt.blockNumber}`);
  }

  // Verify final state
  const finalMarket = await publicClient.readContract({
    address: ONIGO_CONTRACT_ADDRESS,
    abi: ONIGO_ABI,
    functionName: "markets",
    args: [MARKET_ID],
  });

  console.log(`\n  Market ${MARKET_ID} ready: ${finalMarket[7]}`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("ONIGO E2E SIMULATION");
  console.log("=".repeat(60));
  console.log(`Player:     ${PLAYER_ADDRESS}`);
  console.log(`Broker URL: ${BROKER_URL}`);
  console.log(`Keeper URL: ${KEEPER_URL}`);
  console.log(`Bet Amount: ${BET_AMOUNT}`);
  console.log(`Market ID:  ${MARKET_ID}`);
  console.log(`Contract:   ${ONIGO_CONTRACT_ADDRESS}`);

  try {
    // Step 0: Ensure market exists on-chain
    await ensureMarketExists();

    // Step 1: Connect to Broker (native WebSocket)
    await connectToBroker();
    await getBrokerAddress();

    // Step 2: Connect to Keeper (Socket.IO)
    await connectToKeeper();
    await subscribeToMarket();

    // Setup event handlers for round updates
    setupKeeperEventHandlers();

    console.log("\n" + "=".repeat(60));
    console.log("WAITING FOR ROUND TO START...");
    console.log("=".repeat(60));
    console.log("The simulation will:");
    console.log("  1. Place a bet when betting phase begins");
    console.log("  2. Monitor live price updates during LIVE phase");
    console.log("  3. Calculate hits when round ends");
    console.log("  4. Trigger settlement via Broker");
    console.log("\nPress Ctrl+C to exit at any time.\n");

    // Keep the process running
    await new Promise((resolve) => {
      process.on("SIGINT", () => {
        console.log("\n\nShutting down...");
        state.brokerWs?.close();
        state.keeperSocket?.disconnect();
        resolve(undefined);
      });
    });
  } catch (err) {
    console.error("\nSimulation error:", err);
    state.brokerWs?.close();
    state.keeperSocket?.disconnect();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});