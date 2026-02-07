export interface PriceDataPoint {
  price: number; // e.g., 105234.56
  timestamp: number; // Unix timestamp in seconds
  source: string; // Which API provided this
}

export interface PriceSource {
  name: string;
  fetchPrice(asset: string): Promise<number>;
}
export interface MarketConfig {
  marketId: number;
  marketName: string;
  asset: string; // "BTC", "ETH"
  priceIncrement: number; // e.g., 500 for $500 per row
  timeIncrement: number; // e.g., 30 for 30 seconds per column
  roundDuration: number; // Total round time in seconds
  bettingDuration: number; // Betting phase duration
  roundStartTime?: number;
  initialPrice?: number;
  marketStartTime?: number; 
  roundLength?: number;
}

export interface GridCell {
  priceRangeStart: number;
  priceRangeEnd: number;
  timeRangeStart: number;
  timeRangeEnd: number;
}

export interface GridCellKey {
  row: number; // priceRangeStart
  col: number; // timeRangeStart (timestamp)
}


export enum RoundPhase {
  BETTING = "BETTING",
  LIVE = "LIVE",
  SETTLING = "SETTLING",
}


export interface GridBounds {
  rows: number[]; // Price range starts (high to low for display)
  columns: number[]; // Time range starts (timestamps)
  minPrice: number;
  maxPrice: number;
  startTime: number;
  endTime: number;
}

export interface RoundState {
  marketId: number;
  roundId: number;
  phase: RoundPhase;
  roundStartTime: number;
  bettingEndTime: number;
  liveEndTime: number;
  priceHistory: PriceDataPoint[];
  currentPrice: number | null;
  initialPrice: number | null;
  gridBounds: GridBounds | null;
}

export type WebSocketMessage =
  | RoundStartMessage
  | PhaseChangeMessage
  | PriceUpdateMessage
  | RoundEndMessage
  | ConnectedMessage
  | SubscribedMessage;

export interface RoundStartMessage {
  type: "ROUND_START";
  payload: {
    marketId: number;
    roundId: number;
    phase: RoundPhase;
    initialPrice: number;
    gridBounds: GridBounds;
    timing: {
      roundStartTime: number;
      bettingEndTime: number;
      liveEndTime: number;
    };
    config: {
      priceIncrement: number;
      timeIncrement: number;
    };
  };
}

export interface PhaseChangeMessage {
  type: "PHASE_CHANGE";
  payload: {
    marketId: number;
    roundId: number;
    phase: RoundPhase;
  };
}

export interface PriceUpdateMessage {
  type: "PRICE_UPDATE";
  payload: {
    marketId: number;
    roundId: number;
    price: number;
    timestamp: number;
    source: string;
    hitCells: GridCell[];
    gridBounds: GridBounds | null;
  };
}

export interface RoundEndMessage {
  type: "ROUND_END";
  payload: {
    marketId: number;
    roundId: number;
    phase: RoundPhase;
    hitCells: GridCell[];
    priceHistory: PriceDataPoint[];
    summary: {
      startPrice: number | null;
      endPrice: number | null;
      pricePoints: number;
      hitCellCount: number;
    };
  };
}

export interface ConnectedMessage {
  type: "CONNECTED";
}

export interface SubscribedMessage {
  type: "SUBSCRIBED";
  payload: { marketId: number };
}

export interface SubscribeMessage {
  type: "SUBSCRIBE";
  payload: { marketId: number };
}

export interface UnsubscribeMessage {
  type: "UNSUBSCRIBE";
  payload: { marketId: number };
}
