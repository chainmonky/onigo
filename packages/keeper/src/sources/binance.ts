import type { PriceSource } from "../types.js";

export class BinancePriceSource implements PriceSource {
  name = "Binance";
  private getSymbol(asset: string): string {
    const symbols: Record<string, string> = {
      BTC: "BTCUSDT",
      ETH: "ETHUSDT",
      SOL: "SOLUSDT",
      AVAX: "AVAXUSDT",
      MATIC: "MATICUSDT",
      LINK: "LINKUSDT",
      DOT: "DOTUSDT",
      ATOM: "ATOMUSDT",
    };
    return symbols[asset.toUpperCase()] || `${asset.toUpperCase()}USDT`;
  }

  async fetchPrice(asset: string): Promise<number> {
    const symbol = this.getSymbol(asset);

    // Public endpoint - no API key needed
    // Rate limit: 6000 weight per minute, ticker is weight 2
    // That's ~3000 requests per minute = 50/sec (way more than we need)
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Binance API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as { price?: string; code?: number; msg?: string };

    if (data.code) {
      throw new Error(`Binance error: ${data.msg}`);
    }

    if (!data.price) {
      throw new Error("Binance: No price in response");
    }

    return parseFloat(data.price);
  }
}
