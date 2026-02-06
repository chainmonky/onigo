import type { Socket } from "socket.io";
import type {
  MarketConfig,
  PriceDataPoint,
  GridCell,
  RoundState,
  RoundStartMessage,
  PhaseChangeMessage,
  PriceUpdateMessage,
  RoundEndMessage,
} from "./types.js";
import { RoundPhase } from "./types.js";
import type { PriceFetcher } from "./priceFetcher.js";
import { deriveHitCells } from "./gridDeriver.js";
import { calculateGridBounds } from "./gridBounds.js";
import type { WebSocketServer } from "./wsServer.js";

export class Keeper {
  private market: MarketConfig;
  private currentRound: RoundState | null = null;
  private priceFetcher: PriceFetcher;
  private wsServer: WebSocketServer;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    market: MarketConfig,
    priceFetcher: PriceFetcher,
    wsServer: WebSocketServer
  ) {
    this.market = market;
    this.priceFetcher = priceFetcher;
    this.wsServer = wsServer;
    this.wsServer.onSubscribe((marketId, ws) => {
      if (marketId === this.market.marketId && this.currentRound) {
        this.sendCurrentStateToClient(ws);
      }
    });
  }

  private sendCurrentStateToClient(ws: Socket) {
    if (!this.currentRound) return;

    const hitCells = deriveHitCells(
      this.currentRound.priceHistory,
      this.market
    );
    const message: RoundStartMessage = {
      type: "ROUND_START",
      payload: {
        marketId: this.market.marketId,
        roundId: this.currentRound.roundId,
        phase: this.currentRound.phase,
        initialPrice: this.currentRound.initialPrice!,
        gridBounds: this.currentRound.gridBounds!,
        timing: {
          roundStartTime: this.currentRound.roundStartTime,
          bettingEndTime: this.currentRound.bettingEndTime,
          liveEndTime: this.currentRound.liveEndTime,
        },
        config: {
          priceIncrement: this.market.priceIncrement,
          timeIncrement: this.market.timeIncrement,
        },
      },
    };
    this.wsServer.sendToClient(ws, message);

    // If we're in LIVE phase, also send the current price and hit cells
    if (
      this.currentRound.phase === RoundPhase.LIVE &&
      this.currentRound.currentPrice
    ) {
      const priceMessage: PriceUpdateMessage = {
        type: "PRICE_UPDATE",
        payload: {
          marketId: this.market.marketId,
          roundId: this.currentRound.roundId,
          price: this.currentRound.currentPrice,
          timestamp: Math.floor(Date.now() / 1000),
          source: "catchup",
          hitCells,
          gridBounds: this.currentRound.gridBounds,
        },
      };
      this.wsServer.sendToClient(ws, priceMessage);
    }

    console.log(
      `[Keeper] Sent current state to new client (round ${this.currentRound.roundId}, phase ${this.currentRound.phase})`
    );
  }

  async startRound(roundId: number) {
    const initial = await this.priceFetcher.fetchPrice(this.market.asset);

    const now = Math.floor(Date.now() / 1000);
    const roundStartTime = now;
    const bettingEndTime = now + this.market.bettingDuration;
    const liveEndTime = now + this.market.roundDuration;

    this.market.roundStartTime = roundStartTime;
    this.market.initialPrice = initial.price;

    const gridBounds = calculateGridBounds(this.market, initial.price);

    this.currentRound = {
      marketId: this.market.marketId,
      roundId,
      phase: RoundPhase.BETTING,
      roundStartTime,
      bettingEndTime,
      liveEndTime,
      priceHistory: [],
      currentPrice: initial.price,
      initialPrice: initial.price,
      gridBounds,
    };

    console.log(`\n${"=".repeat(50)}`);
    console.log(`[Keeper] Round ${roundId} started`);
    console.log(
      `[Keeper] Initial price: $${initial.price.toLocaleString()} (${
        initial.source
      })`
    );
    console.log(
      `[Keeper] Grid: ${gridBounds.rows.length} rows × ${gridBounds.columns.length} columns`
    );
    console.log(`[Keeper] Price increment: $${this.market.priceIncrement}`);
    console.log(`[Keeper] Time increment: ${this.market.timeIncrement}s`);
    console.log(`[Keeper] Betting phase: ${this.market.bettingDuration}s`);
    console.log(
      `[Keeper] Live phase: ${
        this.market.roundDuration - this.market.bettingDuration
      }s`
    );
    console.log(`${"=".repeat(50)}\n`);

    const message: RoundStartMessage = {
      type: "ROUND_START",
      payload: {
        marketId: this.market.marketId,
        roundId,
        phase: RoundPhase.BETTING,
        initialPrice: initial.price,
        gridBounds,
        timing: { roundStartTime, bettingEndTime, liveEndTime },
        config: {
          priceIncrement: this.market.priceIncrement,
          timeIncrement: this.market.timeIncrement,
        },
      },
    };
    this.broadcast(message);
    setTimeout(
      () => this.transitionToLive(),
      this.market.bettingDuration * 1000
    );
  }

  private transitionToLive() {
    if (!this.currentRound) return;

    this.currentRound.phase = RoundPhase.LIVE;
    console.log(
      `\n[Keeper] LIVE phase started - polling prices every 1 second\n`
    );

    const message: PhaseChangeMessage = {
      type: "PHASE_CHANGE",
      payload: {
        marketId: this.market.marketId,
        roundId: this.currentRound.roundId,
        phase: RoundPhase.LIVE,
      },
    };
    this.broadcast(message);
    this.pollPrice();
    this.pollInterval = setInterval(() => this.pollPrice(), 1000);
    const liveDuration =
      this.market.roundDuration - this.market.bettingDuration;
    setTimeout(() => this.endRound(), liveDuration * 1000);
  }

  private async pollPrice() {
    if (!this.currentRound || this.currentRound.phase !== RoundPhase.LIVE)
      return;

    try {
      const priceData = await this.priceFetcher.fetchPrice(this.market.asset);

      this.currentRound.priceHistory.push(priceData);
      this.currentRound.currentPrice = priceData.price;

      const hitCells = deriveHitCells(
        this.currentRound.priceHistory,
        this.market
      );

      let gridBounds = this.currentRound.gridBounds;
      if (gridBounds) {
        const buffer = this.market.priceIncrement * 2;
        if (
          priceData.price < gridBounds.minPrice + buffer ||
          priceData.price > gridBounds.maxPrice - buffer
        ) {
          gridBounds = calculateGridBounds(this.market, priceData.price);
          this.currentRound.gridBounds = gridBounds;
          console.log(
            `[Keeper] Grid bounds updated - centered on $${priceData.price.toLocaleString()}`
          );
        }
      }

      const elapsed =
        priceData.timestamp -
        this.currentRound.roundStartTime -
        this.market.bettingDuration;
      console.log(
        `[Keeper] T+${elapsed}s: $${priceData.price.toLocaleString()} | ${
          hitCells.length
        } cells hit`
      );

      const message: PriceUpdateMessage = {
        type: "PRICE_UPDATE",
        payload: {
          marketId: this.market.marketId,
          roundId: this.currentRound.roundId,
          price: priceData.price,
          timestamp: priceData.timestamp,
          source: priceData.source,
          hitCells,
          gridBounds,
        },
      };
      this.broadcast(message);
      this.wsServer.broadcastPriceStream(this.market.marketId, priceData);
    } catch (err) {
      console.error(`[Keeper] Price fetch error:`, err);
    }
  }

  private endRound() {
    if (!this.currentRound) return;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.currentRound.phase = RoundPhase.SETTLING;

    const finalHitCells = deriveHitCells(
      this.currentRound.priceHistory,
      this.market
    );

    console.log(`\n${"=".repeat(50)}`);
    console.log(`[Keeper] Round ${this.currentRound.roundId} ended`);
    console.log(
      `[Keeper] Collected ${this.currentRound.priceHistory.length} price points`
    );
    console.log(`[Keeper] Hit ${finalHitCells.length} cells`);
    console.log(
      `[Keeper] Start price: $${this.currentRound.initialPrice?.toLocaleString()}`
    );
    console.log(
      `[Keeper] End price: $${this.currentRound.currentPrice?.toLocaleString()}`
    );
    console.log(`${"=".repeat(50)}\n`);

    this.printHitCellsSummary(finalHitCells);

    const message: RoundEndMessage = {
      type: "ROUND_END",
      payload: {
        marketId: this.market.marketId,
        roundId: this.currentRound.roundId,
        phase: RoundPhase.SETTLING,
        hitCells: finalHitCells,
        priceHistory: this.currentRound.priceHistory,
        summary: {
          startPrice: this.currentRound.initialPrice,
          endPrice: this.currentRound.currentPrice,
          pricePoints: this.currentRound.priceHistory.length,
          hitCellCount: finalHitCells.length,
        },
      },
    };
    this.broadcast(message);

    const nextRoundId = this.currentRound.roundId + 1;
    console.log(`\n[Keeper] Starting round ${nextRoundId} in 5 seconds...\n`);
    setTimeout(() => this.startRound(nextRoundId), 5000);
  }

  private printHitCellsSummary(hitCells: GridCell[]) {
    if (!this.currentRound?.gridBounds) return;

    const { rows, columns } = this.currentRound.gridBounds;
    const hitSet = new Set(
      hitCells.map((c) => `${c.priceRangeStart}:${c.timeRangeStart}`)
    );

    console.log("\n[Keeper] Grid visualization:");
    console.log(
      "         " + columns.map((_, i) => `Col${i}`.padStart(6)).join("")
    );

    for (const row of rows) {
      const rowLabel = `$${row}`.padStart(8);
      const cells = columns.map((col) => {
        const key = `${row}:${col}`;
        return hitSet.has(key) ? "  [X] " : "  [ ] ";
      });
      console.log(rowLabel + cells.join(""));
    }
    console.log("");
  }

  private broadcast(
    message:
      | RoundStartMessage
      | PhaseChangeMessage
      | PriceUpdateMessage
      | RoundEndMessage
  ) {
    this.wsServer.broadcast(this.market.marketId, message);
  }

  getCurrentRound(): RoundState | null {
    return this.currentRound;
  }

  getMarket(): MarketConfig {
    return this.market;
  }
}
