/**
 * Query all app sessions for an address via Yellow ClearNode
 *
 * Usage:
 *   PRIVATE_KEY=0x... yarn get-app-sessions
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
  createGetAppSessionsMessage,
  parseAuthChallengeResponse,
  parseAnyRPCResponse,
  parseGetAppSessionsResponse,
  RPCMethod,
} from "@erc7824/nitrolite";

// --- Config ---

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? process.env.RECEIVER_PRIVATE_KEY;
const CLEARNODE_URL =
  process.env.CLEARNODE_URL ?? "wss://clearnet-sandbox.yellow.com/ws";

if (!PRIVATE_KEY) {
  console.error("Required: PRIVATE_KEY or RECEIVER_PRIVATE_KEY");
  process.exit(1);
}

const ethersWallet = new ethers.Wallet(PRIVATE_KEY);
const ADDRESS = ethersWallet.address as `0x${string}`;

// Viem wallet client for EIP-712 auth signing
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

console.log(`Address:     ${ADDRESS}`);
console.log(`Session key: ${SESSION_KEY_ADDRESS}`);
console.log(`ClearNode:   ${CLEARNODE_URL}\n`);

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

  // 3. Query app sessions
  console.log("3. Querying app sessions...");

  // Use SDK helper - it takes (signer, participant, status?)
  const getAppSessionsMsg = await createGetAppSessionsMessage(
    messageSigner,
    ADDRESS,  // participant address to query
    undefined // no status filter - get all
  );

  const sessionsPromise = waitForMessage(ws, (m) => {
    const r = m.res as unknown[];
    return r?.[1] === "get_app_sessions";
  }, 15000);

  ws.send(getAppSessionsMsg);
  const sessionsResp = await sessionsPromise;

  console.log("\n=== RAW RESPONSE ===\n");
  console.log(JSON.stringify(sessionsResp, null, 2));

  try {
    const parsed = parseGetAppSessionsResponse(JSON.stringify(sessionsResp));
    console.log("\n=== PARSED APP SESSIONS ===\n");
    console.log(JSON.stringify(parsed, null, 2));
  } catch (e) {
    console.log("\n=== PARSE ERROR ===\n", e);
  }

  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
