import express from "express";
import type { Keeper } from "./keeper.js";
import { deriveHitCells } from "./gridDeriver.js";

export class HttpServer {
  private app: express.Application;
  private keeper: Keeper;

  constructor(port: number, keeper: Keeper) {
    this.app = express();
    this.keeper = keeper;

    this.setupRoutes();
    
    this.app.listen(port, () => {
      console.log(`[HTTP] REST API server started on port ${port}`);
    });
  }

  private setupRoutes() {
    // Health check
    this.app.get("/health", (req, res) => {
      res.json({ status: "ok" });
    });

    // Get current round info
    this.app.get("/api/markets/:marketId/current-round", (req, res) => {
      const marketId = parseInt(req.params.marketId);
      const market = this.keeper.getMarket();
      const currentRound = this.keeper.getCurrentRound();

      if (!currentRound || market.marketId !== marketId) {
        return res.status(404).json({ error: "Round not found" });
      }

      res.json({
        roundId: currentRound.roundId,
        phase: currentRound.phase,
        roundStartTime: currentRound.roundStartTime,
        roundEndTime: currentRound.liveEndTime,
      });
    });

    // Get hit cells for a specific round
    this.app.get("/api/markets/:marketId/rounds/:roundId/hit-cells", (req, res) => {
      const marketId = parseInt(req.params.marketId);
      const roundId = parseInt(req.params.roundId);
      const market = this.keeper.getMarket();
      const currentRound = this.keeper.getCurrentRound();

      // Validate market
      if (market.marketId !== marketId) {
        return res.status(404).json({ error: "Market not found" });
      }

      // Check if this is the current round
      if (!currentRound || currentRound.roundId !== roundId) {
        return res.status(404).json({ 
          error: "Round not found or not current round",
          detail: `Current round is ${currentRound?.roundId}, requested ${roundId}`
        });
      }

      // Derive hit cells from price history
      const hitCells = deriveHitCells(currentRound.priceHistory, market);

      // Convert to broker's expected format
      const response = {
        marketId,
        roundId,
        hitCells: hitCells.map(cell => ({
          timeSlotStart: cell.timeRangeStart.toString(),
          dataRangeStart: cell.priceRangeStart.toString(),
        })),
      };

      console.log(`[HTTP] Served ${hitCells.length} hit cells for market ${marketId}, round ${roundId}`);
      res.json(response);
    });
  }
}