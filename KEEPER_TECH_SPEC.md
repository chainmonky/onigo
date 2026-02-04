# Keeper Service Technical Specification

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Data Structures](#3-data-structures)
4. [Price Fetching](#4-price-fetching)
5. [Grid System](#5-grid-system)
6. [Hit Cell Derivation Algorithm](#6-hit-cell-derivation-algorithm)
7. [Round Lifecycle](#7-round-lifecycle)
8. [WebSocket Protocol](#8-websocket-protocol)
9. [Configuration](#9-configuration)
10. [Running the Keeper](#10-running-the-keeper)

---

## 1. Overview

The Keeper is an off-chain service that powers the continuous prediction market game. It:

- Fetches real-time cryptocurrency prices from external APIs
- Tracks price movements during the LIVE phase of each round
- Derives which grid cells the price has "hit" using an interpolation algorithm
- Broadcasts updates to connected frontends via WebSocket

```
┌─────────────────┐     poll 1/sec      ┌──────────────────┐
│  Price APIs     │ ─────────────────►  │     Keeper       │
│  - Binance      │                     │                  │
│  - Kraken       │                     │  - Track prices  │
│  - CoinGecko    │                     │  - Derive hits   │
└─────────────────┘                     │  - Broadcast     │
                                        └────────┬─────────┘
                                                 │ WebSocket
                    ┌────────────────────────────┼────────────────────────────┐
                    ▼                            ▼                            ▼
              ┌──────────┐                ┌──────────┐                ┌──────────┐
              │ Frontend │                │ Frontend │                │ Frontend │
              │ Client 1 │                │ Client 2 │                │ Client n │
              └──────────┘                └──────────┘                └──────────┘
```

---

## 2. Architecture

### File Structure

```
packages/keeper/src/
├── index.ts           # Entry point, market configuration
├── keeper.ts          # Main Keeper class, round lifecycle
├── priceFetcher.ts    # Price fetching with failover
├── gridDeriver.ts     # Hit cell calculation algorithm
├── gridBounds.ts      # Grid display bounds calculation
├── wsServer.ts        # WebSocket server
├── types.ts           # TypeScript type definitions
└── sources/           # Price source implementations
    ├── index.ts
    ├── binance.ts
    ├── kraken.ts
    └── coingecko.ts
```

### Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| `Keeper` | Orchestrates rounds, manages phase transitions, coordinates price polling |
| `PriceFetcher` | Fetches prices with automatic failover between sources |
| `GridDeriver` | Calculates which cells the price has traversed |
| `GridBounds` | Calculates the visible grid dimensions |
| `WebSocketServer` | Manages client connections and broadcasts messages |

---

## 3. Data Structures

### MarketConfig

Defines the grid structure and round timing for a market.

```typescript
interface MarketConfig {
  marketId: number;        // Unique market identifier
  marketName: string;      // Display name (e.g., "BTC/USDC")
  asset: string;           // Asset symbol (e.g., "BTC")

  // Grid dimensions
  priceIncrement: number;  // Price range per row (e.g., 200 = $200/row)
  timeIncrement: number;   // Seconds per column (e.g., 10 = 10s/column)

  // Round timing
  roundDuration: number;   // Total round time in seconds
  bettingDuration: number; // Betting phase duration in seconds

  // Set dynamically when round starts
  roundStartTime?: number; // Unix timestamp
  initialPrice?: number;   // Price at round start
}
```

### GridCell

Represents a single cell in the prediction grid.

```typescript
interface GridCell {
  priceRangeStart: number;  // Lower price bound (e.g., 78200)
  priceRangeEnd: number;    // Upper price bound (e.g., 78400)
  timeRangeStart: number;   // Start timestamp (Unix seconds)
  timeRangeEnd: number;     // End timestamp (Unix seconds)
}
```

### GridBounds

Defines the visible grid area for display.

```typescript
interface GridBounds {
  rows: number[];      // Price range starts (high to low)
  columns: number[];   // Time range starts (timestamps)
  minPrice: number;    // Lowest visible price
  maxPrice: number;    // Highest visible price
  startTime: number;   // Live phase start timestamp
  endTime: number;     // Live phase end timestamp
}
```

### RoundState

Tracks the current state of a round.

```typescript
interface RoundState {
  marketId: number;
  roundId: number;
  phase: RoundPhase;           // BETTING | LIVE | SETTLING
  roundStartTime: number;      // Unix timestamp
  bettingEndTime: number;      // Unix timestamp
  liveEndTime: number;         // Unix timestamp
  priceHistory: PriceDataPoint[];
  currentPrice: number | null;
  initialPrice: number | null;
  gridBounds: GridBounds | null;
}

enum RoundPhase {
  BETTING = "BETTING",   // Users can place bets
  LIVE = "LIVE",         // Price is being tracked
  SETTLING = "SETTLING"  // Round ended, calculating results
}
```

### PriceDataPoint

A single price observation.

```typescript
interface PriceDataPoint {
  price: number;     // Price in USD (e.g., 78335.14)
  timestamp: number; // Unix timestamp in seconds
  source: string;    // API source name (e.g., "Binance")
}
```

---

## 4. Price Fetching

### Source Priority

The keeper uses multiple price sources with automatic failover:

| Priority | Source | Rate Limit | Auth Required |
|----------|--------|------------|---------------|
| 1 (Primary) | Binance | 6000 req/min | No |
| 2 (Fallback) | Kraken | 1 req/sec | No |
| 3 (Fallback) | CoinGecko | 5-15 req/min | No |

### Failover Logic

```typescript
class PriceFetcher {
  // 1. Try last successful source first (optimization)
  // 2. If fails, try each source in priority order
  // 3. Track failures per source
  // 4. After 3 consecutive failures, reset cached source

  async fetchPrice(asset: string): Promise<PriceDataPoint> {
    // Try cached source with 3s timeout
    if (lastSuccessfulSource) {
      try {
        return await withTimeout(source.fetch(), 3000);
      } catch {
        // Fall through
      }
    }

    // Try all sources with 5s timeout each
    for (const source of sources) {
      try {
        return await withTimeout(source.fetch(), 5000);
      } catch {
        recordFailure(source);
      }
    }

    throw new Error("All price sources failed");
  }
}
```

### API Endpoints

**Binance:**
```
GET https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT
Response: { "symbol": "BTCUSDT", "price": "78335.14000000" }
```

**Kraken:**
```
GET https://api.kraken.com/0/public/Ticker?pair=XBTUSD
Response: { "result": { "XXBTZUSD": { "c": ["78335.1", "0.001"] } } }
```

**CoinGecko:**
```
GET https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd
Response: { "bitcoin": { "usd": 78335.14 } }
```

---

## 5. Grid System

### Coordinate System

The grid is a 2D matrix where:
- **Y-axis (Rows)**: Price ranges, each spanning `priceIncrement` dollars
- **X-axis (Columns)**: Time slots, each spanning `timeIncrement` seconds

```
         Col0     Col1     Col2     Col3     Col4     Col5
         (0-10s)  (10-20s) (20-30s) (30-40s) (40-50s) (50-60s)
        ┌────────┬────────┬────────┬────────┬────────┬────────┐
$78600  │        │        │        │        │        │        │
        ├────────┼────────┼────────┼────────┼────────┼────────┤
$78400  │        │        │        │        │        │        │
        ├────────┼────────┼────────┼────────┼────────┼────────┤
$78200  │  [X]   │  [X]   │  [X]   │  [X]   │  [X]   │  [X]   │  ← Price stayed here
        ├────────┼────────┼────────┼────────┼────────┼────────┤
$78000  │        │        │        │        │        │        │
        └────────┴────────┴────────┴────────┴────────┴────────┘
```

### Price to Row Mapping

Converts a price to its grid row (floor division):

```typescript
function priceToRowStart(price: number, increment: number): number {
  return Math.floor(price / increment) * increment;
}

// Example:
// price = 78335.14, increment = 200
// Math.floor(78335.14 / 200) * 200 = 391 * 200 = 78200
// So price $78,335.14 falls in row [$78,200 - $78,400)
```

### Timestamp to Column Mapping

Converts a timestamp to its grid column:

```typescript
function timestampToColumnStart(
  timestamp: number,
  roundStartTime: number,
  timeIncrement: number
): number {
  const elapsed = timestamp - roundStartTime;
  const columnIndex = Math.floor(elapsed / timeIncrement);
  return roundStartTime + columnIndex * timeIncrement;
}

// Example:
// timestamp = 1704067215, roundStartTime = 1704067200, timeIncrement = 10
// elapsed = 15 seconds
// columnIndex = floor(15 / 10) = 1
// columnStart = 1704067200 + 1 * 10 = 1704067210 (second column)
```

### Grid Bounds Calculation

The visible grid is centered around the current price:

```typescript
function calculateGridBounds(
  market: MarketConfig,
  currentPrice: number,
  visibleRows: number = 10
): GridBounds {
  // Center Y-axis on current price
  const centerRow = priceToRowStart(currentPrice, market.priceIncrement);
  const halfRows = Math.floor(visibleRows / 2);

  const minPrice = centerRow - halfRows * market.priceIncrement;
  const maxPrice = centerRow + halfRows * market.priceIncrement;

  // Rows from high to low (for display)
  const rows = [];
  for (let p = maxPrice; p >= minPrice; p -= market.priceIncrement) {
    rows.push(p);
  }

  // Columns from live start to live end
  const liveDuration = market.roundDuration - market.bettingDuration;
  const numColumns = Math.ceil(liveDuration / market.timeIncrement);
  const liveStartTime = market.roundStartTime + market.bettingDuration;

  const columns = [];
  for (let i = 0; i < numColumns; i++) {
    columns.push(liveStartTime + i * market.timeIncrement);
  }

  return { rows, columns, minPrice, maxPrice, startTime: liveStartTime, endTime };
}
```

---

## 6. Hit Cell Derivation Algorithm

This is the core algorithm that determines which grid cells the price has traversed.

### Key Concept: Interpolation

When the price moves from point A to point B, we mark **all rows** between them as "hit", not just the rows at each data point. This ensures that rapid price movements don't skip cells.

```
Price at T=0: $78,156 → Row $78,000
Price at T=1: $78,342 → Row $78,200

Without interpolation: Only 2 cells hit
With interpolation: 3 cells hit ($78,000, $78,100, $78,200)
```

### Algorithm

```typescript
function deriveHitCells(
  priceHistory: PriceDataPoint[],
  market: MarketConfig
): GridCell[] {
  const hitCells = new Map<string, GridCell>();

  for (let i = 0; i < priceHistory.length; i++) {
    const current = priceHistory[i];
    const colStart = timestampToColumnStart(current.timestamp, ...);

    if (i === 0) {
      // First point: just add its cell
      const rowStart = priceToRowStart(current.price, market.priceIncrement);
      addCell(rowStart, colStart);
    } else {
      // Interpolate between previous and current
      const prev = priceHistory[i - 1];
      const prevColStart = timestampToColumnStart(prev.timestamp, ...);

      // Get ALL rows between previous and current price
      const rowsTraversed = getRowsBetween(
        prev.price,
        current.price,
        market.priceIncrement
      );

      for (const rowStart of rowsTraversed) {
        // If crossed column boundary, add to both columns
        if (colStart !== prevColStart) {
          addCell(rowStart, prevColStart);
        }
        addCell(rowStart, colStart);
      }
    }
  }

  return Array.from(hitCells.values());
}
```

### getRowsBetween Function

Returns all rows that the price line crosses:

```typescript
function getRowsBetween(
  price1: number,
  price2: number,
  increment: number
): number[] {
  const row1 = priceToRowStart(price1, increment);
  const row2 = priceToRowStart(price2, increment);

  const minRow = Math.min(row1, row2);
  const maxRow = Math.max(row1, row2);

  const rows = [];
  for (let row = minRow; row <= maxRow; row += increment) {
    rows.push(row);
  }
  return rows;
}

// Example:
// price1 = 78156, price2 = 78542, increment = 200
// row1 = 78000, row2 = 78400
// Returns: [78000, 78200, 78400]
```

### Visual Example

```
Price Movement: $78,156 → $78,245 → $78,312 → $78,189

Step 1: T=0s, Price=$78,156
  → Row $78,000, Column 0
  → Hit: [(78000, Col0)]

Step 2: T=1s, Price=$78,245
  → Row $78,200, Column 0
  → Rows between: [78000, 78200]
  → Hit: [(78000, Col0), (78200, Col0)]

Step 3: T=2s, Price=$78,312
  → Row $78,200, Column 0
  → Rows between: [78200] (same row)
  → Hit: [(78000, Col0), (78200, Col0)]

Step 4: T=10s, Price=$78,189 (crosses to Column 1)
  → Row $78,000, Column 1
  → Rows between: [78000, 78200]
  → Add to both columns (boundary crossing)
  → Hit: [(78000, Col0), (78200, Col0), (78000, Col1), (78200, Col1)]
```

---

## 7. Round Lifecycle

### Phase Timeline

```
│◄────────── roundDuration (120s) ──────────►│
│                                             │
│◄─── bettingDuration (60s) ───►│◄─ live (60s) ─►│
│                                │              │
├────────────────────────────────┼──────────────┤
│         BETTING                │    LIVE      │ SETTLING
│  - Users select cells          │ - Poll 1/sec │ - Calc results
│  - No price tracking           │ - Derive hits│ - Broadcast end
│  - Grid shown (static)         │ - Broadcast  │
└────────────────────────────────┴──────────────┴─► Next round
```

### State Machine

```
         ┌──────────────────────────────────────────┐
         │                                          │
         ▼                                          │
    ┌─────────┐   bettingDuration    ┌──────┐      │
    │ BETTING │ ──────────────────►  │ LIVE │      │
    └─────────┘      elapsed         └──────┘      │
                                         │         │
                                         │ liveDuration
                                         │ elapsed
                                         ▼         │
                                    ┌──────────┐   │
                                    │ SETTLING │ ──┤ 5s delay
                                    └──────────┘   │
                                         │         │
                                         │ startRound(n+1)
                                         │         │
                                         └─────────┘
```

### Round Start Sequence

```typescript
async startRound(roundId: number) {
  // 1. Fetch initial price
  const initial = await priceFetcher.fetchPrice(asset);

  // 2. Calculate timestamps
  const now = Math.floor(Date.now() / 1000);
  const roundStartTime = now;
  const bettingEndTime = now + bettingDuration;
  const liveEndTime = now + roundDuration;

  // 3. Calculate grid bounds centered on initial price
  const gridBounds = calculateGridBounds(market, initial.price);

  // 4. Initialize round state
  currentRound = {
    phase: BETTING,
    roundStartTime,
    bettingEndTime,
    liveEndTime,
    priceHistory: [],
    currentPrice: initial.price,
    initialPrice: initial.price,
    gridBounds,
  };

  // 5. Broadcast ROUND_START to all clients
  broadcast({ type: "ROUND_START", payload: {...} });

  // 6. Schedule transition to LIVE phase
  setTimeout(() => transitionToLive(), bettingDuration * 1000);
}
```

### Live Phase Polling

```typescript
transitionToLive() {
  currentRound.phase = LIVE;
  broadcast({ type: "PHASE_CHANGE", payload: { phase: LIVE } });

  // Poll price every second
  pollInterval = setInterval(() => pollPrice(), 1000);

  // Schedule round end
  setTimeout(() => endRound(), liveDuration * 1000);
}

async pollPrice() {
  // 1. Fetch current price
  const priceData = await priceFetcher.fetchPrice(asset);

  // 2. Store in history
  currentRound.priceHistory.push(priceData);

  // 3. Derive all hit cells so far
  const hitCells = deriveHitCells(priceHistory, market);

  // 4. Update grid bounds if price near edge
  if (priceNearBoundary) {
    gridBounds = calculateGridBounds(market, priceData.price);
  }

  // 5. Broadcast to all clients
  broadcast({
    type: "PRICE_UPDATE",
    payload: { price, timestamp, hitCells, gridBounds }
  });
}
```

### Round End Sequence

```typescript
endRound() {
  clearInterval(pollInterval);
  currentRound.phase = SETTLING;

  // Calculate final hit cells
  const finalHitCells = deriveHitCells(priceHistory, market);

  // Broadcast final results
  broadcast({
    type: "ROUND_END",
    payload: {
      hitCells: finalHitCells,
      priceHistory,
      summary: {
        startPrice,
        endPrice,
        pricePoints: priceHistory.length,
        hitCellCount: finalHitCells.length
      }
    }
  });

  // Auto-start next round after 5 seconds
  setTimeout(() => startRound(roundId + 1), 5000);
}
```

---

## 8. WebSocket Protocol

### Connection Flow

```
Client                                    Server
  │                                          │
  │─────────── Connect ─────────────────────►│
  │◄────────── CONNECTED ───────────────────│
  │                                          │
  │─────────── SUBSCRIBE {marketId: 1} ────►│
  │◄────────── SUBSCRIBED {marketId: 1} ────│
  │◄────────── ROUND_START {...} ───────────│ (current state)
  │◄────────── PRICE_UPDATE {...} ──────────│ (if LIVE phase)
  │                                          │
  │◄────────── PRICE_UPDATE {...} ──────────│ (every 1s)
  │◄────────── PRICE_UPDATE {...} ──────────│
  │             ...                          │
  │◄────────── ROUND_END {...} ─────────────│
  │                                          │
  │◄────────── ROUND_START {...} ───────────│ (next round)
  │             ...                          │
```

### Message Types

#### Server → Client

**CONNECTED**
```json
{ "type": "CONNECTED" }
```

**SUBSCRIBED**
```json
{ "type": "SUBSCRIBED", "payload": { "marketId": 1 } }
```

**ROUND_START**
```json
{
  "type": "ROUND_START",
  "payload": {
    "marketId": 1,
    "roundId": 1,
    "phase": "BETTING",
    "initialPrice": 78335.14,
    "gridBounds": {
      "rows": [79200, 79000, 78800, 78600, 78400, 78200, 78000, 77800, 77600, 77400, 77200],
      "columns": [1704067260, 1704067270, 1704067280, 1704067290, 1704067300, 1704067310],
      "minPrice": 77200,
      "maxPrice": 79200,
      "startTime": 1704067260,
      "endTime": 1704067320
    },
    "timing": {
      "roundStartTime": 1704067200,
      "bettingEndTime": 1704067260,
      "liveEndTime": 1704067320
    },
    "config": {
      "priceIncrement": 200,
      "timeIncrement": 10
    }
  }
}
```

**PHASE_CHANGE**
```json
{
  "type": "PHASE_CHANGE",
  "payload": {
    "marketId": 1,
    "roundId": 1,
    "phase": "LIVE"
  }
}
```

**PRICE_UPDATE**
```json
{
  "type": "PRICE_UPDATE",
  "payload": {
    "marketId": 1,
    "roundId": 1,
    "price": 78341.63,
    "timestamp": 1704067261,
    "source": "Binance",
    "hitCells": [
      {
        "priceRangeStart": 78200,
        "priceRangeEnd": 78400,
        "timeRangeStart": 1704067260,
        "timeRangeEnd": 1704067270
      }
    ],
    "gridBounds": { ... }
  }
}
```

**ROUND_END**
```json
{
  "type": "ROUND_END",
  "payload": {
    "marketId": 1,
    "roundId": 1,
    "phase": "SETTLING",
    "hitCells": [ ... ],
    "priceHistory": [ ... ],
    "summary": {
      "startPrice": 78335.13,
      "endPrice": 78295.17,
      "pricePoints": 60,
      "hitCellCount": 6
    }
  }
}
```

#### Client → Server

**SUBSCRIBE**
```json
{ "type": "SUBSCRIBE", "payload": { "marketId": 1 } }
```

**UNSUBSCRIBE**
```json
{ "type": "UNSUBSCRIBE", "payload": { "marketId": 1 } }
```

### Late Join Handling

When a client subscribes mid-round, the server immediately sends:
1. `ROUND_START` with current phase and timing
2. If in LIVE phase: `PRICE_UPDATE` with current hit cells

---

## 9. Configuration

### Default Market Configurations

**BTC/USDC Market:**
```typescript
{
  marketId: 1,
  marketName: "BTC/USDC",
  asset: "BTC",
  priceIncrement: 200,    // $200 per row
  timeIncrement: 10,      // 10 seconds per column
  roundDuration: 120,     // 2 minutes total
  bettingDuration: 60,    // 1 minute betting
}
// Results in: 11 rows × 6 columns grid
// Live phase: 60 seconds (6 columns × 10s)
```

**ETH/USDC Market:**
```typescript
{
  marketId: 2,
  marketName: "ETH/USDC",
  asset: "ETH",
  priceIncrement: 20,     // $20 per row
  timeIncrement: 10,      // 10 seconds per column
  roundDuration: 120,     // 2 minutes total
  bettingDuration: 60,    // 1 minute betting
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `3001` | WebSocket server port |

---

## 10. Running the Keeper

### Start Commands

```bash
# Start with BTC market (default)
yarn keeper

# Start with ETH market
yarn keeper eth
```

### Expected Output

```
==================================================
Onigo Keeper - No Signup Required!
==================================================

Price Sources:
  1. Binance (primary) - No signup, 6000 req/min
  2. Kraken (fallback) - No signup, 1 req/sec
  3. CoinGecko (fallback) - No signup, 5-15 req/min

[WS] Server started on port 3001
Selected market: BTC/USDC

Testing price fetch...
[Price] BTC = $78,335.14 from Binance
BTC price: $78,335.14 from Binance

==================================================
[Keeper] Round 1 started
[Keeper] Initial price: $78,335.13 (Binance)
[Keeper] Grid: 11 rows × 6 columns
[Keeper] Price increment: $200
[Keeper] Time increment: 10s
[Keeper] Betting phase: 60s
[Keeper] Live phase: 60s
==================================================

WebSocket server running on ws://localhost:3001
Connect your frontend to receive updates!

Press Ctrl+C to stop

[Keeper] LIVE phase started - polling prices every 1 second

[Keeper] T+0s: $78,336.62 | 1 cells hit
[Keeper] T+1s: $78,341.63 | 1 cells hit
...
[Keeper] T+59s: $78,295.17 | 6 cells hit

==================================================
[Keeper] Round 1 ended
[Keeper] Collected 60 price points
[Keeper] Hit 6 cells
[Keeper] Start price: $78,335.13
[Keeper] End price: $78,295.17
==================================================

[Keeper] Grid visualization:
           Col0  Col1  Col2  Col3  Col4  Col5
  $79200  [ ]   [ ]   [ ]   [ ]   [ ]   [ ]
  $79000  [ ]   [ ]   [ ]   [ ]   [ ]   [ ]
  $78800  [ ]   [ ]   [ ]   [ ]   [ ]   [ ]
  $78600  [ ]   [ ]   [ ]   [ ]   [ ]   [ ]
  $78400  [ ]   [ ]   [ ]   [ ]   [ ]   [ ]
  $78200  [X]   [X]   [X]   [X]   [X]   [X]
  $78000  [ ]   [ ]   [ ]   [ ]   [ ]   [ ]
  ...

[Keeper] Starting round 2 in 5 seconds...
```

---

## Appendix: Formula Reference

| Calculation | Formula |
|-------------|---------|
| Price → Row | `Math.floor(price / priceIncrement) * priceIncrement` |
| Timestamp → Column Index | `Math.floor((timestamp - roundStartTime) / timeIncrement)` |
| Timestamp → Column Start | `roundStartTime + columnIndex * timeIncrement` |
| Number of Columns | `Math.ceil(liveDuration / timeIncrement)` |
| Live Duration | `roundDuration - bettingDuration` |
| Grid Center Row | `priceToRowStart(currentPrice, priceIncrement)` |
| Visible Row Range | `[centerRow - halfRows * increment, centerRow + halfRows * increment]` |
