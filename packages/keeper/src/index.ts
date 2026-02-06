import { Keeper } from "./keeper.js";
import { PriceFetcher } from "./priceFetcher.js";
import { WebSocketServer } from "./wsServer.js";
import type { MarketConfig } from "./types.js";

const WS_PORT = 3001;

// BTC/USDC Market Configuration
// Smaller price increments = more rows = harder to win
// Smaller time increments = more columns = spreads probability thinner
const btcMarket: MarketConfig = {
  marketId: 1,
  marketName: "BTC/USDC",
  asset: "BTC",
  priceIncrement: 100,   // $100 per row (was $200) - smaller ranges
  timeIncrement: 5,      // 5 seconds per column (was 10) - more columns

  roundDuration: 120,    // 2 minutes total
  bettingDuration: 60,   // 1 minute betting, 1 minute live
  // Results in 12 columns (60s / 5s) instead of 6
};

// ETH/USDC Market Configuration (alternative)
const ethMarket: MarketConfig = {
  marketId: 2,
  marketName: "ETH/USDC",
  asset: "ETH",
  priceIncrement: 10,    // $10 per row (was $20) - smaller ranges
  timeIncrement: 5,      // 5 seconds per column (was 10) - more columns
  roundDuration: 120,
  bettingDuration: 60,
};

async function main() {
  console.log("=".repeat(50));
  console.log("Onigo Keeper - No Signup Required!");
  console.log("=".repeat(50));
  console.log("");
  console.log("Price Sources:");
  console.log("  1. Binance (primary) - No signup, 6000 req/min");
  console.log("  2. Kraken (fallback) - No signup, 1 req/sec");
  console.log("  3. CoinGecko (fallback) - No signup, 5-15 req/min");
  console.log("");

  const wsServer = new WebSocketServer(WS_PORT);
  const priceFetcher = new PriceFetcher();
  const marketArg = process.argv[2];
  const market = marketArg === "eth" ? ethMarket : btcMarket;

  console.log(`Selected market: ${market.marketName}`);
  console.log("");
  console.log("Testing price fetch...");
  try {
    const testPrice = await priceFetcher.fetchPrice(market.asset);
    console.log(
      `${market.asset} price: $${testPrice.price.toLocaleString()} from ${testPrice.source}`
    );
  } catch (err) {
    console.error("Price fetch failed:", err);
    process.exit(1);
  }
  console.log("");

  const keeper = new Keeper(market, priceFetcher, wsServer);

  await keeper.startRound(1);

  console.log(`WebSocket server running on ws://localhost:${WS_PORT}`);
  console.log("Connect your frontend to receive updates!");
}

main().catch(console.error);

// Export for use as module
export { Keeper } from "./keeper.js";
export { PriceFetcher } from "./priceFetcher.js";
export { WebSocketServer } from "./wsServer.js";
export { deriveHitCells, priceToRowStart, timestampToColumnStart } from "./gridDeriver.js";
export { calculateGridBounds } from "./gridBounds.js";
export * from "./types.js";
