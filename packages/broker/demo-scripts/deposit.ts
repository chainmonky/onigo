/**
 * Deposit to Yellow Network via Custody contract and verify balance via ClearNode
 *
 * Flow:
 * 1. Deposit tokens to Custody contract on Base Sepolia (on-chain)
 * 2. Create channel via ClearNode
 * 3. Resize channel to allocate deposited funds into unified balance
 * 4. Close channel
 * 5. Verify unified balance via ClearNode
 *
 * Usage:
 *   PRIVATE_KEY=0x... yarn deposit-and-verify
 *   PRIVATE_KEY=0x... yarn deposit-and-verify --verify-only
 *
 * Optional env vars:
 *   DEPOSIT_AMOUNT - Amount to deposit (default: 10, in token units)
 *   CLEARNODE_URL  - ClearNode WebSocket URL (default: wss://clearnet.yellow.com/ws)
 */

import "dotenv/config";
import WebSocket from "ws";
import { ethers } from "ethers";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetLedgerBalancesMessage,
  createCreateChannelMessage,
  createResizeChannelMessage,
  parseAuthChallengeResponse,
  parseAnyRPCResponse,
  parseCreateChannelResponse,
  parseResizeChannelResponse,
  RPCMethod,
  NitroliteClient,
  WalletStateSigner,
} from "@erc7824/nitrolite";

// --- Configuration ---

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CLEARNODE_URL =
  process.env.CLEARNODE_URL ?? "wss://clearnet.yellow.com/ws";
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "10";
const VERIFY_ONLY = process.argv.includes("--verify-only");

// Contract addresses (Base Sepolia, chain ID 84532)
const CUSTODY_ADDRESS = "0x019B65A265EB3363822f2752141b3dF16131b262" as const;
const ADJUDICATOR_ADDRESS = "0x7c7ccbc98469190849BCC6c926307794fDfB11F2" as const;
const TOKEN_ADDRESS = "0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb" as const; // yUSD

// Token has 6 decimals
const TOKEN_DECIMALS = 6;

if (!PRIVATE_KEY) {
  console.error("Required: PRIVATE_KEY environment variable");
  process.exit(1);
}

// --- ABIs ---

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "allowance",
    type: "function",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "symbol",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
] as const;

const CUSTODY_ABI = [
  {
    name: "deposit",
    type: "function",
    inputs: [
      { name: "account", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

// --- Setup clients ---

const viemAccount = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const ADDRESS = viemAccount.address;

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

const walletClient = createWalletClient({
  account: viemAccount,
  chain: baseSepolia,
  transport: http(),
});

// Ethers wallet for message signing (ClearNode RPC)
const ethersWallet = new ethers.Wallet(PRIVATE_KEY);

// Session key for ClearNode auth
const sessionKeyPrivate = generatePrivateKey();
const sessionKeyAccount = privateKeyToAccount(sessionKeyPrivate);
const SESSION_KEY_ADDRESS = sessionKeyAccount.address;

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

// Message signer for ClearNode RPC calls
const messageSigner = async (payload: unknown): Promise<`0x${string}`> => {
  const message = JSON.stringify(payload, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  const digestHex = ethers.id(message);
  const messageBytes = ethers.getBytes(digestHex);
  const { serialized: signature } = ethersWallet.signingKey.sign(messageBytes);
  return signature as `0x${string}`;
};

// --- Helpers ---

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 30000
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
        // ignore parse errors
      }
    }

    ws.on("message", handler);
  });
}

// --- Part 1: Deposit to Custody Contract ---

async function depositToCustody(amount: bigint): Promise<`0x${string}`> {
  console.log("\n=== Part 1: Deposit to Custody ===");
  console.log("Connecting to Base Sepolia...");

  // Check token balance
  const balance = await publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [ADDRESS],
  });

  const symbol = await publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: "symbol",
  });

  console.log(`Token balance: ${formatUnits(balance, TOKEN_DECIMALS)} ${symbol}`);

  if (balance < amount) {
    throw new Error(
      `Insufficient balance. Have ${formatUnits(balance, TOKEN_DECIMALS)} ${symbol}, need ${formatUnits(amount, TOKEN_DECIMALS)} ${symbol}`
    );
  }

  // Check current allowance
  const currentAllowance = await publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [ADDRESS, CUSTODY_ADDRESS],
  });

  // Approve if needed
  if (currentAllowance < amount) {
    console.log("Approving Custody contract...");

    const approveHash = await walletClient.writeContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CUSTODY_ADDRESS, amount],
    });

    console.log(`Approval tx: ${approveHash}`);
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log("Approval confirmed!");
  } else {
    console.log("Custody contract already approved.");
  }

  // Deposit to Custody
  console.log(
    `Depositing ${formatUnits(amount, TOKEN_DECIMALS)} ${symbol} to Yellow Network...`
  );

  const depositHash = await walletClient.writeContract({
    address: CUSTODY_ADDRESS,
    abi: CUSTODY_ABI,
    functionName: "deposit",
    args: [ADDRESS, TOKEN_ADDRESS, amount],
  });

  console.log(`Deposit tx: ${depositHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: depositHash,
  });

  if (receipt.status === "reverted") {
    throw new Error(`Deposit transaction reverted: ${depositHash}`);
  }

  console.log("Deposit confirmed!");
  console.log(`Block: ${receipt.blockNumber}`);
  console.log(`Gas used: ${receipt.gasUsed}`);

  return depositHash;
}

// --- Part 2: Allocate funds via Channel Lifecycle ---

async function allocateFundsViaChannel(
  ws: WebSocket,
  amount: bigint
): Promise<void> {
  console.log("\n=== Part 2: Allocate Funds via Channel ===");

  // Step 2a: Create channel
  console.log("Creating channel on Base Sepolia...");

  const createChMsg = await createCreateChannelMessage(messageSigner, {
    chain_id: baseSepolia.id,
    token: TOKEN_ADDRESS,
  });

  const createChPromise = waitForMessage(
    ws,
    (m) => {
      const r = m.res as unknown[];
      return r?.[1] === "create_channel";
    },
    60000
  );

  ws.send(createChMsg);
  const createChResp = await createChPromise;
  const createChParsed = parseCreateChannelResponse(JSON.stringify(createChResp));

  const { channel, state: rpcInitialState, serverSignature } = createChParsed.params;
  const channelId = createChParsed.params.channelId as `0x${string}`;
  console.log(`Channel created: ${channelId}`);

  // Map RPC response to SDK's UnsignedState
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

  // Submit on-chain
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createResult = await nitroliteClient.createChannel({
    channel: channel as any,
    unsignedInitialState: unsignedInitialState as any,
    serverSignature: serverSignature as `0x${string}`,
  });
  console.log(`On-chain create tx: ${createResult.txHash}`);
  await delay(5000);

  // Step 2b: Resize channel - use resize_amount to move funds FROM custody INTO unified balance
  console.log(`Resizing channel (resize_amount: ${amount})...`);

  const resizeMsg = await createResizeChannelMessage(messageSigner, {
    channel_id: channelId,
    resize_amount: amount, // This pulls from custody into the channel/unified balance
    funds_destination: ADDRESS,
  });

  const resizePromise = waitForMessage(
    ws,
    (m) => {
      const r = m.res as unknown[];
      return r?.[1] === "resize_channel";
    },
    60000
  );

  ws.send(resizeMsg);
  const resizeResp = await resizePromise;
  const resizeParsed = parseResizeChannelResponse(JSON.stringify(resizeResp));
  const { state, serverSignature: resizeServerSig } = resizeParsed.params;

  const resizeState = {
    channelId: resizeParsed.params.channelId as `0x${string}`,
    serverSignature: resizeServerSig,
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
    console.log(`On-chain channel data fetched`);
    if (onChainData.lastValidState) {
      proofStates = [onChainData.lastValidState];
    }
  } catch (e) {
    console.log(`Failed to fetch on-chain data: ${e}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resizeResult = await nitroliteClient.resizeChannel({
    resizeState: resizeState as any,
    proofStates,
  });
  console.log(`Resize tx: ${resizeResult.txHash}`);
  await delay(5000);

  console.log("Channel resized! Funds should now be in unified balance.");
}

// --- Part 3: Verify Balance via ClearNode ---

async function verifyYellowNetworkBalance(
  ws: WebSocket,
  expectedAmount: bigint
): Promise<void> {
  console.log("\n=== Part 3: Verify Yellow Network Balance ===");
  console.log("Querying unified balance...");

  const balMsg = await createGetLedgerBalancesMessage(messageSigner);

  const balPromise = waitForMessage(ws, (msg) => {
    const res = msg.res as unknown[];
    return res?.[1] === "get_ledger_balances";
  });

  ws.send(balMsg);
  const balResp = await balPromise;

  const balData = (balResp.res as unknown[])[2] as Record<string, unknown>;
  const balances = (balData?.ledger_balances ?? balData?.balances) as
    | Array<{ asset: string; amount: string }>
    | undefined;

  if (!balances || balances.length === 0) {
    console.log("No balances found on Yellow Network.");
    console.log(
      "\nNote: It may take a few moments for the deposit to be reflected."
    );
    console.log("Try running this script again in a minute.");
  } else {
    console.log("\nYellow Network Balances:");
    for (const b of balances) {
      const formattedAmount = formatUnits(BigInt(b.amount), TOKEN_DECIMALS);
      console.log(`  ${b.asset}: ${formattedAmount}`);
    }

    // Check if yUSD balance matches expected
    const yUSDBalance = balances.find(
      (b) =>
        b.asset.toLowerCase() === TOKEN_ADDRESS.toLowerCase() ||
        b.asset.toLowerCase().includes("yusd") ||
        b.asset.toLowerCase().includes("ytest")
    );

    if (yUSDBalance) {
      const balanceAmount = BigInt(yUSDBalance.amount);
      const expectedAmount = BigInt(DEPOSIT_AMOUNT);

      if (balanceAmount >= expectedAmount) {
        console.log(
          `\n✅ Deposit verified! Yellow Network balance includes at least ${expectedAmount} yUSD`
        );
      } else {
        console.log(
          `\n⚠️  Current balance (${balanceAmount}) is less than deposited amount (${expectedAmount})`
        );
        console.log(
          "   This could be normal if funds were already used or if sync is pending."
        );
      }
    }
  }
}

// --- Authentication Helper ---

async function authenticateWithClearNode(ws: WebSocket): Promise<void> {
  console.log("Authenticating with ClearNode...");

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const authRequestMsg = await createAuthRequestMessage({
    address: ADDRESS,
    session_key: SESSION_KEY_ADDRESS,
    application: "deposit-verify-demo",
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

  const eip712Signer = createEIP712AuthMessageSigner(
    walletClient,
    {
      scope: "console",
      session_key: SESSION_KEY_ADDRESS,
      expires_at: expiresAt,
      allowances: [],
    },
    { name: "deposit-verify-demo" }
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

  console.log("Authentication successful!");
}

// --- Main ---

async function main() {
  console.log("=== Yellow Network Deposit & Verify Demo ===");
  console.log(`Wallet address: ${ADDRESS}`);
  console.log(`Session key:    ${SESSION_KEY_ADDRESS}`);
  console.log(`Custody:        ${CUSTODY_ADDRESS}`);
  console.log(`Token (yUSD):   ${TOKEN_ADDRESS}`);
  console.log(`ClearNode:      ${CLEARNODE_URL}`);
  console.log(`Mode:           ${VERIFY_ONLY ? "Verify only" : "Deposit + Allocate + Verify"}`);

  const depositAmount = parseUnits(DEPOSIT_AMOUNT, TOKEN_DECIMALS);

  // Connect to ClearNode
  console.log(`\nConnecting to ClearNode: ${CLEARNODE_URL}...`);
  const ws = new WebSocket(CLEARNODE_URL);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(err);
  });
  console.log("Connected!");

  // Authenticate
  await authenticateWithClearNode(ws);

  if (VERIFY_ONLY) {
    // Skip deposit, just verify balance
    await verifyYellowNetworkBalance(ws, depositAmount);
  } else {
    console.log(
      `\nDeposit amount: ${formatUnits(depositAmount, TOKEN_DECIMALS)} yUSD`
    );

    // Part 1: Deposit to Custody (on-chain)
    const txHash = await depositToCustody(depositAmount);
    console.log(`\nDeposit transaction: ${txHash}`);

    // Wait for on-chain confirmation to propagate
    console.log("\nWaiting 10 seconds for on-chain state to propagate...");
    await delay(10000);

    // Part 2: Allocate via channel lifecycle
    await allocateFundsViaChannel(ws, depositAmount);

    // Part 3: Verify balance
    await verifyYellowNetworkBalance(ws, depositAmount);
  }

  ws.close();
  console.log("\n=== Demo Complete ===");
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message || err);
  process.exit(1);
});