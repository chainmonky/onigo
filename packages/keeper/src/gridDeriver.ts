import type { MarketConfig, PriceDataPoint, GridCell } from "./types.js";

/**
 * Convert price to row start (floor to increment)
 * Example: price 105234, increment 500 → 105000
 */
export function priceToRowStart(price: number, increment: number): number {
  return Math.floor(price / increment) * increment;
}


export function timestampToColumnStart(
  timestamp: number,
  roundStartTime: number,
  timeIncrement: number
): number {
  const elapsed = timestamp - roundStartTime;
  const columnIndex = Math.floor(elapsed / timeIncrement);
  return roundStartTime + columnIndex * timeIncrement;
}

export function timestampToColumnIndex(
  timestamp: number,
  roundStartTime: number,
  timeIncrement: number
): number {
  const elapsed = timestamp - roundStartTime;
  return Math.floor(elapsed / timeIncrement);
}


export function priceToRowIndex(
  price: number,
  basePrice: number,
  priceIncrement: number
): number {
  return Math.floor((price - basePrice) / priceIncrement);
}

/**
 * Get all rows between two prices (for interpolation when price jumps)
 */
function getRowsBetween(
  price1: number,
  price2: number,
  increment: number
): number[] {
  const row1 = priceToRowStart(price1, increment);
  const row2 = priceToRowStart(price2, increment);

  const minRow = Math.min(row1, row2);
  const maxRow = Math.max(row1, row2);

  const rows: number[] = [];
  for (let row = minRow; row <= maxRow; row += increment) {
    rows.push(row);
  }
  return rows;
}

/**
 * Main function: Derive all hit cells from raw price history
 * This is the core algorithm that determines which grid cells the price has traversed
 */
export function deriveHitCells(
  priceHistory: PriceDataPoint[],
  market: MarketConfig
): GridCell[] {
  if (priceHistory.length === 0 || !market.roundStartTime) {
    return [];
  }

  const hitCells = new Map<string, GridCell>();
  const cellKey = (row: number, col: number) => `${row}:${col}`;

  const addCell = (rowStart: number, colStart: number) => {
    const key = cellKey(rowStart, colStart);
    if (!hitCells.has(key)) {
      hitCells.set(key, {
        priceRangeStart: rowStart,
        priceRangeEnd: rowStart + market.priceIncrement,
        timeRangeStart: colStart,
        timeRangeEnd: colStart + market.timeIncrement,
      });
    }
  };

  for (let i = 0; i < priceHistory.length; i++) {
    const current = priceHistory[i];
    if (current.timestamp < market.roundStartTime) continue;

    const colStart = timestampToColumnStart(
      current.timestamp,
      market.roundStartTime,
      market.timeIncrement
    );

    if (i === 0) {
      const rowStart = priceToRowStart(current.price, market.priceIncrement);
      addCell(rowStart, colStart);
    } else {
      const prev = priceHistory[i - 1];
      const prevColStart = timestampToColumnStart(
        prev.timestamp,
        market.roundStartTime,
        market.timeIncrement
      );

      const rowsTraversed = getRowsBetween(
        prev.price,
        current.price,
        market.priceIncrement
      );

      for (const rowStart of rowsTraversed) {
        if (
          colStart !== prevColStart &&
          prev.timestamp >= market.roundStartTime
        ) {
          addCell(rowStart, prevColStart);
        }
        addCell(rowStart, colStart);
      }
    }
  }

  return Array.from(hitCells.values());
}


export function hitCellsToSet(cells: GridCell[]): Set<string> {
  return new Set(
    cells.map((c) => `${c.priceRangeStart}:${c.timeRangeStart}`)
  );
}


export function isCellHit(
  cells: GridCell[],
  priceRangeStart: number,
  timeRangeStart: number
): boolean {
  return cells.some(
    (c) =>
      c.priceRangeStart === priceRangeStart &&
      c.timeRangeStart === timeRangeStart
  );
}
