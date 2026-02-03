import type { PriceSource, PriceDataPoint } from "./types.js";
import {
  BinancePriceSource,
  KrakenPriceSource,
  CoinGeckoPriceSource,
} from "./sources/index.js";

export class PriceFetcher {
  private sources: PriceSource[];
  private lastSuccessfulSource: string | null = null;
  private failureCounts: Map<string, number> = new Map();

  constructor() {
    // Order: Primary → Fallback 1 → Fallback 2
    this.sources = [
      new BinancePriceSource(),
      new KrakenPriceSource(),
      new CoinGeckoPriceSource(),
    ];
  }

  async fetchPrice(asset: string): Promise<PriceDataPoint> {
    const timestamp = Math.floor(Date.now() / 1000);
    const errors: string[] = [];

    // Try last successful source first (optimization)
    if (this.lastSuccessfulSource) {
      const lastSource = this.sources.find(
        (s) => s.name === this.lastSuccessfulSource
      );
      if (lastSource) {
        try {
          const price = await this.withTimeout(
            lastSource.fetchPrice(asset),
            3000
          );
          this.recordSuccess(lastSource.name);
          return { price, timestamp, source: lastSource.name };
        } catch {
          // Fall through to try all sources
        }
      }
    }

    // Try each source in order
    for (const source of this.sources) {
      try {
        const price = await this.withTimeout(source.fetchPrice(asset), 5000);
        this.recordSuccess(source.name);
        console.log(
          `[Price] ${asset} = $${price.toLocaleString()} from ${source.name}`
        );
        return { price, timestamp, source: source.name };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push(`${source.name}: ${errorMsg}`);
        this.recordFailure(source.name);
      }
    }

    throw new Error(
      `All price sources failed for ${asset}: ${errors.join("; ")}`
    );
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), ms)
      ),
    ]);
  }

  private recordSuccess(name: string) {
    this.lastSuccessfulSource = name;
    this.failureCounts.set(name, 0);
  }

  private recordFailure(name: string) {
    const current = this.failureCounts.get(name) || 0;
    this.failureCounts.set(name, current + 1);

    // If primary has failed multiple times, clear last successful
    // to force trying all sources next time
    if (current >= 3 && name === this.lastSuccessfulSource) {
      this.lastSuccessfulSource = null;
    }
  }

  getStatus(): Record<string, { failures: number; isLastSuccessful: boolean }> {
    const status: Record<
      string,
      { failures: number; isLastSuccessful: boolean }
    > = {};
    for (const source of this.sources) {
      status[source.name] = {
        failures: this.failureCounts.get(source.name) || 0,
        isLastSuccessful: source.name === this.lastSuccessfulSource,
      };
    }
    return status;
  }
}
