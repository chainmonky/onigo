/**
 * Check Yellow ledger balance for a given private key
 *
 * Usage:
 *   PRIVATE_KEY=0x... yarn check-balance
 */

import "dotenv/config";
import WebSocket from "ws";
import { ethers } from "ethers";
import { createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createGetLedgerBalancesMessage,
  parseAuthChallengeResponse,
  parseAnyRPCResponse,
  RPCMethod,
} from "@erc7824/nitrolite";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CLEARNODE_URL =
  process.env.CLEARNODE_URL ?? "wss://clearnet-sandbox.yellow.com/ws";

if (!PRIVATE_KEY) {
  console.error("Required: PRIVATE_KEY");
  process.exit(1);
}

const ethersWallet = new ethers.Wallet(PRIVATE_KEY);
const ADDRESS = ethersWallet.address as `0x${string}`;

// Viem wallet client for EIP-712 auth signing (wallet owner signs to authorize session key)
const viemAccount = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({
  account: viemAccount,
  chain: sepolia,
  transport: http(),
});

// Random session key (ephemeral)
const sessionKeyPrivate = generatePrivateKey();
const sessionKeyAccount = privateKeyToAccount(sessionKeyPrivate);
const SESSION_KEY_ADDRESS = sessionKeyAccount.address;

const messageSigner = async (payload: unknown): Promise<`0x${string}`> => {
  const message = JSON.stringify(payload);
  const digestHex = ethers.id(message);
  const messageBytes = ethers.getBytes(digestHex);
  const { serialized: signature } = ethersWallet.signingKey.sign(messageBytes);
  return signature as `0x${string}`;
};

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

async function main() {
  console.log(`Address:   ${ADDRESS}`);
  console.log(`ClearNode: ${CLEARNODE_URL}\n`);

  const ws = new WebSocket(CLEARNODE_URL);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(err);
  });

  // Auth
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
  console.log("Authenticated.\n");

  // Query balance
  const balMsg = await createGetLedgerBalancesMessage(messageSigner);
  const balPromise = waitForMessage(ws, (msg) => {
    const res = msg.res as unknown[];
    return res?.[1] === "get_ledger_balances";
  });

  ws.send(balMsg);
  const balResp = await balPromise;
  const balData = (balResp.res as unknown[])[2] as Record<string, unknown>;
  const balances = (balData?.ledger_balances ?? balData?.balances) as
    | Record<string, unknown>[]
    | undefined;

  if (!balances || balances.length === 0) {
    console.log("No balances found.");
  } else {
    console.log("Balances:");
    for (const b of balances) {
      console.log(`  ${b.asset}: ${b.amount}`);
    }
  }

  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
