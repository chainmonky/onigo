/**
 * Game Types - Based on Keeper WebSocket Protocol
 */

// ============================================================================
// Keeper Protocol Types
// ============================================================================

export type RoundPhase = "BETTING" | "LIVE" | "SETTLING";

export type GridCell = {
  priceRangeStart: number;
  priceRangeEnd: number;
  timeRangeStart: number;
  timeRangeEnd: number;
};

export type GridBounds = {
  rows: number[]; // Price range starts (high to low)
  columns: number[]; // Time range starts (timestamps)
  minPrice: number;
  maxPrice: number;
  startTime: number;
  endTime: number;
};

export type RoundTiming = {
  roundStartTime: number;
  bettingEndTime: number;
  liveEndTime: number;
};

export type MarketConfig = {
  priceIncrement: number;
  timeIncrement: number;
};

export type PriceDataPoint = {
  price: number;
  timestamp: number;
  source: string;
};

// ============================================================================
// Keeper Message Payloads
// ============================================================================

export type KeeperRoundStartPayload = {
  marketId: number;
  roundId: number;
  phase: RoundPhase;
  initialPrice: number;
  gridBounds: GridBounds;
  timing: RoundTiming;
  config: MarketConfig;
};

export type KeeperPhaseChangePayload = {
  marketId: number;
  roundId: number;
  phase: RoundPhase;
};

export type KeeperPriceUpdatePayload = {
  marketId: number;
  roundId: number;
  price: number;
  timestamp: number;
  source: string;
  hitCells: GridCell[];
  gridBounds: GridBounds | null;
};

export type KeeperRoundEndPayload = {
  marketId: number;
  roundId: number;
  phase: "SETTLING";
  hitCells: GridCell[];
  priceHistory: PriceDataPoint[];
  summary: {
    startPrice: number | null;
    endPrice: number | null;
    pricePoints: number;
    hitCellCount: number;
  };
};

// ============================================================================
// Keeper Messages
// ============================================================================

// Price stream payload - lightweight price-only updates for chart/ticker use
// Use SUBSCRIBE_PRICE_STREAM to receive these via usePriceStream hook
export type PriceTickPayload = {
  marketId: number;
  price: number;
  timestamp: number;
  source: string;
};

/**
 * KeeperMessage - All WebSocket message types from the keeper service
 *
 * - PRICE_UPDATE: Full update with price, hitCells, and gridBounds (use with useKeeperWebSocket)
 * - PRICE_TICK: Lightweight price-only update (use with usePriceStream for standalone charts)
 */
export type KeeperMessage =
  | { type: "CONNECTED" }
  | { type: "SUBSCRIBED"; payload: { marketId: number } }
  | { type: "PRICE_STREAM_SUBSCRIBED"; payload: { marketId: number } }
  | { type: "ROUND_START"; payload: KeeperRoundStartPayload }
  | { type: "PHASE_CHANGE"; payload: KeeperPhaseChangePayload }
  | { type: "PRICE_UPDATE"; payload: KeeperPriceUpdatePayload }
  | { type: "PRICE_TICK"; payload: PriceTickPayload }
  | { type: "ROUND_END"; payload: KeeperRoundEndPayload };

// ============================================================================
// Game State Types
// ============================================================================

export type BetCell = {
  timeSlotStart: number;
  dataRangeStart: number;
};

export type Bet = {
  id: string;
  cells: BetCell[];
  amount: number;
  placedAt: number;
  roundId: number;
  marketId: number;
};

export type RoundState = {
  marketId: number;
  roundId: number;
  phase: RoundPhase;
  initialPrice: number;
  currentPrice: number | null;
  gridBounds: GridBounds;
  config: MarketConfig;
  timing: RoundTiming;
  hitCells: GridCell[];
  priceHistory: PriceDataPoint[];
};

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
