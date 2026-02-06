import type { MarketConfig, GridBounds } from "./types.js";
import { priceToRowStart } from "./gridDeriver.js";

/**
 * Calculate grid display bounds centered on current price
 */
export function calculateGridBounds(
  market: MarketConfig,
  currentPrice: number,
  visibleRows: number = 14
): GridBounds {
  if (!market.roundStartTime) {
    throw new Error("Round has not started");
  }

  const centerRow = priceToRowStart(currentPrice, market.priceIncrement);
  const halfRows = Math.floor(visibleRows / 2);

  // Shift grid down by one increment so price range starts lower
  // e.g., if centerRow is $63,400, show $63,300-$63,700 instead of $63,400-$63,800
  const minPrice = centerRow - (halfRows + 1) * market.priceIncrement;
  const maxPrice = centerRow + (halfRows - 1) * market.priceIncrement;

  const rows: number[] = [];
  for (let price = maxPrice; price >= minPrice; price -= market.priceIncrement) {
    rows.push(price);
  }

  const liveDuration = market.roundDuration - market.bettingDuration;
  const numColumns = Math.ceil(liveDuration / market.timeIncrement);

 const liveStartTime = market.roundStartTime + market.bettingDuration;
  const columns: number[] = [];
  for (let i = 0; i < numColumns; i++) {
    columns.push(liveStartTime + i * market.timeIncrement);
  }

  return {
    rows,
    columns,
    minPrice,
    maxPrice,
    startTime: liveStartTime,
    endTime: market.roundStartTime + market.roundDuration,
  };
}

export function formatTimeSlotLabel(
  timestamp: number,
  roundStartTime: number,
  timeIncrement: number
): string {
  const elapsed = timestamp - roundStartTime;
  const slotIndex = Math.floor(elapsed / timeIncrement);
  const minutes = Math.floor((slotIndex * timeIncrement) / 60);
  const seconds = (slotIndex * timeIncrement) % 60;

  if (seconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatPriceRowLabel(priceRangeStart: number): string {
  return `$${priceRangeStart.toLocaleString()}`;
}
