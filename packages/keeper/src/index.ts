import { Keeper } from "./keeper.js";
import { PriceFetcher } from "./priceFetcher.js";
import { WebSocketServer } from "./wsServer.js";
import { HttpServer } from "./httpServer.js"; 
import type { MarketConfig } from "./types.js";
import { calculateCurrentRound, fetchMarketsFromContract } from "./contractClient.js";

const WS_PORT = 3001;
const HTTP_PORT = 3003; 

async function main() {
  console.log("=".repeat(50));
  console.log("Onigo Keeper - No Signup Required!");
  console.log("=".repeat(50));
  
  const CONTRACT_ADDRESS = process.env.ONIGO_CONTRACT_ADDRESS || "0x95240d08ee46850C404514654A451F2c8D6f8688"; 
  const RPC_URL = process.env.RPC_URL || "https://base-sepolia-rpc.publicnode.com";

  console.log("\nFetching markets from contract...");
  
  let markets: MarketConfig[];
  try {
    markets = await fetchMarketsFromContract(CONTRACT_ADDRESS, RPC_URL);
    console.log(`Found ${markets.length} markets on-chain`);
    
    for (const market of markets) {
      console.log(`  - ${market.marketName} (ID: ${market.marketId})`);
    }
  } catch (err) {
    console.error("Failed to fetch markets from contract:", err);
    process.exit(1);
  }

  if (markets.length === 0) {
    console.error("No markets found in contract");
    process.exit(1);
  }

  const priceFetcher = new PriceFetcher();
  
  const marketArg = process.argv[2];
  let selectedMarket: MarketConfig;
  
  if (marketArg) {
    const found = markets.find(m => m.asset.toLowerCase() === marketArg.toLowerCase());
    if (!found) {
      console.error(`Market ${marketArg} not found in contract`);
      process.exit(1);
    }
    selectedMarket = found;
  } else {
    selectedMarket = markets[0];
  }

  console.log(`\nSelected market: ${selectedMarket.marketName}`);
  
  const currentRound = calculateCurrentRound(
    selectedMarket.marketStartTime!,
    selectedMarket.roundLength!
  );
  
  console.log(`Current round calculated: ${currentRound}`);
  console.log("");

  console.log("Testing price fetch...");
  try {
    const testPrice = await priceFetcher.fetchPrice(selectedMarket.asset);
    console.log(
      `${selectedMarket.asset} price: $${testPrice.price.toLocaleString()} from ${testPrice.source}`
    );
  } catch (err) {
    console.error("Price fetch failed:", err);
    process.exit(1);
  }
  console.log("");

  // Create keeper first (needed by both servers)
  const wsServer = new WebSocketServer(WS_PORT);
  const keeper = new Keeper(selectedMarket, priceFetcher, wsServer);
  
  // ADD HTTP SERVER
  const httpServer = new HttpServer(HTTP_PORT, keeper);

  await keeper.startRound(currentRound);

  console.log(`WebSocket server running on ws://localhost:${WS_PORT}`);
  console.log(`HTTP API server running on http://localhost:${HTTP_PORT}`);
  console.log("Connect your frontend to receive updates!");
}

main().catch(console.error);

export { Keeper } from "./keeper.js";
export { PriceFetcher } from "./priceFetcher.js";
export { WebSocketServer } from "./wsServer.js";
export { HttpServer } from "./httpServer.js"; 
export { deriveHitCells, priceToRowStart, timestampToColumnStart } from "./gridDeriver.js";
export { calculateGridBounds } from "./gridBounds.js";
export * from "./types.js";