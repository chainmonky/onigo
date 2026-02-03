/**
 * Broker Service
 *
 * Main entry point for the broker service.
 * - Connects to Yellow Network ClearNode
 * - Accepts bets from players via WebSocket API
 * - Records bets in memory
 * - Handles settlement when requested
 */

import WebSocket, { WebSocketServer } from "ws";
import { ethers } from "ethers";
import { createWalletClient, http, decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetLedgerBalancesMessage,
  createCloseAppSessionMessage,
  parseAuthChallengeResponse,
  parseAnyRPCResponse,
  RPCMethod,
} from "@erc7824/nitrolite";

import { config, validateConfig } from "./config.js";
import { BetManager } from "./betManager.js";
import { Settler } from "./settler.js";
import { KeeperClient, getMockHitCells } from "./keeper.js";
import { computePayouts } from "./payout.js";
import type { Bet, BetData, GridCell } from "./types.js";
import { BET_DATA_ABI } from "./types.js";

// Validate config at startup
validateConfig();

// --- Wallet Setup ---

const ethersWallet = new ethers.Wallet(config.BROKER_PRIVATE_KEY);
const BROKER_ADDRESS = ethersWallet.address as `0x${string}`;

const messageSigner = async (payload: unknown): Promise<`0x${string}`> => {
  const message = JSON.stringify(payload, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  const digestHex = ethers.id(message);
  const messageBytes = ethers.getBytes(digestHex);
  const { serialized: signature } = ethersWallet.signingKey.sign(messageBytes);
  return signature as `0x${string}`;
};

// Viem wallet client for EIP-712 auth signing
const viemAccount = privateKeyToAccount(config.BROKER_PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({
  account: viemAccount,
  chain: baseSepolia,
  transport: http(),
});

// Random session key (ephemeral)
const sessionKeyPrivate = generatePrivateKey();
const sessionKeyAccount = privateKeyToAccount(sessionKeyPrivate);
const SESSION_KEY_ADDRESS = sessionKeyAccount.address;

console.log(`Broker address: ${BROKER_ADDRESS}`);
console.log(`Session key:    ${SESSION_KEY_ADDRESS}`);
console.log(`ClearNode:      ${config.CLEARNODE_URL}`);
console.log(`API port:       ${config.BROKER_API_PORT}\n`);

// --- Services ---

const betManager = new BetManager();
const settler = new Settler();
const keeperClient = new KeeperClient();

// --- Helpers ---

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 15000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error("Timed out waiting for message"));
    }, timeoutMs);

    function handler(data: WebSocket.Data) {
      const raw = typeof data === "string" ? data : data.toString();
      try {
        const msg = JSON.parse(raw);
        const res = msg.res as unknown[];
        if (res?.[1] === "error") {
          clearTimeout(timeout);
          ws.removeListener("message", handler);
          reject(
            new Error(
              `ClearNode error: ${JSON.stringify((res[2] as Record<string, unknown>)?.error)}`
            )
          );
          return;
        }
        if (predicate(msg)) {
          clearTimeout(timeout);
          ws.removeListener("message", handler);
          resolve(msg);
        }
      } catch {
        // ignore
      }
    }

    ws.on("message", handler);
  });
}

async function signPayload(payload: unknown[]): Promise<`0x${string}`> {
  const message = JSON.stringify(payload);
  const digestHex = ethers.id(message);
  const messageBytes = ethers.getBytes(digestHex);
  const { serialized: signature } = ethersWallet.signingKey.sign(messageBytes);
  return signature as `0x${string}`;
}

function decodeBetData(hex: Hex) {
  const [result] = decodeAbiParameters(BET_DATA_ABI, hex);
  return result;
}

function encodeBetData(roundId: bigint, bets: Bet[]): Hex {
  return encodeAbiParameters(BET_DATA_ABI, [{ roundId, bets }]);
}

// --- Player Session Types ---

type PlayerSession = {
  playerAddress: `0x${string}`;
  appSessionId: string;
  allocations: { participant: `0x${string}`; asset: string; amount: string }[];
  bets: Bet[];
  roundId: bigint;
  marketId: number;
  version: number;
};

type CreateSessionRequest = {
  type: "create_session";
  playerAddress: string;
  amount: string;
  marketId: string;
  roundId: string;
  bets: {
    amount: string;
    cells: { timeSlotStart: string; dataRangeStart: string }[];
  }[];
  payload: unknown[];
  playerSignature: string;
};

type CloseSessionRequest = {
  type: "close_session";
  playerAddress: string;
  playerPayout: string;
  brokerPayout: string;
};

type SettleRoundRequest = {
  type: "settle_round";
  marketId: number;
  roundId: number;
};

// Player sessions state
const playerSessions = new Map<string, PlayerSession>();
let clearNodeWs: WebSocket | null = null;

// --- Session Handlers ---

async function handleCreateSession(
  request: CreateSessionRequest,
  clientWs: WebSocket
): Promise<void> {
  const playerAddress = request.playerAddress as `0x${string}`;
  const amount = request.amount;
  const marketId = parseInt(request.marketId);
  const roundId = BigInt(request.roundId);
  const bets: Bet[] = request.bets.map((b) => ({
    amount: BigInt(b.amount),
    cells: b.cells.map((c) => ({
      timeSlotStart: BigInt(c.timeSlotStart),
      dataRangeStart: BigInt(c.dataRangeStart),
    })),
  }));

  console.log(`\n[CREATE SESSION] from ${playerAddress}`);
  console.log(`   amount: ${amount}, marketId: ${marketId}, roundId: ${roundId}`);

  if (!clearNodeWs) {
    clientWs.send(JSON.stringify({
      type: "session_error",
      error: "Broker not connected to ClearNode",
    }));
    return;
  }

  try {
    const payload = request.payload;
    const playerSignature = request.playerSignature;

    console.log(`   Player signature: ${playerSignature.slice(0, 20)}...`);

    // Broker co-signs the same payload
    const brokerSignature = await signPayload(payload as unknown[]);
    console.log(`   Broker signature: ${brokerSignature.slice(0, 20)}...`);

    // Submit with both signatures (player first since they're participant[0])
    const multiSigRequest = {
      req: payload,
      sig: [playerSignature, brokerSignature],
    };

    const sessionResponsePromise = waitForMessage(
      clearNodeWs,
      (msg) =>
        !!((msg.res as unknown[])?.length &&
          ((msg.res as string[])[1] === "create_app_session" ||
            (msg.res as string[])[1] === "app_session_created"))
    );

    clearNodeWs.send(JSON.stringify(multiSigRequest));
    const sessionResponse = await sessionResponsePromise;
    const resData = (sessionResponse.res as unknown[])[2];
    const sessionData = Array.isArray(resData) ? resData[0] : resData;
    const appSessionId = (sessionData as Record<string, unknown>)?.app_session_id as string;

    if (!appSessionId) {
      throw new Error(`Failed to create app session: ${JSON.stringify(sessionResponse)}`);
    }

    const allocations = [
      { participant: playerAddress, asset: "ytest.usd", amount },
      { participant: BROKER_ADDRESS, asset: "ytest.usd", amount: "0" },
    ];

    const session: PlayerSession = {
      playerAddress,
      appSessionId,
      allocations,
      bets,
      roundId,
      marketId,
      version: 1,
    };
    playerSessions.set(playerAddress, session);

    console.log(`   App session created: ${appSessionId}`);

    clientWs.send(JSON.stringify({
      type: "session_created",
      appSessionId,
    }));

    // Auto-close session to transfer funds to broker (one session per bet)
    console.log(`\n   [AUTO-CLOSE] Closing session to transfer funds to broker...`);
    await handleCloseSession({
      type: "close_session",
      playerAddress: playerAddress,
      playerPayout: "0",
      brokerPayout: amount,
    });

    // Record the bet in BetManager
    const totalAmount = bets.reduce((sum, b) => sum + b.amount, 0n);
    const betData: BetData = {
      player: playerAddress,
      marketId,
      roundId: Number(roundId),
      totalAmount,
      bets,
    };
    betManager.addBet(betData);

  } catch (err) {
    console.error(`   Error creating session:`, err);
    clientWs.send(JSON.stringify({
      type: "session_error",
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

async function handleCloseSession(request: CloseSessionRequest): Promise<void> {
  const playerAddress = request.playerAddress as `0x${string}`;
  const session = playerSessions.get(playerAddress);

  if (!session || !clearNodeWs) {
    console.log(`[CLOSE SESSION] No session found for ${playerAddress}`);
    return;
  }

  console.log(`\n[CLOSE SESSION] ${session.appSessionId}`);
  console.log(`   Player payout: ${request.playerPayout}, Broker payout: ${request.brokerPayout}`);

  try {
    const finalAllocations = [
      { participant: playerAddress, asset: "ytest.usd", amount: request.playerPayout },
      { participant: BROKER_ADDRESS, asset: "ytest.usd", amount: request.brokerPayout },
    ];

    const closeMsg = await createCloseAppSessionMessage(messageSigner, {
      app_session_id: session.appSessionId as `0x${string}`,
      allocations: finalAllocations,
    });

    const closeResponsePromise = waitForMessage(
      clearNodeWs,
      (msg) =>
        !!((msg.res as unknown[])?.length &&
          ((msg.res as string[])[1] === "close_app_session" ||
            (msg.res as string[])[1] === "app_session_closed"))
    );

    clearNodeWs.send(closeMsg);
    await closeResponsePromise;

    playerSessions.delete(playerAddress);
    console.log(`   Session closed. Funds transferred.`);
  } catch (err) {
    console.error(`   Error closing session:`, err);
  }
}

async function handleSettleRound(request: SettleRoundRequest, clientWs: WebSocket): Promise<void> {
  const { marketId, roundId } = request;
  console.log(`\n[SETTLE ROUND] market=${marketId} round=${roundId}`);

  try {
    // Get all bets for this round
    const roundBets = betManager.getRoundBets(marketId, roundId);
    if (!roundBets || roundBets.bets.length === 0) {
      clientWs.send(JSON.stringify({
        type: "settle_error",
        error: "No bets found for this round",
      }));
      return;
    }

    console.log(`   Found ${roundBets.bets.length} players with total pool: ${roundBets.totalPool}`);

    // Get hit cells from keeper (or mock if unavailable)
    let hitCells: GridCell[];
    const keeperAvailable = await keeperClient.healthCheck();

    if (keeperAvailable) {
      hitCells = await keeperClient.getHitCells(marketId, roundId);
    } else {
      console.log(`   Keeper unavailable, using mock hit cells`);
      hitCells = getMockHitCells(marketId, roundId);
    }

    console.log(`   Hit cells: ${hitCells.length}`);

    // Get market config for commission
    const market = await settler.getMarketConfig(marketId);
    console.log(`   Commission: ${market.commissionBps} bps`);

    // Compute payouts
    const payoutResult = computePayouts(roundBets.bets, hitCells, market.commissionBps);
    console.log(`   Winners: ${payoutResult.players.length}`);
    console.log(`   Total payout: ${payoutResult.totalPayout}`);

    // Settle on-chain
    const txHash = await settler.settleRound(marketId, roundId, hitCells, payoutResult);

    // Clear the round from memory
    betManager.clearRound(marketId, roundId);

    clientWs.send(JSON.stringify({
      type: "round_settled",
      marketId,
      roundId,
      txHash,
      winners: payoutResult.players.length,
      totalPayout: payoutResult.totalPayout.toString(),
    }));

  } catch (err) {
    console.error(`   Error settling round:`, err);
    clientWs.send(JSON.stringify({
      type: "settle_error",
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

// --- Main ---

async function main() {
  console.log("1. Connecting to ClearNode...");
  const ws = new WebSocket(config.CLEARNODE_URL);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(err);
  });
  console.log("   Connected.\n");

  // 2. Authenticate
  console.log("2. Authenticating...");

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const authRequestMsg = await createAuthRequestMessage({
    address: BROKER_ADDRESS,
    session_key: SESSION_KEY_ADDRESS,
    application: "onigo-broker",
    expires_at: expiresAt,
    scope: "console",
    allowances: [],
  });

  const challengePromise = waitForMessage(ws, (msg) => {
    const parsed = parseAnyRPCResponse(JSON.stringify(msg));
    return parsed.method === RPCMethod.AuthChallenge;
  });

  ws.send(authRequestMsg);
  const challengeMsg = await challengePromise;
  console.log("   Received challenge.");

  const eip712Signer = createEIP712AuthMessageSigner(
    walletClient,
    {
      scope: "console",
      session_key: SESSION_KEY_ADDRESS,
      expires_at: expiresAt,
      allowances: [],
    },
    { name: "onigo-broker" }
  );

  const authVerifyMsg = await createAuthVerifyMessage(
    eip712Signer,
    parseAuthChallengeResponse(JSON.stringify(challengeMsg))
  );

  const authResultPromise = waitForMessage(ws, (msg) => {
    const parsed = parseAnyRPCResponse(JSON.stringify(msg));
    return parsed.method === RPCMethod.AuthVerify;
  });

  ws.send(authVerifyMsg);
  const authResult = await authResultPromise;
  const authParsed = parseAnyRPCResponse(JSON.stringify(authResult));

  if (!(authParsed.params as Record<string, unknown>)?.success) {
    throw new Error("Authentication failed");
  }
  console.log("   Authenticated.\n");

  // 3. Check balance
  console.log("3. Querying ledger balance...");
  const balMsg = await createGetLedgerBalancesMessage(messageSigner);
  const balPromise = waitForMessage(ws, (m) => {
    const r = m.res as unknown[];
    return r?.[1] === "get_ledger_balances";
  });
  ws.send(balMsg);
  const balResp = await balPromise;
  const balData = (balResp.res as unknown[])[2] as Record<string, unknown>;
  const balances = (balData?.ledger_balances ?? balData?.balances) as Record<string, unknown>[] | undefined;
  const yusd = balances?.find((b) => b.asset === "ytest.usd");
  const balAmount = yusd?.amount as string | undefined;
  console.log(`   Balance: ${balAmount ?? "0"} ytest.usd\n`);

  // Store reference for API handlers
  clearNodeWs = ws;

  // 4. Verify broker role on contract
  console.log("4. Verifying broker role...");
  const isAuthorized = await settler.verifyBrokerRole();
  if (isAuthorized) {
    console.log("   Broker role verified.\n");
  } else {
    console.log("   WARNING: Not authorized as broker on contract!\n");
  }

  // 5. Start broker API server
  const wss = new WebSocketServer({ port: config.BROKER_API_PORT });
  console.log(`5. Broker API listening on port ${config.BROKER_API_PORT}\n`);

  wss.on("connection", (clientWs) => {
    console.log("[API] Client connected");

    clientWs.on("message", async (data) => {
      const raw = typeof data === "string" ? data : data.toString();
      try {
        const msg = JSON.parse(raw);
        console.log(`[API] Received: ${msg.type}`);

        switch (msg.type) {
          case "create_session":
            await handleCreateSession(msg as CreateSessionRequest, clientWs);
            break;

          case "close_session":
            await handleCloseSession(msg as CloseSessionRequest);
            clientWs.send(JSON.stringify({ type: "session_closed" }));
            break;

          case "settle_round":
            await handleSettleRound(msg as SettleRoundRequest, clientWs);
            break;

          case "get_sessions":
            const sessions = Array.from(playerSessions.entries()).map(([addr, s]) => ({
              playerAddress: addr,
              appSessionId: s.appSessionId,
              marketId: s.marketId,
              roundId: s.roundId.toString(),
              betsCount: s.bets.length,
            }));
            clientWs.send(JSON.stringify({ type: "sessions", sessions }));
            break;

          case "get_bets":
            const summary = betManager.getSummary();
            clientWs.send(JSON.stringify({ type: "bets", rounds: summary }));
            break;

          case "get_broker_address":
            clientWs.send(JSON.stringify({ type: "broker_address", address: BROKER_ADDRESS }));
            break;

          default:
            console.log(`[API] Unknown message type: ${msg.type}`);
        }
      } catch (err) {
        console.error("[API] Error processing message:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("[API] Client disconnected");
    });
  });

  // 6. Listen for ClearNode events
  console.log("6. Listening for ClearNode events...\n");

  ws.on("message", async (data) => {
    const raw = typeof data === "string" ? data : data.toString();
    try {
      const msg = JSON.parse(raw);
      const res = msg.res as unknown[];
      if (!res?.length) return;

      const method = res[1] as string;
      const payload = Array.isArray(res[2]) ? res[2][0] : res[2];
      const typed = payload as Record<string, unknown>;

      switch (method) {
        case "create_app_session":
        case "app_session_created":
          console.log(`[SESSION CREATED] ${typed.app_session_id}`);
          break;

        case "close_app_session":
        case "app_session_closed":
          console.log(`[SESSION CLOSED] ${typed.app_session_id}`);
          break;

        case "asu": {
          const appSession = typed.app_session as Record<string, unknown> | undefined;
          if (appSession) {
            console.log(`[ASU] ${appSession.app_session_id} v${appSession.version}`);
          }
          break;
        }

        default:
          // Silently ignore other methods
          break;
      }
    } catch {
      // ignore non-JSON
    }
  });

  // Keep process running
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    ws.close();
    wss.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
