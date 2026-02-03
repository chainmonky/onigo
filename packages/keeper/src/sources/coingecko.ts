import type { PriceSource } from "../types.js";

interface CoinGeckoResponse {
  [coinId: string]: {
    usd: number;
  };
}

export class CoinGeckoPriceSource implements PriceSource {
  name = "CoinGecko";
  private getCoinId(asset: string): string {
    const ids: Record<string, string> = {
      BTC: "bitcoin",
      ETH: "ethereum",
      SOL: "solana",
      AVAX: "avalanche-2",
      MATIC: "matic-network",
      LINK: "chainlink",
      DOT: "polkadot",
      ATOM: "cosmos",
    };
    return ids[asset.toUpperCase()] || asset.toLowerCase();
  }

  async fetchPrice(asset: string): Promise<number> {
    const coinId = this.getCoinId(asset);

    // Public endpoint - no API key needed
    // Rate limit: 5-15 requests per minute (varies by load)
    // With free "Demo" account signup: 30 requests per minute
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;

    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error("CoinGecko rate limit exceeded");
      }
      throw new Error(
        `CoinGecko API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as CoinGeckoResponse;

    if (!data[coinId]) {
      throw new Error(`CoinGecko: coin ${coinId} not found`);
    }

    return data[coinId].usd;
  }
}
