/**
 * Check Yellow ledger balance for a given private key
 *
 * Usage:
 *   PRIVATE_KEY=0x... yarn check-balance
 *   PRIVATE_KEY=0x... yarn check-balance --withdraw  # Withdraw 10 units
 */

import "dotenv/config";
import { ethers } from "ethers";
import { createPublicClient, createWalletClient, http, formatUnits, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type Address } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { Client } from "yellow-ts";
import {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetLedgerBalancesMessage,
  createCreateChannelMessage,
  createResizeChannelMessage,
  createCloseChannelMessage,
  createECDSAMessageSigner,
  parseCloseChannelResponse,
  NitroliteClient,
  WalletStateSigner,
  RPCMethod,
  type RPCResponse,
  type AuthChallengeResponse,
} from "@erc7824/nitrolite";

// --- Config ---

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CLEARNODE_URL =
  process.env.CLEARNODE_URL ?? "wss://clearnet-sandbox.yellow.com/ws";
const WITHDRAW_FLAG = process.argv.includes("--withdraw");
const WITHDRAW_AMOUNT = 10n; // Withdraw 10 units (in token's smallest unit)

// Contract addresses (Base Sepolia)
const CUSTODY_ADDRESS = "0x019B65A265EB3363822f2752141b3dF16131b262" as const;
const ADJUDICATOR_ADDRESS = "0x7c7ccbc98469190849BCC6c926307794fDfB11F2" as const;
const TOKEN_ADDRESS = "0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb" as const; // yUSD
const TOKEN_DECIMALS = 6;

if (!PRIVATE_KEY) {
  console.error("Required: PRIVATE_KEY");
  process.exit(1);
}

// --- Yellow Network Client ---

const yellow = new Client({
  url: CLEARNODE_URL,
});

// --- Wallet Setup ---

const ethersWallet = new ethers.Wallet(PRIVATE_KEY);
const ADDRESS = ethersWallet.address as `0x${string}`;

// Viem wallet client for EIP-712 auth signing
const viemAccount = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({
  account: viemAccount,
  chain: baseSepolia,
  transport: http(),
});

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

// Random session key (ephemeral)
const sessionKeyPrivate = generatePrivateKey();
const sessionKeyAccount = privateKeyToAccount(sessionKeyPrivate);
const SESSION_KEY_ADDRESS = sessionKeyAccount.address;

// Session key message signer
let messageSigner = createECDSAMessageSigner(sessionKeyPrivate);

// NitroliteClient for on-chain channel operations
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nitroliteClient = new NitroliteClient({
  publicClient: publicClient as any,
  walletClient: walletClient as any,
  stateSigner: new WalletStateSigner(walletClient as any),
  addresses: { custody: CUSTODY_ADDRESS, adjudicator: ADJUDICATOR_ADDRESS },
  chainId: baseSepolia.id,
  challengeDuration: 3600n,
});

// --- Types ---

interface SessionKey {
  privateKey: `0x${string}`;
  address: Address;
}

// --- Helpers ---

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    address: ADDRESS,
    session_key: SESSION_KEY_ADDRESS,
    application: "onigo",
    expires_at: expiresAt,
    scope: "console",
    allowances,
  });

  async function handleAuthChallenge(message: AuthChallengeResponse) {
    const authParams = {
      address: ADDRESS,
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

// --- Withdraw ---

async function closeExistingChannel(channelId: `0x${string}`): Promise<void> {
  console.log(`   Closing existing channel ${channelId}...`);

  // Request close from ClearNode
  const closeMsg = await createCloseChannelMessage(
    messageSigner,
    channelId,
    ADDRESS // funds_destination
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
    finalState: finalState as any, stateData: state.stateData
  });
  console.log(`   Close channel tx: ${closeTxHash}`);
  await delay(5000);
}

async function withdrawFunds(amount: bigint): Promise<void> {
  console.log(`\n4. Withdrawing ${amount} units...`);

  // Step 0: Check custody balance - if funds already there, skip to withdrawal
  console.log("   Checking custody balance...");
  const custodyBalance = await nitroliteClient.getAccountBalance(TOKEN_ADDRESS);
  console.log(`   Custody balance: ${custodyBalance}`);

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
    token: TOKEN_ADDRESS,
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

  // Step 3: Resize channel with NEGATIVE amount to move funds FROM unified balance TO custody
  console.log(`   Resizing channel (allocate_amount: -${amount})...`);

  const resizeMsg = await createResizeChannelMessage(messageSigner, {
    channel_id: channelId,
    allocate_amount: amount,
    funds_destination: ADDRESS,
  });

  const resizeResponse = await yellow.sendMessage(JSON.parse(resizeMsg));
  console.log("   Resize response received");
  console.log(resizeResponse);

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

  const closeMsg = await createCloseChannelMessage(messageSigner, channelId, ADDRESS);
  const closeResponse = await yellow.sendMessage(JSON.parse(closeMsg));
  console.log("   Close channel response received from ClearNode");
  console.log(closeResponse);
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
    finalState: finalState as any, stateData: closeState.stateData
  });
  console.log(`       Close tx: ${closeTxHash}`);

  // Step 4: Withdraw from Custody contract on-chain
  console.log("   Withdrawing from Custody contract...");

  const withdrawTxHash = await nitroliteClient.withdrawal(TOKEN_ADDRESS, amount);
  console.log(`   Withdraw tx: ${withdrawTxHash}`);

  console.log(`\n✅ Successfully withdrew ${formatUnits(amount, TOKEN_DECIMALS)} yUSD`);
}

// --- Main ---

async function main() {
  console.log(`Address:   ${ADDRESS}`);
  console.log(`Session Key: ${SESSION_KEY_ADDRESS}`);
  console.log(`ClearNode: ${CLEARNODE_URL}`);
  console.log(`Withdraw:  ${WITHDRAW_FLAG ? `Yes (${WITHDRAW_AMOUNT} units)` : "No"}\n`);

  // 1. Connect to ClearNode
  console.log("1. Connecting to ClearNode...");
  await yellow.connect();
  console.log("   Connected.\n");

  // 2. Authenticate
  console.log("2. Authenticating...");
  const sessionKey = await authenticateWallet(yellow, walletClient as WalletClient);
  messageSigner = createECDSAMessageSigner(sessionKey.privateKey);
  console.log("   Authenticated.\n");

  // 3. Query balance
  console.log("3. Querying ledger balance...");
  const balMsg = await createGetLedgerBalancesMessage(messageSigner, ADDRESS, Date.now());
  const balanceResponse = await yellow.sendMessage(JSON.parse(balMsg));

  console.log("   Balance response:", JSON.stringify(balanceResponse, null, 2));

  // Extract balances from response (can be ledgerBalances or balances)
  const params = balanceResponse.params as Record<string, unknown> | undefined;
  const balances = (params?.ledgerBalances ?? params?.balances) as Record<string, unknown>[] | undefined;

  if (!balances || balances.length === 0) {
    console.log("\nNo balances found.");
  } else {
    console.log("\nBalances:");
    for (const b of balances) {
      console.log(`  ${b.asset}: ${b.amount}`);
    }
  }

  // 4. Withdraw if flag is set
  if (WITHDRAW_FLAG) {
    await withdrawFunds(WITHDRAW_AMOUNT);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
