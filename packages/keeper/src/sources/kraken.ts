import type { PriceSource } from "../types.js";

interface KrakenTickerData {
  c: [string, string];
}

interface KrakenResponse {
  error: string[];
  result: Record<string, KrakenTickerData>;
}

export class KrakenPriceSource implements PriceSource {
  name = "Kraken";
  private getPair(asset: string): string {
    const pairs: Record<string, string> = {
      BTC: "XBTUSD",
      ETH: "ETHUSD",
      SOL: "SOLUSD",
      AVAX: "AVAXUSD",
      MATIC: "MATICUSD",
      LINK: "LINKUSD",
      DOT: "DOTUSD",
      ATOM: "ATOMUSD",
    };
    return pairs[asset.toUpperCase()] || `${asset.toUpperCase()}USD`;
  }

  async fetchPrice(asset: string): Promise<number> {
    const pair = this.getPair(asset);

    // Public endpoint - no API key needed
    // Rate limit: 1 request per second for public endpoints
    const url = `https://api.kraken.com/0/public/Ticker?pair=${pair}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Kraken API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as KrakenResponse;

    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken error: ${data.error.join(", ")}`);
    }

    // Kraken returns result with the pair name as key
    // The 'c' field is [price, lot volume] for last trade
    const resultKey = Object.keys(data.result)[0];
    if (!resultKey) {
      throw new Error("Kraken: No result in response");
    }

    const ticker = data.result[resultKey];
    return parseFloat(ticker.c[0]); // 'c' = last trade closed [price, lot volume]
  }
}
