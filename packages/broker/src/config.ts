/**
 * Broker Configuration
 *
 * Environment variables and configuration for the broker service.
 */

import "dotenv/config";

export const config = {
  // Broker wallet private key (also used as receiver in Yellow Network)
  BROKER_PRIVATE_KEY: process.env.RECEIVER_PRIVATE_KEY!,

  // Yellow Network ClearNode WebSocket URL
  CLEARNODE_URL: process.env.CLEARNODE_URL ?? "wss://clearnet-sandbox.yellow.com/ws",

  // Blockchain RPC URL
  RPC_URL: process.env.RPC_URL ?? "http://127.0.0.1:8545",

  // Chain ID (Base Sepolia = 84532, local = 31337)
  CHAIN_ID: parseInt(process.env.CHAIN_ID ?? "31337"),

  // Onigo contract address (deployed via yarn deploy)
  ONIGO_CONTRACT_ADDRESS: process.env.ONIGO_CONTRACT_ADDRESS as `0x${string}`,

  // USDC token address
  USDC_ADDRESS: process.env.USDC_ADDRESS as `0x${string}`,

  // Keeper service URL for fetching hit cells
  KEEPER_URL: process.env.KEEPER_URL ?? "http://localhost:3002",

  // Broker API WebSocket port
  BROKER_API_PORT: parseInt(process.env.BROKER_API_PORT ?? "3001"),

  // Yellow Network contract addresses (Base Sepolia)
  CUSTODY_ADDRESS: (process.env.CUSTODY_ADDRESS ?? "0x019B65A265EB3363822f2752141b3dF16131b262") as `0x${string}`,
  ADJUDICATOR_ADDRESS: (process.env.ADJUDICATOR_ADDRESS ?? "0x7c7ccbc98469190849BCC6c926307794fDfB11F2") as `0x${string}`,
  TOKEN_ADDRESS: (process.env.TOKEN_ADDRESS ?? "0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb") as `0x${string}`,
};

// Validate required config
export function validateConfig(): void {
  if (!config.BROKER_PRIVATE_KEY) {
    throw new Error("Required: RECEIVER_PRIVATE_KEY environment variable");
  }
}
