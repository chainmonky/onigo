/**
 * Yellow SDK Receiver: Listen for incoming app sessions and decode BetData
 *
 * Usage:
 *   RECEIVER_PRIVATE_KEY=0x... yarn receiver
 */

import "dotenv/config";
import WebSocket, { WebSocketServer } from "ws";
import { ethers } from "ethers";
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetLedgerBalancesMessage,
  createCreateChannelMessage,
  createResizeChannelMessage,
  createCloseChannelMessage,
  createCloseAppSessionMessage,
  createApplicationMessage,
  parseAuthChallengeResponse,
  parseAnyRPCResponse,
  parseCreateChannelResponse,
  parseResizeChannelResponse,
  parseCloseChannelResponse,
  RPCMethod,
  NitroliteClient,
  WalletStateSigner,
} from "@erc7824/nitrolite";
import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import { RPCProtocolVersion } from "@erc7824/nitrolite";

// --- BetData ABI decoding ---

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

function decodeBetData(hex: Hex) {
  const [result] = decodeAbiParameters(BET_DATA_ABI, hex);
  return result;
}

function formatBetData(decoded: ReturnType<typeof decodeBetData>) {
  return {
    roundId: decoded.roundId.toString(),
    bets: decoded.bets.map((b: { amount: bigint; cells: readonly { timeSlotStart: bigint; dataRangeStart: bigint }[] }) => ({
      amount: b.amount.toString(),
      cells: b.cells.map((c: { timeSlotStart: bigint; dataRangeStart: bigint }) => ({
        timeSlotStart: c.timeSlotStart.toString(),
        dataRangeStart: c.dataRangeStart.toString(),
      })),
    })),
  };
}

// --- Config ---

const RECEIVER_PRIVATE_KEY = process.env.RECEIVER_PRIVATE_KEY;
const CLEARNODE_URL =
  process.env.CLEARNODE_URL ?? "wss://clearnet-sandbox.yellow.com/ws";
const BROKER_API_PORT = parseInt(process.env.BROKER_API_PORT ?? "3001", 10);

if (!RECEIVER_PRIVATE_KEY) {
  console.error("Required: RECEIVER_PRIVATE_KEY");
  process.exit(1);
}

const ethersWallet = new ethers.Wallet(RECEIVER_PRIVATE_KEY);
const ADDRESS = ethersWallet.address as `0x${string}`;

const messageSigner = async (payload: unknown): Promise<`0x${string}`> => {
  const message = JSON.stringify(payload, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  const digestHex = ethers.id(message);
  const messageBytes = ethers.getBytes(digestHex);
  const { serialized: signature } = ethersWallet.signingKey.sign(messageBytes);
  return signature as `0x${string}`;
};

// Viem wallet client for EIP-712 auth signing (wallet owner signs to authorize session key)
const viemAccount = privateKeyToAccount(RECEIVER_PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({
  account: viemAccount,
  chain: baseSepolia,
  transport: http(),
});

// Random session key (ephemeral — avoids "session key already exists but is expired" errors)
const sessionKeyPrivate = generatePrivateKey();
const sessionKeyAccount = privateKeyToAccount(sessionKeyPrivate);
const SESSION_KEY_ADDRESS = sessionKeyAccount.address;

// Contract addresses (Base Sepolia)
const CUSTODY_ADDRESS = "0x019B65A265EB3363822f2752141b3dF16131b262" as `0x${string}`;
const ADJUDICATOR_ADDRESS = "0x7c7ccbc98469190849BCC6c926307794fDfB11F2" as `0x${string}`;
const TOKEN_ADDRESS = "0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb" as `0x${string}`;

// Viem public client for on-chain reads
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

// NitroliteClient for on-chain withdrawal
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nitroliteClient = new NitroliteClient({
  publicClient: publicClient as any,
  walletClient: walletClient as any,
  stateSigner: new WalletStateSigner(walletClient as any),
  addresses: { custody: CUSTODY_ADDRESS, adjudicator: ADJUDICATOR_ADDRESS },
  chainId: baseSepolia.id,
  challengeDuration: 3600n,
});

console.log(`Broker address: ${ADDRESS}`);
console.log(`Session key:    ${SESSION_KEY_ADDRESS}`);
console.log(`ClearNode:      ${CLEARNODE_URL}`);
console.log(`API port:       ${BROKER_API_PORT}\n`);

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to sign a payload for co-signing
async function signPayload(payload: unknown[]): Promise<`0x${string}`> {
  const message = JSON.stringify(payload);
  const digestHex = ethers.id(message);
  const messageBytes = ethers.getBytes(digestHex);
  const { serialized: signature } = ethersWallet.signingKey.sign(messageBytes);
  return signature as `0x${string}`;
}

// Track active app sessions for co-signing
const activeAppSessions = new Map<string, { participants: string[]; version: number }>();

// --- Broker API Types ---

type GridCell = { timeSlotStart: bigint; dataRangeStart: bigint };
type Bet = { amount: bigint; cells: GridCell[] };

interface PlayerSession {
  playerAddress: `0x${string}`;
  appSessionId: string;
  allocations: { participant: `0x${string}`; asset: string; amount: string }[];
  bets: Bet[];
  roundId: bigint;
  version: number;
}

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

interface UpdateStateRequest {
  type: "update_state";
  playerAddress: string;
  bets: {
    amount: string;
    cells: { timeSlotStart: string; dataRangeStart: string }[];
  }[];
}

interface SessionResponse {
  type: "session_created" | "session_error" | "state_updated";
  appSessionId?: string;
  error?: string;
}

// Player sessions state
const playerSessions = new Map<string, PlayerSession>();
let clearNodeWs: WebSocket | null = null;

// --- Broker API Handlers ---

function encodeBetData(roundId: bigint, bets: Bet[]): Hex {
  const BET_DATA_ABI_ENCODE = [
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
  return encodeAbiParameters(BET_DATA_ABI_ENCODE, [{ roundId, bets }]);
}

async function handleCreateSession(
  request: CreateSessionRequest,
  clientWs: WebSocket
): Promise<void> {
  const playerAddress = request.playerAddress as `0x${string}`;
  const amount = request.amount;
  const roundId = BigInt(request.roundId);
  const bets: Bet[] = request.bets.map((b) => ({
    amount: BigInt(b.amount),
    cells: b.cells.map((c) => ({
      timeSlotStart: BigInt(c.timeSlotStart),
      dataRangeStart: BigInt(c.dataRangeStart),
    })),
  }));

  console.log(`\n[CREATE SESSION] from ${playerAddress}`);
  console.log(`   amount: ${amount}, roundId: ${roundId}`);

  if (!clearNodeWs) {
    const response: SessionResponse = {
      type: "session_error",
      error: "Broker not connected to ClearNode",
    };
    clientWs.send(JSON.stringify(response));
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
      { participant: ADDRESS, asset: "ytest.usd", amount: "0" },
    ];

    const session: PlayerSession = {
      playerAddress,
      appSessionId,
      allocations,
      bets,
      roundId,
      version: 1,
    };
    playerSessions.set(playerAddress, session);

    console.log(`   App session created: ${appSessionId}`);

    const response: SessionResponse = {
      type: "session_created",
      appSessionId,
    };
    clientWs.send(JSON.stringify(response));

    // DEMO: Auto-close session to transfer funds to broker (one session per bet)
    console.log(`\n   [DEMO] Auto-closing session to transfer funds to broker...`);
    await handleCloseSession({
      type: "close_session",
      playerAddress: playerAddress,
      playerPayout: "0",
      brokerPayout: amount,
    });
  } catch (err) {
    console.error(`   Error creating session:`, err);
    const response: SessionResponse = {
      type: "session_error",
      error: err instanceof Error ? err.message : String(err),
    };
    clientWs.send(JSON.stringify(response));
  }
}

interface CloseSessionRequest {
  type: "close_session";
  playerAddress: string;
  playerPayout: string;
  brokerPayout: string;
}

async function handleCloseSession(
  request: CloseSessionRequest
): Promise<void> {
  const playerAddress = request.playerAddress as `0x${string}`;
  const session = playerSessions.get(playerAddress);

  if (!session || !clearNodeWs) {
    console.log(`[CLOSE SESSION] No session found for ${playerAddress}`);
    return;
  }

  console.log(`\n[CLOSE SESSION] ${session.appSessionId}`);
  console.log(`   Player payout: ${request.playerPayout}, Broker payout: ${request.brokerPayout}`);

  try {
    // Final allocations determine where funds go
    const finalAllocations = [
      { participant: playerAddress, asset: "ytest.usd", amount: request.playerPayout },
      { participant: ADDRESS, asset: "ytest.usd", amount: request.brokerPayout },
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

async function handleUpdateState(
  request: UpdateStateRequest,
  clientWs: WebSocket
): Promise<void> {
  const playerAddress = request.playerAddress as `0x${string}`;
  const session = playerSessions.get(playerAddress);

  if (!session) {
    clientWs.send(JSON.stringify({
      type: "session_error",
      error: "No active session for this player",
    }));
    return;
  }

  if (!clearNodeWs) {
    clientWs.send(JSON.stringify({
      type: "session_error",
      error: "Broker not connected to ClearNode",
    }));
    return;
  }

  const newBets: Bet[] = request.bets.map((b) => ({
    amount: BigInt(b.amount),
    cells: b.cells.map((c) => ({
      timeSlotStart: BigInt(c.timeSlotStart),
      dataRangeStart: BigInt(c.dataRangeStart),
    })),
  }));

  console.log(`\n[UPDATE STATE] for ${playerAddress}`);
  console.log(`   Adding ${newBets.length} bets`);

  try {
    // Append new bets
    session.bets = [...session.bets, ...newBets];
    session.version++;

    const encodedBetData = encodeBetData(session.roundId, session.bets);

    // With weights [0, 100], only broker needs to sign
    const timestamp = Date.now();
    const requestId = Math.floor(Math.random() * 1000000);
    const payload = [
      requestId,
      "submit_app_state",
      {
        app_session_id: session.appSessionId,
        allocations: session.allocations,
        session_data: encodedBetData,
      },
      timestamp,
    ];

    const brokerSignature = await signPayload(payload);

    const stateRequest = {
      req: payload,
      sig: [brokerSignature],
    };

    const stateResponsePromise = waitForMessage(
      clearNodeWs,
      (msg) =>
        !!((msg.res as unknown[])?.length &&
          ((msg.res as string[])[1] === "submit_app_state" ||
            (msg.res as string[])[1] === "app_state_submitted"))
    );

    clearNodeWs.send(JSON.stringify(stateRequest));
    await stateResponsePromise;

    console.log(`   State updated, version: ${session.version}`);

    clientWs.send(JSON.stringify({
      type: "state_updated",
      appSessionId: session.appSessionId,
    }));

  } catch (err) {
    console.error(`   Error updating state:`, err);
    clientWs.send(JSON.stringify({
      type: "session_error",
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

// --- Main ---

async function main() {
  console.log("1. Connecting to ClearNode...");
  const ws = new WebSocket(CLEARNODE_URL);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(err);
  });
  console.log("   Connected.\n");

  // 2. Authenticate
  console.log("2. Authenticating...");

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const authRequestMsg = await createAuthRequestMessage({
    address: ADDRESS,
    session_key: SESSION_KEY_ADDRESS,
    application: "onigo-demo",
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
    { name: "onigo-demo" }
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

  // 3. Check balance and withdraw via channel lifecycle if funds available
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

  console.log(balAmount);

  // Convert decimal string to smallest unit BigInt - only multiply by 1e6 if it has decimals
  const balAmountUnits = balAmount
    ? balAmount.includes(".")
      ? BigInt(Math.round(parseFloat(balAmount) * 1e6))
      : BigInt(balAmount)
    : 0n;

  if (balAmount && balAmountUnits > 0n) {
    console.log(`   Balance: ${balAmountUnits} ytest.usd`);
    console.log(`   Initiating withdrawal to Base Sepolia via channel lifecycle...`);
    try {
      // 3a. Get or create channel on Base Sepolia
      console.log("   3a. Getting or creating channel on Base Sepolia...");

      let channelId: `0x${string}`;

      // Create fresh channel
      {
        const createChMsg = await createCreateChannelMessage(messageSigner, {
          chain_id: baseSepolia.id,
          token: TOKEN_ADDRESS,
        });
        const createChPromise = waitForMessage(ws, (m) => {
          const r = m.res as unknown[];
          return r?.[1] === "create_channel";
        }, 30000);
        ws.send(createChMsg);
        const createChResp = await createChPromise;
        const createChParsed = parseCreateChannelResponse(JSON.stringify(createChResp));

        const { channel, state: rpcInitialState, serverSignature } = createChParsed.params;
        channelId = createChParsed.params.channelId as `0x${string}`;
        console.log(`       Channel created: ${channelId}`);

        // Map RPC response (stateData) to SDK's UnsignedState (data)
        const unsignedInitialState = {
          intent: rpcInitialState.intent,
          version: BigInt(rpcInitialState.version),
          data: rpcInitialState.stateData,
          allocations: rpcInitialState.allocations.map((a) => ({
            destination: a.destination,
            token: a.token,
            amount: BigInt(a.amount),
          })),
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const createResult = await nitroliteClient.createChannel({
          channel: channel as any,
          unsignedInitialState: unsignedInitialState as any,
          serverSignature: serverSignature as `0x${string}`,
        });
        console.log(`       On-chain tx: ${createResult.txHash}`);
        await delay(5000);
      }

      // 3b. Resize channel — use allocate_amount (from Unified Balance, NOT resize_amount)
      console.log("   3b. Resizing channel (allocate_amount from Unified Balance)...");
      const resizeMsg = await createResizeChannelMessage(messageSigner, {
        channel_id: channelId,
        allocate_amount: balAmountUnits,
        funds_destination: ADDRESS,
      });
      const resizePromise = waitForMessage(ws, (m) => {
        const r = m.res as unknown[];
        return r?.[1] === "resize_channel";
      }, 30000);
      ws.send(resizeMsg);
      const resizeResp = await resizePromise;
      const resizeParsed = parseResizeChannelResponse(JSON.stringify(resizeResp));
      const { state, serverSignature } = resizeParsed.params;
      const resizeState = {
        channelId: resizeParsed.params.channelId as `0x${string}`,
        serverSignature: serverSignature,
        intent: state.intent,
        version: BigInt(state.version),
        data: state.stateData,
        allocations: state.allocations.map((a) => ({
          destination: a.destination,
          token: a.token,
          amount: BigInt(a.amount),
        })),
      };

      // Fetch proof states from on-chain channel data
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let proofStates: any[] = [];
      try {
        const onChainData = await nitroliteClient.getChannelData(channelId);
        console.log(`       On-chain channel data:`, JSON.stringify(onChainData, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value, 2));
        if (onChainData.lastValidState) {
          proofStates = [onChainData.lastValidState];
        }
      } catch (e) {
        console.log(`       Failed to fetch on-chain data:`, e);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resizeResult = await nitroliteClient.resizeChannel({ resizeState: resizeState as any, proofStates });
      console.log(`       Resize tx: ${resizeResult.txHash}`);
      await delay(5000);

      // 3c. Close channel (settle on-chain)
      console.log("   3c. Closing channel...");
      const closeMsg = await createCloseChannelMessage(messageSigner, channelId, ADDRESS);
      const closePromise = waitForMessage(ws, (m) => {
        const r = m.res as unknown[];
        return r?.[1] === "close_channel";
      }, 30000);
      ws.send(closeMsg);
      const closeResp = await closePromise;
      const closeParsed = parseCloseChannelResponse(JSON.stringify(closeResp));
      const { state: rpcCloseState, serverSignature: closeServerSignature } = closeParsed.params;
      const finalState = {
        channelId: closeParsed.params.channelId as `0x${string}`,
        serverSignature: closeServerSignature as `0x${string}`,
        intent: rpcCloseState.intent,
        version: BigInt(rpcCloseState.version),
        data: rpcCloseState.stateData,
        allocations: rpcCloseState.allocations.map((a) => ({
          destination: a.destination,
          token: a.token,
          amount: BigInt(a.amount),
        })),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const closeTxHash = await nitroliteClient.closeChannel({ finalState: finalState as any, stateData: rpcCloseState.stateData });
      console.log(`       Close tx: ${closeTxHash}`);
      await delay(5000);

      // 3d. Withdraw from Custody contract
      console.log("   3d. Withdrawing from Custody contract...");
      const withdrawTxHash = await nitroliteClient.withdrawal(TOKEN_ADDRESS, balAmountUnits);
      console.log(`       Withdrawal tx: ${withdrawTxHash}`);
      console.log(`       View on BaseScan: https://sepolia.basescan.org/tx/${withdrawTxHash}\n`);
    } catch (err) {
      console.error(`   Withdrawal failed:`, err);
    }
  } else {
    console.log(`   No ytest.usd balance to withdraw.\n`);
  }

  // Store reference for broker API handlers
  clearNodeWs = ws;

  // 4. Start broker API server
  const wss = new WebSocketServer({ port: BROKER_API_PORT });
  console.log(`4. Broker API listening on port ${BROKER_API_PORT}\n`);

  wss.on("connection", (clientWs) => {
    console.log("[API] Client connected");

    clientWs.on("message", async (data) => {
      const raw = typeof data === "string" ? data : data.toString();
      try {
        const msg = JSON.parse(raw);
        console.log(`[API] Received message type: "${msg.type}"`);

        if (msg.type === "create_session") {
          await handleCreateSession(msg as CreateSessionRequest, clientWs);
        } else if (msg.type === "update_state") {
          await handleUpdateState(msg as UpdateStateRequest, clientWs);
        } else if (msg.type === "close_session") {
          await handleCloseSession(msg as CloseSessionRequest);
          clientWs.send(JSON.stringify({ type: "session_closed" }));
        } else if (msg.type === "get_sessions") {
          const sessions = Array.from(playerSessions.entries()).map(([addr, s]) => ({
            playerAddress: addr,
            appSessionId: s.appSessionId,
            roundId: s.roundId.toString(),
            betsCount: s.bets.length,
          }));
          clientWs.send(JSON.stringify({ type: "sessions", sessions }));
        } else if (msg.type === "get_broker_address") {
          clientWs.send(JSON.stringify({ type: "broker_address", address: ADDRESS }));
        } else {
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

  // 5. Listen for ClearNode events
  console.log("5. Listening for ClearNode events...\n");

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
        case "app_session_created": {
          console.log(`[SESSION CREATED] app_session_id: ${typed.app_session_id}`);
          console.log(`   status: ${typed.status}, version: ${typed.version}`);
          // Track the session for co-signing
          activeAppSessions.set(typed.app_session_id as string, {
            participants: (typed.participants as string[]) || [],
            version: (typed.version as number) || 0,
          });
          console.log();
          break;
        }

        case "submit_app_state":
        case "app_state_submitted": {
          console.log(`[STATE UPDATE] app_session_id: ${typed.app_session_id}`);
          console.log(`   version: ${typed.version}, status: ${typed.status}`);

          const sessionData = typed.session_data as string | undefined;
          if (sessionData) {
            console.log(`   session_data (raw): ${sessionData.slice(0, 80)}...`);
            try {
              const decoded = decodeBetData(sessionData as Hex);
              console.log(`   Decoded BetData:`);
              console.log(JSON.stringify(formatBetData(decoded), null, 4));
            } catch (err) {
              console.log(`   Failed to decode BetData:`, err);
            }
          } else {
            console.log(`   No session_data in this state update`);
          }
          // Update tracked version
          const appSessionId = typed.app_session_id as string;
          const session = activeAppSessions.get(appSessionId);
          if (session) {
            session.version = (typed.version as number) || session.version;
          }
          console.log();
          break;
        }

        case "close_app_session":
        case "app_session_closed": {
          console.log(`[SESSION CLOSED] app_session_id: ${typed.app_session_id}`);
          console.log(`   status: ${typed.status}, version: ${typed.version}`);
          // Remove from tracked sessions
          activeAppSessions.delete(typed.app_session_id as string);
          console.log();
          break;
        }

        case "message": {
          // Handle application messages - including co-sign requests
          const messagePayload = typed as Record<string, unknown>;

          if (messagePayload.type === "cosign_request") {
            console.log(`[CO-SIGN REQUEST] method: ${messagePayload.method}`);

            const requestPayload = messagePayload.payload as unknown[];
            const playerSignature = messagePayload.player_signature as string;
            const requestMethod = messagePayload.method as string;

            // Extract app_session_id from the payload params
            const params = requestPayload[2] as Record<string, unknown>;
            const appSessionId = params.app_session_id as string;

            console.log(`   app_session_id: ${appSessionId}`);
            console.log(`   player_signature: ${playerSignature?.slice(0, 20)}...`);

            // Validate the request
            let isValid = true;
            let validationError = "";

            // Check if we know about this session
            if (!activeAppSessions.has(appSessionId)) {
              // Session might have been created before we started listening
              // For now, accept it anyway
              console.log(`   Warning: Unknown app session, accepting anyway`);
            }

            // Validate BetData if this is a submit_app_state request
            if (requestMethod === "submit_app_state") {
              const sessionData = params.session_data as string | undefined;
              if (sessionData) {
                try {
                  const decoded = decodeBetData(sessionData as Hex);
                  console.log(`   Decoded BetData:`);
                  console.log(JSON.stringify(formatBetData(decoded), null, 4));
                } catch (err) {
                  isValid = false;
                  validationError = `Invalid BetData: ${err}`;
                }
              }
            }

            if (isValid) {
              // Sign the payload
              const brokerSignature = await signPayload(requestPayload);
              console.log(`   Broker signature: ${brokerSignature.slice(0, 20)}...`);

              // Send co-sign response back via application message
              const coSignResponse = {
                type: "cosign_response",
                method: requestMethod,
                broker_signature: brokerSignature,
                app_session_id: appSessionId,
              };

              const responseMsg = await createApplicationMessage(
                messageSigner,
                appSessionId as `0x${string}`,
                coSignResponse
              );

              ws.send(responseMsg);
              console.log(`   Co-sign response sent!`);
            } else {
              console.log(`   REJECTED: ${validationError}`);
              // Send rejection response
              const rejectResponse = {
                type: "cosign_rejected",
                method: requestMethod,
                error: validationError,
                app_session_id: appSessionId,
              };

              const responseMsg = await createApplicationMessage(
                messageSigner,
                appSessionId as `0x${string}`,
                rejectResponse
              );

              ws.send(responseMsg);
            }
            console.log();
          } else {
            console.log(`[MESSAGE]`, JSON.stringify(messagePayload, null, 2));
            console.log();
          }
          break;
        }

        case "asu": {
          // App State Update — ClearNode relays session state to counterparty
          const appSession = typed.app_session as Record<string, unknown> | undefined;
          const participantAllocations = typed.participant_allocations as Record<string, unknown>[] | undefined;

          if (appSession) {
            const asuAppSessionId = appSession.app_session_id as string;
            console.log(`[APP STATE UPDATE] app_session_id: ${asuAppSessionId}`);
            console.log(`   status: ${appSession.status}, version: ${appSession.version}`);
            console.log(`   participants: ${JSON.stringify(appSession.participants)}`);

            // Track/update the session
            if (!activeAppSessions.has(asuAppSessionId)) {
              activeAppSessions.set(asuAppSessionId, {
                participants: (appSession.participants as string[]) || [],
                version: (appSession.version as number) || 0,
              });
            } else {
              const session = activeAppSessions.get(asuAppSessionId);
              if (session) {
                session.version = (appSession.version as number) || session.version;
              }
            }

            if (participantAllocations?.length) {
              console.log(`   allocations: ${JSON.stringify(participantAllocations)}`);
            }

            const sd = appSession.session_data as string | undefined;
            if (sd) {
              console.log(`   session_data (raw): ${sd.slice(0, 80)}...`);
              try {
                const decoded = decodeBetData(sd as Hex);
                console.log(`   Decoded BetData:`);
                console.log(JSON.stringify(formatBetData(decoded), null, 4));
              } catch (err) {
                console.log(`   Failed to decode BetData:`, err);
              }
            }

          } else {
            console.log(`[APP STATE UPDATE]`, JSON.stringify(typed, null, 2));
          }
          console.log();
          break;
        }

        default:
          // Log other methods for debugging
          if (!["assets", "bu", "channels", "auth_challenge", "auth_verify", "get_ledger_balances"].includes(method)) {
            console.log(`[${method}]`, JSON.stringify(typed, null, 2));
          }
          break;
      }
    } catch {
      // ignore non-JSON
    }
  });

  // Keep the process running
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
