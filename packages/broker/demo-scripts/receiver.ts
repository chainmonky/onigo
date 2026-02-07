/**
 * Yellow SDK Receiver: Listen for incoming app sessions and decode BetData
 *
 * Usage:
 *   RECEIVER_PRIVATE_KEY=0x... yarn receiver
 */

import "dotenv/config";
import WebSocket, { WebSocketServer } from "ws";
import { ethers } from "ethers";
import { createPublicClient, createWalletClient, http, WalletClient } from "viem";
import { Address, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { Client } from "yellow-ts";
import {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetLedgerBalancesMessage,
  createCloseAppSessionMessage,
  RPCMethod,
  NitroliteClient,
  WalletStateSigner,
  createECDSAMessageSigner,
  RPCData,
  AuthChallengeResponse,
  RPCResponse,
  
} from "@erc7824/nitrolite";
import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";

const yellow = new Client({
        url: 'wss://clearnet-sandbox.yellow.com/ws',
    });

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

const messageSigner = createECDSAMessageSigner(sessionKeyPrivate);

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

async function authenticateWallet(client: Client, walletAccount: WalletClient): Promise<SessionKey> {

    console.log(`Wallet address: ${walletAccount.account?.address}`);


    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 60000000);

    const customWalletClient = createWalletClient({
        account: walletAccount.account,
        chain: baseSepolia,
        transport: http(),
    });

    const allowances = [
        { asset: "ytest.usd", amount: "1000000000" },
    ];

    // Create authentication message with session configuration
    const authMessage = await createAuthRequestMessage({
        address: ADDRESS,
        session_key: SESSION_KEY_ADDRESS,
        application: "onigo-demo",
        expires_at: expiresAt,
        scope: "console",
        allowances,
    });

    async function handleAuthChallenge(message: AuthChallengeResponse) {

        const authParams = {
            address: ADDRESS,
            session_key: SESSION_KEY_ADDRESS,
            application: "onigo-demo",
            expires_at: expiresAt,
            scope: "console",
            allowances,
        };

        const eip712Signer = createEIP712AuthMessageSigner(customWalletClient, authParams, { name: "onigo-demo" });

        const authVerifyMessage = await createAuthVerifyMessage(eip712Signer, message);

        await client.sendMessage(authVerifyMessage);

    }

    client.listen(async (message: RPCResponse) => {

        if (message.method === RPCMethod.AuthChallenge) {
            await handleAuthChallenge(message);
        }
    })

    await client.sendMessage(authMessage)

    const sessionKey: SessionKey = {
        privateKey: sessionKeyPrivate,
        address: SESSION_KEY_ADDRESS,
    };

    return sessionKey;

}

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
  payload: unknown;
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

interface SessionKey {
    privateKey: `0x${string}`;
    address: Address;
}

// Player sessions state
const playerSessions = new Map<string, PlayerSession>();
let clearNodeWs: WebSocket | null = null;

// --- Broker API Handlers ---

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
  const createSessionMsgJson = request.payload as { req: RPCData; sig: string[] };

  console.log(`\n[CREATE SESSION] from ${playerAddress}`);
  console.log(`   amount: ${amount}, roundId: ${roundId}`);

  try {

    const signedCreateSessionMessageSignature2 = await messageSigner(
        createSessionMsgJson.req as RPCData
    );

    createSessionMsgJson.sig.push(signedCreateSessionMessageSignature2);

    console.log(createSessionMsgJson);

    console.log(`   Creating app session via SDK...`);

    const sessionResponse = await yellow.sendMessage(createSessionMsgJson);
    console.log('✅ Session message sent');
    console.log(`   Session response: ${JSON.stringify(sessionResponse)}`);

    // Extract appSessionId from the response params
    const params = sessionResponse.params as Record<string, unknown>;
    const appSessionId = params?.appSessionId as string;

    if (!appSessionId) {
      throw new Error(`Failed to create app session: ${JSON.stringify(appSessionId)}`);
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

  if (!session) {
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

    const closeMsg = await createCloseAppSessionMessage(
      messageSigner,
      { app_session_id: session.appSessionId as `0x${string}`, allocations: finalAllocations }
    );

    const closeSessionMessageJson = JSON.parse(closeMsg);

    const closeSessionResponse = await yellow.sendMessage(
        JSON.stringify(closeSessionMessageJson)
    );
    console.log('✅ Close session message sent');

    console.log('🎉 Close session response:', closeSessionResponse);

    playerSessions.delete(playerAddress);
    console.log(`   Session closed. Funds transferred.`);
  } catch (err) {
    console.error(`   Error closing session:`, err);
  }
}

// --- Main ---

async function main() {
  console.log("1. Connecting to ClearNode...");
  await yellow.connect();
  console.log('🔌 Connected to Yellow clearnet');

  // 2. Authenticate
  console.log("2. Authenticating...");

  const sessionKey = await authenticateWallet(yellow, walletClient as WalletClient);
  const messageSigner = createECDSAMessageSigner(sessionKey.privateKey);
  
  console.log("   Authenticated.\n");

  console.log("3. Querying ledger balance...");
  const balMsg = await createGetLedgerBalancesMessage(messageSigner, ADDRESS, Date.now());
  const balanceResponse = await yellow.sendMessage(JSON.parse(balMsg));

  // Store reference for broker API handlers

  // 3. Start broker API server
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

  // Listen for any additional messages from the server
  yellow.listen(async (message: RPCResponse) => {
      console.log('📨 Received message:', message);
  });

  // Keep the process running
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    wss.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
