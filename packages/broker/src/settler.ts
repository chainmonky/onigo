/**
 * Settler
 *
 * Handles on-chain settlement via Onigo.sol contract.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { localhost, baseSepolia } from "viem/chains";
import { config } from "./config.js";
import type { GridCell, Market, PayoutResult } from "./types.js";

// Onigo contract ABI (minimal - just what we need)
const ONIGO_ABI = [
  {
    name: "settleRound",
    type: "function",
    inputs: [
      { name: "marketId", type: "uint16" },
      { name: "roundId", type: "uint32" },
      {
        name: "_winningCells",
        type: "tuple[]",
        components: [
          { name: "timeSlotStart", type: "uint256" },
          { name: "dataRangeStart", type: "int256" },
        ],
      },
      { name: "players", type: "address[]" },
      { name: "payouts", type: "uint256[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "markets",
    type: "function",
    inputs: [{ name: "marketId", type: "uint16" }],
    outputs: [
      { name: "commissionBps", type: "uint8" },
      { name: "dataPower", type: "int8" },
      { name: "marketId", type: "uint16" },
      { name: "dataIncrement", type: "uint32" },
      { name: "timeSlotWidth", type: "uint32" },
      { name: "marketStartTime", type: "uint256" },
      { name: "roundLength", type: "uint256" },
      { name: "marketName", type: "string" },
    ],
    stateMutability: "view",
  },
  {
    name: "broker",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

// ERC20 ABI for USDC approval
const ERC20_ABI = [
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
] as const;

/**
 * Handles on-chain settlement for completed rounds.
 */
export class Settler {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private account: ReturnType<typeof privateKeyToAccount>;
  private chain: Chain;

  constructor() {
    this.account = privateKeyToAccount(config.BROKER_PRIVATE_KEY as `0x${string}`);
    this.chain = config.CHAIN_ID === 31337 ? localhost : baseSepolia;

    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(config.RPC_URL),
    });

    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(config.RPC_URL),
    });

    console.log(`[Settler] Initialized with broker address: ${this.account.address}`);
    console.log(`[Settler] Chain: ${this.chain.name} (${config.CHAIN_ID})`);
    console.log(`[Settler] Onigo contract: ${config.ONIGO_CONTRACT_ADDRESS}`);
  }

  /**
   * Get market configuration from the contract.
   */
  async getMarketConfig(marketId: number): Promise<Market> {
    const result = await this.publicClient.readContract({
      address: config.ONIGO_CONTRACT_ADDRESS,
      abi: ONIGO_ABI,
      functionName: "markets",
      args: [marketId],
    });

    return {
      commissionBps: result[0],
      dataPower: result[1],
      marketId: result[2],
      dataIncrement: result[3],
      timeSlotWidth: result[4],
      marketStartTime: result[5],
      roundLength: result[6],
      marketName: result[7],
    };
  }

  /**
   * Settle a round on-chain.
   *
   * Steps:
   * 1. Check/increase USDC allowance for Onigo contract
   * 2. Call settleRound() with winning cells, players, and payouts
   * 3. Wait for transaction confirmation
   *
   * @returns Transaction hash
   */
  async settleRound(
    marketId: number,
    roundId: number,
    winningCells: GridCell[],
    payoutResult: PayoutResult
  ): Promise<`0x${string}`> {
    console.log(`[Settler] Settling round: market=${marketId} round=${roundId}`);
    console.log(`[Settler] Winners: ${payoutResult.players.length}`);
    console.log(`[Settler] Total payout: ${payoutResult.totalPayout}`);

    if (payoutResult.players.length === 0) {
      throw new Error("No players to settle");
    }

    // Step 1: Check and approve USDC if needed
    const currentAllowance = await this.publicClient.readContract({
      address: config.USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.account.address, config.ONIGO_CONTRACT_ADDRESS],
    });

    if (currentAllowance < payoutResult.totalPayout) {
      console.log(`[Settler] Approving USDC: ${payoutResult.totalPayout}`);

      const approveHash = await this.walletClient.writeContract({
        address: config.USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [config.ONIGO_CONTRACT_ADDRESS, payoutResult.totalPayout],
      });

      await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log(`[Settler] USDC approved: ${approveHash}`);
    }

    // Step 2: Format winning cells for contract
    const formattedCells = winningCells.map((cell) => ({
      timeSlotStart: cell.timeSlotStart,
      dataRangeStart: cell.dataRangeStart,
    }));

    // Step 3: Call settleRound
    console.log(`[Settler] Calling settleRound...`);

    const txHash = await this.walletClient.writeContract({
      address: config.ONIGO_CONTRACT_ADDRESS,
      abi: ONIGO_ABI,
      functionName: "settleRound",
      args: [marketId, roundId, formattedCells, payoutResult.players, payoutResult.payouts],
    });

    console.log(`[Settler] Transaction submitted: ${txHash}`);

    // Step 4: Wait for confirmation
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === "reverted") {
      throw new Error(`Settlement transaction reverted: ${txHash}`);
    }

    console.log(`[Settler] Round settled successfully!`);
    console.log(`[Settler] Block: ${receipt.blockNumber}`);
    console.log(`[Settler] Gas used: ${receipt.gasUsed}`);

    return txHash;
  }

  /**
   * Get broker address registered in the contract.
   */
  async getContractBroker(): Promise<`0x${string}`> {
    const broker = await this.publicClient.readContract({
      address: config.ONIGO_CONTRACT_ADDRESS,
      abi: ONIGO_ABI,
      functionName: "broker",
    });
    return broker as `0x${string}`;
  }

  /**
   * Verify this settler is the registered broker.
   */
  async verifyBrokerRole(): Promise<boolean> {
    const contractBroker = await this.getContractBroker();
    const isAuthorized = contractBroker.toLowerCase() === this.account.address.toLowerCase();

    if (!isAuthorized) {
      console.warn(`[Settler] WARNING: This address (${this.account.address}) is not the registered broker!`);
      console.warn(`[Settler] Contract broker: ${contractBroker}`);
    }

    return isAuthorized;
  }
}
