/**
 * Demo Client: Submit bets to the Onigo Broker
 *
 * The broker creates and signs the app session on behalf of the player.
 * After session creation, the broker can update state unilaterally (weights [0, 100]).
 *
 * Usage:
 *   PLAYER_PRIVATE_KEY=0x... yarn demo
 */

import "dotenv/config";
import WebSocket from "ws";
import { ethers } from "ethers";
import { Address, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, encodeAbiParameters, type Hex, WalletClient } from "viem";
import { baseSepolia } from "viem/chains";
import { Client } from "yellow-ts";
import {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  parseAuthChallengeResponse,
  parseAnyRPCResponse,
  RPCMethod,
  createECDSAMessageSigner,
  createAppSessionMessage,
  RPCProtocolVersion,
  RPCData,
  RPCResponse,
  AuthChallengeResponse
} from "@erc7824/nitrolite";

const yellow = new Client({
        url: 'wss://clearnet-sandbox.yellow.com/ws',
    });


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
const CLEARNODE_URL = "wss://clearnet-sandbox.yellow.com/ws";

const viemAccount = privateKeyToAccount(PLAYER_PRIVATE_KEY as `0x${string}`);

const walletClient = createWalletClient({
  account: viemAccount,
  chain: baseSepolia,
  transport: http(),
});

const sessionKeyPrivate = generatePrivateKey();
const sessionKeyAccount = privateKeyToAccount(sessionKeyPrivate);
const SESSION_KEY_ADDRESS = sessionKeyAccount.address;
const messageSigner = createECDSAMessageSigner(sessionKeyPrivate);

if (!PLAYER_PRIVATE_KEY) {
  console.error("Required: PLAYER_PRIVATE_KEY (or SENDER_PRIVATE_KEY)");
  process.exit(1);
}

// Derive player address from private key
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
        address: PLAYER_ADDRESS,
        session_key: SESSION_KEY_ADDRESS,
        application: "onigo-demo",
        expires_at: expiresAt,
        scope: "console",
        allowances,
    });

    async function handleAuthChallenge(message: AuthChallengeResponse) {

        const authParams = {
            address: PLAYER_ADDRESS,
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
  payload: unknown;
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

// --- Main ---

async function main() {
  console.log("1. Connecting to ClearNode...");
  await yellow.connect();

  console.log("   Connected.\n");

  // 2. Authenticate
  console.log("2. Authenticating...");

  const sessionKey = await authenticateWallet(yellow, walletClient as WalletClient);
  const messageSigner = createECDSAMessageSigner(sessionKey.privateKey);

  console.log("   Authenticated.\n");

  console.log("3. Connecting to broker...");
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
  console.log("4. Getting broker address...");
  const brokerInfo = await sendRequest<{ type: "broker_address"; address: string }>({
    type: "get_broker_address",
  });
  const BROKER_ADDRESS = brokerInfo.address as `0x${string}`;
  console.log(`   Broker: ${BROKER_ADDRESS}\n`);

  // 5. Create session with bet (broker handles Yellow Network interaction)
  console.log("5. Creating session with bet...");

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
    application: "onigo-demo",
    protocol: RPCProtocolVersion.NitroRPC_0_4,
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

  const createSessionMsg = await createAppSessionMessage(messageSigner, {
    definition: appDefinition,
    allocations,
    session_data: encodedBetData,
  });

  const createSessionMsgJson = JSON.parse(createSessionMsg);

  // Sign the payload
  console.log(createSessionMsgJson);
  console.log(`   Round: ${roundId}`);
  console.log(`   Cells: [${now}, 3100], [${now + 300}, 3200]`);

  // Send bet details to broker - broker creates the app session
  const createRequest: CreateSessionRequest = {
    type: "create_session",
    playerAddress: PLAYER_ADDRESS,
    amount: BET_AMOUNT,
    roundId,
    bets,
    payload: createSessionMsgJson
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
