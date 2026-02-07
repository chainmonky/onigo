import { ethers } from "ethers";
import type { MarketConfig } from "./types.js";

const ONIGO_ABI = [
  {
    type: "function",
    name: "markets",
    inputs: [{ name: "", type: "uint16", internalType: "uint16" }],
    outputs: [
      { name: "commissionBps", type: "uint8", internalType: "uint8" },
      { name: "dataPower", type: "int8", internalType: "int8" },
      { name: "marketId", type: "uint16", internalType: "uint16" },
      { name: "dataIncrement", type: "uint32", internalType: "uint32" },
      { name: "timeSlotWidth", type: "uint32", internalType: "uint32" },
      { name: "marketStartTime", type: "uint256", internalType: "uint256" },
      { name: "roundLength", type: "uint256", internalType: "uint256" },
      { name: "marketName", type: "string", internalType: "string" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "numMarkets",
    inputs: [],
    outputs: [{ name: "", type: "uint16", internalType: "uint16" }],
    stateMutability: "view",
  },
] as const;

export async function fetchMarketsFromContract(
  contractAddress: string,
  rpcUrl: string
): Promise<MarketConfig[]> {

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  
  if (!ethers.isAddress(contractAddress)) {
    throw new Error(`Invalid contract address: ${contractAddress}`);
  }
  
  const contract = new ethers.Contract(
    contractAddress, 
    ONIGO_ABI, 
    provider
  );

  try {
    const numMarkets = await contract.numMarkets();
    console.log(`Number of markets in contract: ${numMarkets}`);
    
    const markets: MarketConfig[] = [];

    for (let i = 1; i <= numMarkets; i++) {
      const marketData = await contract.markets(i);
      
      const [
        commissionBps, 
        dataPower, 
        marketId, 
        dataIncrement, 
        timeSlotWidth, 
        marketStartTime, 
        roundLength, 
        marketName
      ] = marketData;

      const priceInc = Number(dataIncrement) * Math.pow(10, Number(dataPower));
      
      markets.push({
        marketId: Number(marketId),
        marketName: marketName,
        asset: marketName.split("/")[0],
        priceIncrement: priceInc,
        timeIncrement: Number(timeSlotWidth),
        roundDuration: Number(roundLength),
        bettingDuration: Number(roundLength) / 2,
        marketStartTime: Number(marketStartTime),
        roundLength: Number(roundLength),
      });
      
      console.log(`  Loaded: ${marketName} (Round length: ${roundLength}s)`);
    }

    return markets;
  } catch (error: any) {
    console.error("Contract call failed:", error.message);
    throw error;
  }
}

export function calculateCurrentRound(marketStartTime: number, roundLength: number): number {
  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - marketStartTime;
  
  if (elapsed < 0) {
    console.log("Market hasn't started yet, starting from round 1");
    return 1;
  }
  
  const round = Math.floor(elapsed / roundLength) + 1;
  console.log(`Time elapsed: ${elapsed}s, Round length: ${roundLength}s`);
  return round;
}