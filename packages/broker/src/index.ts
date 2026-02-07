/**
 * Broker Service
 *
 * Main entry point for the broker service.
 * - Connects to Yellow Network ClearNode via yellow-ts Client
 * - Accepts bets from players via WebSocket API
 * - Records bets in memory
 * - Handles settlement when requested
 */

import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { ethers } from "ethers";
import { createPublicClient, createWalletClient, http, decodeAbiParameters, encodeAbiParameters, type Hex, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type Address } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { Client } from "yellow-ts";
import {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createCloseAppSessionMessage,
  createCreateChannelMessage,
  createResizeChannelMessage,
  createCloseChannelMessage,
  createECDSAMessageSigner,
  NitroliteClient,
  WalletStateSigner,
  RPCMethod,
  type RPCResponse,
  type AuthChallengeResponse,
  type RPCData,
} from "@erc7824/nitrolite";

import { config, validateConfig } from "./config.js";
import { BetManager } from "./betManager.js";
import { Settler } from "./settler.js";
import { KeeperClient } from "./keeper.js";
import { computePayouts } from "./payout.js";
import type { Bet, BetData, GridCell } from "./types.js";
import { BET_DATA_ABI } from "./types.js";

// Validate config at startup
validateConfig();

// --- Yellow Network Client ---

const yellow = new Client({
  url: config.CLEARNODE_URL,
});

// --- Wallet Setup ---

const ethersWallet = new ethers.Wallet(config.BROKER_PRIVATE_KEY);
const BROKER_ADDRESS = ethersWallet.address as `0x${string}`;

// Viem wallet client for EIP-712 auth signing
const viemAccount = privateKeyToAccount(
  config.BROKER_PRIVATE_KEY as `0x${string}`
);
const walletClient = createWalletClient({
  account: viemAccount,
  chain: baseSepolia,
  transport: http(),
});

// Viem public client for on-chain reads
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

// NitroliteClient for on-chain channel operations (withdraw from Yellow)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nitroliteClient = new NitroliteClient({
  publicClient: publicClient as any,
  walletClient: walletClient as any,
  stateSigner: new WalletStateSigner(walletClient as any),
  addresses: { custody: config.CUSTODY_ADDRESS, adjudicator: config.ADJUDICATOR_ADDRESS },
  chainId: baseSepolia.id,
  challengeDuration: 3600n,
});

// Random session key (ephemeral)
const sessionKeyPrivate = generatePrivateKey();
const sessionKeyAccount = privateKeyToAccount(sessionKeyPrivate);
const SESSION_KEY_ADDRESS = sessionKeyAccount.address;

// Session key message signer for RPC calls
let messageSigner = createECDSAMessageSigner(sessionKeyPrivate);

console.log(`Broker address: ${BROKER_ADDRESS}`);
console.log(`Session key:    ${SESSION_KEY_ADDRESS}`);
console.log(`ClearNode:      ${config.CLEARNODE_URL}`);
console.log(`API port:       ${config.BROKER_API_PORT}\n`);

// --- Services ---

const betManager = new BetManager();
const settler = new Settler();
const keeperClient = new KeeperClient();

// --- Types ---

type SessionKey = {
  privateKey: `0x${string}`;
  address: Address;
};

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
  payload: { req: RPCData; sig: string[] };
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

// --- Helpers ---

function decodeBetData(hex: Hex) {
  const [result] = decodeAbiParameters(BET_DATA_ABI, hex);
  return result;
}

function encodeBetData(roundId: bigint, bets: Bet[]): Hex {
  return encodeAbiParameters(BET_DATA_ABI, [{ roundId, bets }]);
}

// --- Authentication ---

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
    address: BROKER_ADDRESS,
    session_key: SESSION_KEY_ADDRESS,
    application: "onigo",
    expires_at: expiresAt,
    scope: "console",
    allowances,
  });

  async function handleAuthChallenge(message: AuthChallengeResponse) {
    const authParams = {
      address: BROKER_ADDRESS,
      session_key: SESSION_KEY_ADDRESS,
      application: "onigo",
      expires_at: expiresAt,
      scope: "console",
      allowances,
    };

    const eip712Signer = createEIP712AuthMessageSigner(customWalletClient, authParams, { name: "onigo" });

    const authVerifyMessage = await createAuthVerifyMessage(eip712Signer, message);

    await client.sendMessage(authVerifyMessage);
  }

  client.listen(async (message: RPCResponse) => {
    if (message.method === RPCMethod.AuthChallenge) {
      await handleAuthChallenge(message as AuthChallengeResponse);
    }
  });

  await client.sendMessage(authMessage);

  const sessionKey: SessionKey = {
    privateKey: sessionKeyPrivate,
    address: SESSION_KEY_ADDRESS,
  };

  return sessionKey;
}

// --- Helpers ---

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Withdraw from Yellow Network ---

async function closeExistingChannel(channelId: `0x${string}`): Promise<void> {
  console.log(`   Closing existing channel ${channelId}...`);

  // Request close from ClearNode
  const closeMsg = await createCloseChannelMessage(
    messageSigner,
    channelId,
    BROKER_ADDRESS // funds_destination
  );
  const closeResponse = await yellow.sendMessage(JSON.parse(closeMsg));
  console.log("   Close channel response received from ClearNode");

  const { state, serverSignature } = closeResponse.params;

  const finalState = {
    channelId,
    serverSignature: serverSignature as `0x${string}`,
    intent: state.intent,
    version: BigInt(state.version),
    data: state.stateData,
    allocations: state.allocations.map((a: any) => ({
      destination: a.destination,
      token: a.token,
      amount: BigInt(a.amount),
    })),
  };

  // Submit close on-chain
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const closeTxHash = await nitroliteClient.closeChannel({
    finalState: finalState as any,
    stateData: state.stateData,
  });
  console.log(`   Close channel tx: ${closeTxHash}`);
  await delay(5000);
}

/**
 * Withdraw funds from Yellow Network to Base Sepolia.
 * This moves funds from the broker's Yellow ledger balance to the on-chain custody contract,
 * then withdraws from custody to the broker's wallet.
 */
async function withdrawFromYellow(amount: bigint): Promise<void> {
  console.log(`\n[WITHDRAW] Withdrawing ${amount} from Yellow to Base Sepolia...`);

  // Step 0: Check custody balance - if funds already there, skip channel operations
  console.log("   Checking custody balance...");
  const custodyBalance = await nitroliteClient.getAccountBalance(config.TOKEN_ADDRESS);
  console.log(`   Custody balance: ${custodyBalance}`);

  if (custodyBalance >= amount) {
    console.log(`   Sufficient funds in custody. Skipping channel operations.`);
    console.log("   Withdrawing from Custody contract...");
    const withdrawTxHash = await nitroliteClient.withdrawal(config.TOKEN_ADDRESS, amount);
    console.log(`   Withdraw tx: ${withdrawTxHash}`);
    console.log(`   ✅ Withdrawal complete.`);
    return;
  }

  // Step 1: Close any existing open channels first
  console.log("   Checking for open channels on-chain...");
  const openChannels = await nitroliteClient.getOpenChannels();

  if (openChannels.length > 0) {
    console.log(`   Found ${openChannels.length} open channel(s). Closing them first...`);
    for (const existingChannelId of openChannels) {
      await closeExistingChannel(existingChannelId as `0x${string}`);
    }
    console.log("   All existing channels closed.");
  } else {
    console.log("   No open channels found.");
  }

  // Step 2: Create a fresh channel
  console.log("   Creating new channel...");

  const createChMsg = await createCreateChannelMessage(messageSigner, {
    chain_id: baseSepolia.id,
    token: config.TOKEN_ADDRESS,
  });

  const createChResponse = await yellow.sendMessage(JSON.parse(createChMsg));
  console.log("   Channel creation response received");

  const { channel, state: rpcInitialState, serverSignature } = createChResponse.params;
  const channelId = createChResponse.params.channelId as `0x${string}`;
  console.log(`   Channel created: ${channelId}`);

  // Map RPC response to SDK's UnsignedState
  const unsignedInitialState = {
    intent: rpcInitialState.intent,
    version: BigInt(rpcInitialState.version),
    data: rpcInitialState.stateData,
    allocations: rpcInitialState.allocations.map((a: any) => ({
      destination: a.destination,
      token: a.token,
      amount: BigInt(a.amount),
    })),
  };

  // Submit channel creation on-chain
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createResult = await nitroliteClient.createChannel({
    channel: channel as any,
    unsignedInitialState: unsignedInitialState as any,
    serverSignature: serverSignature as `0x${string}`,
  });
  console.log(`   On-chain create tx: ${createResult.txHash}`);
  await delay(5000);

  // Step 3: Resize channel with positive amount to move funds FROM unified balance TO custody
  console.log(`   Resizing channel (allocate_amount: ${amount})...`);

  const resizeMsg = await createResizeChannelMessage(messageSigner, {
    channel_id: channelId,
    allocate_amount: amount,
    funds_destination: BROKER_ADDRESS,
  });

  const resizeResponse = await yellow.sendMessage(JSON.parse(resizeMsg));
  console.log("   Resize response received");

  const { state, serverSignature: resizeServerSig } = resizeResponse.params;

  const resizeState = {
    channelId: resizeResponse.params.channelId as `0x${string}`,
    serverSignature: resizeServerSig,
    intent: state.intent,
    version: BigInt(state.version),
    data: state.stateData,
    allocations: state.allocations.map((a: any) => ({
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
    console.log("   On-chain channel data fetched");
    if (onChainData.lastValidState) {
      proofStates = [onChainData.lastValidState];
    }
  } catch (e) {
    console.log(`   Failed to fetch on-chain data: ${e}`);
  }

  // Submit resize on-chain
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resizeResult = await nitroliteClient.resizeChannel({
    resizeState: resizeState as any,
    proofStates,
  });
  console.log(`   Resize tx: ${resizeResult.txHash}`);
  await delay(5000);

  // Step 4: Close the channel to finalize
  const closeMsg = await createCloseChannelMessage(messageSigner, channelId, BROKER_ADDRESS);
  const closeResponse = await yellow.sendMessage(JSON.parse(closeMsg));
  console.log("   Close channel response received from ClearNode");

  const { state: closeState, serverSignature: closeServerSignature } = closeResponse.params;

  const finalState = {
    channelId,
    serverSignature: closeServerSignature as `0x${string}`,
    intent: closeState.intent,
    version: BigInt(closeState.version),
    data: closeState.stateData,
    allocations: closeState.allocations.map((a: any) => ({
      destination: a.destination,
      token: a.token,
      amount: BigInt(a.amount),
    })),
  };

  // Submit close on-chain
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const closeTxHash = await nitroliteClient.closeChannel({
    finalState: finalState as any,
    stateData: closeState.stateData,
  });
  console.log(`   Close tx: ${closeTxHash}`);
  await delay(5000);

  // Step 5: Withdraw from Custody contract on-chain
  console.log("   Withdrawing from Custody contract...");

  const withdrawTxHash = await nitroliteClient.withdrawal(config.TOKEN_ADDRESS, amount);
  console.log(`   Withdraw tx: ${withdrawTxHash}`);

  console.log(`   ✅ Successfully withdrew ${amount} from Yellow to Base Sepolia`);
}

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
  const createSessionMsgJson = request.payload;

  console.log(`\n[CREATE SESSION] from ${playerAddress}`);
  console.log(
    `   amount: ${amount}, marketId: ${marketId}, roundId: ${roundId}`
  );

  try {
    // Broker co-signs the payload
    const brokerSignature = await messageSigner(createSessionMsgJson.req);
    createSessionMsgJson.sig.push(brokerSignature);

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

    clientWs.send(
      JSON.stringify({
        type: "session_created",
        appSessionId,
      })
    );

    // Auto-close session to transfer funds to broker (one session per bet)
    console.log(
      `\n   [AUTO-CLOSE] Closing session to transfer funds to broker...`
    );
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
    clientWs.send(
      JSON.stringify({
        type: "session_error",
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

async function handleCloseSession(request: CloseSessionRequest): Promise<void> {
  const playerAddress = request.playerAddress as `0x${string}`;
  const session = playerSessions.get(playerAddress);

  if (!session) {
    console.log(`[CLOSE SESSION] No session found for ${playerAddress}`);
    return;
  }

  console.log(`\n[CLOSE SESSION] ${session.appSessionId}`);
  console.log(
    `   Player payout: ${request.playerPayout}, Broker payout: ${request.brokerPayout}`
  );

  try {
    // Final allocations determine where funds go
    const finalAllocations = [
      {
        participant: playerAddress,
        asset: "ytest.usd",
        amount: request.playerPayout,
      },
      {
        participant: BROKER_ADDRESS,
        asset: "ytest.usd",
        amount: request.brokerPayout,
      },
    ];

    const closeMsg = await createCloseAppSessionMessage(
      messageSigner,
      { app_session_id: session.appSessionId as `0x${string}`, allocations: finalAllocations }
    );

    const closeSessionMessageJson = JSON.parse(closeMsg);

    const closeSessionResponse = await yellow.sendMessage(closeSessionMessageJson);
    console.log('✅ Close session message sent');
    console.log('🎉 Close session response:', closeSessionResponse);

    playerSessions.delete(playerAddress);
    console.log(`   Session closed. Funds transferred.`);
  } catch (err) {
    console.error(`   Error closing session:`, err);
  }
}

async function handleSettleRound(
  request: SettleRoundRequest,
  clientWs: WebSocket
): Promise<void> {
  const { marketId, roundId } = request;
  console.log(`\n[SETTLE ROUND] market=${marketId} round=${roundId}`);

  try {
    const roundBets = betManager.getRoundBets(marketId, roundId);
    if (!roundBets || roundBets.bets.length === 0) {
      console.log(`   No bets found - nothing to settle`);
      clientWs.send(
        JSON.stringify({
          type: "round_settled",
          marketId,
          roundId,
          txHash:
            "0x0000000000000000000000000000000000000000000000000000000000000000",
          winners: 0,
          totalPayout: "0",
        })
      );
      return;
    }

    console.log(
      `   Found ${roundBets.bets.length} players with total pool: ${roundBets.totalPool}`
    );

    // Get hit cells from keeper
    const hitCells: GridCell[] = await keeperClient.getHitCells(marketId, roundId);
    console.log(`   Hit cells: ${hitCells.length}`);

    hitCells.forEach((cell, i) => {
      console.log(
        `     Hit ${i}: time=${cell.timeSlotStart}, price=${cell.dataRangeStart}`
      );
    });

    const market = await settler.getMarketConfig(marketId);
    console.log(`   Commission: ${market.commissionBps} bps`);

    const payoutResult = computePayouts(
      roundBets.bets,
      hitCells,
      market.commissionBps
    );
    console.log(`   Winners: ${payoutResult.players.length}`);
    console.log(`   Total payout: ${payoutResult.totalPayout}`);

    // ✅ ADDED: Skip settlement if no winners
    if (payoutResult.players.length === 0 || payoutResult.totalPayout === 0n) {
      console.log(
        `   No winners - everyone lost. Skipping on-chain settlement.`
      );

      betManager.clearRound(marketId, roundId);

      clientWs.send(
        JSON.stringify({
          type: "round_settled",
          marketId,
          roundId,
          txHash:
            "0x0000000000000000000000000000000000000000000000000000000000000000",
          winners: 0,
          totalPayout: "0",
        })
      );
      return;
    }
    payoutResult.players.forEach((player, i) => {
      console.log(
        `     Winner ${i}: ${player} gets ${payoutResult.payouts[i]}`
      );
    });

    // Withdraw funds from Yellow Network to Base Sepolia before settling
    console.log(`   Withdrawing ${payoutResult.totalPayout} from Yellow to Base Sepolia...`);
    await withdrawFromYellow(payoutResult.totalPayout);

    // Settle on-chain
    const txHash = await settler.settleRound(
      marketId,
      roundId,
      hitCells,
      payoutResult
    );

    betManager.clearRound(marketId, roundId);

    clientWs.send(
      JSON.stringify({
        type: "round_settled",
        marketId,
        roundId,
        txHash,
        winners: payoutResult.players.length,
        totalPayout: payoutResult.totalPayout.toString(),
      })
    );
  } catch (err) {
    console.error(`   Error settling round:`, err);
    clientWs.send(
      JSON.stringify({
        type: "settle_error",
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

// --- Main ---

async function main() {
  console.log("1. Connecting to ClearNode...");
  await yellow.connect();
  console.log('🔌 Connected to Yellow clearnet\n');

  // 2. Authenticate
  console.log("2. Authenticating...");
  const sessionKey = await authenticateWallet(yellow, walletClient as WalletClient);
  messageSigner = createECDSAMessageSigner(sessionKey.privateKey);
  console.log("   Authenticated.\n");

  // 3. Verify broker role on contract
  console.log("3. Verifying broker role...");
  const isAuthorized = await settler.verifyBrokerRole();
  if (isAuthorized) {
    console.log("   Broker role verified.\n");
  } else {
    console.log("   WARNING: Not authorized as broker on contract!\n");
  }

  // 4. Start broker API server
  const wss = new WebSocketServer({ port: config.BROKER_API_PORT });
  console.log(`4. Broker API listening on port ${config.BROKER_API_PORT}\n`);

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
            const sessions = Array.from(playerSessions.entries()).map(
              ([addr, s]) => ({
                playerAddress: addr,
                appSessionId: s.appSessionId,
                marketId: s.marketId,
                roundId: s.roundId.toString(),
                betsCount: s.bets.length,
              })
            );
            clientWs.send(JSON.stringify({ type: "sessions", sessions }));
            break;

          case "get_bets":
            const summary = betManager.getSummary();
            clientWs.send(JSON.stringify({ type: "bets", rounds: summary }));
            break;

          case "get_broker_address":
            clientWs.send(
              JSON.stringify({
                type: "broker_address",
                address: BROKER_ADDRESS,
              })
            );
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

  // 5. Listen for ClearNode events
  console.log("5. Listening for ClearNode events...\n");

  yellow.listen(async (message: RPCResponse) => {
    console.log('📨 Received message:', message);
  });

  // Keep process running
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
