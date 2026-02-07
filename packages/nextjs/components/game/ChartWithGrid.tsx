"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GridCell } from "./GridCell";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { GRID_CONFIG } from "~~/lib/game/constants";
import { useGameStore } from "~~/store/gameStore";

type PriceDataPoint = {
  time: number;
  price: number;
};

async function fetchHistoricalData(
  symbol: string,
  interval: string = "1s",
  limit: number = 120,
): Promise<PriceDataPoint[]> {
  try {
    const response = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    );
    const data = await response.json();

    return data.map((kline: any[]) => ({
      time: Math.floor(kline[0] / 1000),
      price: parseFloat(kline[4]),
    }));
  } catch (error) {
    console.error("Error fetching historical data:", error);
    return [];
  }
}

export function ChartWithGrid() {
  const { currentRound, marketId } = useGameStore();
  const [historicalData, setHistoricalData] = useState<PriceDataPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const gridBounds = currentRound?.gridBounds;
  const config = currentRound?.config;
  const currentPrice = currentRound?.currentPrice;
  const phase = currentRound?.phase;

  const symbol = marketId === 1 ? "BTCUSDT" : "ETHUSDT";
  const visibleRows = useMemo(() => {
    if (!gridBounds) return [];
    return gridBounds.rows.slice(0, GRID_CONFIG.MAX_VISIBLE_ROWS - 1);
  }, [gridBounds]);

  const visibleCols = useMemo(() => {
    if (!gridBounds) return [];
    return gridBounds.columns.slice(0, GRID_CONFIG.MAX_VISIBLE_COLS);
  }, [gridBounds]);

  const cellHeight = GRID_CONFIG.CELL_HEIGHT;
  const cellWidth = GRID_CONFIG.CELL_WIDTH;
  const gridHeight = visibleRows.length * cellHeight;

  // Load historical data
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      const data = await fetchHistoricalData(symbol, "1s", 120);
      setHistoricalData(data);
      setIsLoading(false);
    };

    loadData();

    // Refresh data periodically
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, [symbol]);

  // Update with real-time price during LIVE phase
  useEffect(() => {
    if (!currentPrice || phase !== "LIVE") return;

    const now = Math.floor(Date.now() / 1000);
    setHistoricalData(prev => {
      // Add new point or update last point
      const lastPoint = prev[prev.length - 1];
      if (lastPoint && now - lastPoint.time < 2) {
        // Update last point
        return [...prev.slice(0, -1), { time: now, price: currentPrice }];
      }
      // Add new point
      return [...prev.slice(-119), { time: now, price: currentPrice }];
    });
  }, [currentPrice, phase]);

  // Calculate Y-axis domain based on grid bounds (shifted by one increment to align with grid)
  const yDomain = useMemo(() => {
    if (!gridBounds || !config) return [0, 100000];
    // Shift domain by one increment to match grid's right-side labels
    return [gridBounds.minPrice + config.priceIncrement, gridBounds.maxPrice + config.priceIncrement];
  }, [gridBounds, config]);

  // Y-axis ticks matching grid row END prices (to align with right-side labels)
  const yAxisTicks = useMemo(() => {
    if (!visibleRows.length || !config) return undefined;
    // Add priceIncrement to match the grid's right-side labels
    return visibleRows.map(price => price + config.priceIncrement);
  }, [visibleRows, config]);

  // Format price for Y-axis
  const formatPrice = useCallback((price: number) => {
    if (price >= 1000) {
      return `$${(price / 1000).toFixed(1)}k`;
    }
    return `$${price.toLocaleString()}`;
  }, []);

  // Format time for X-axis
  const formatTime = useCallback((timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }, []);

  // Format time for column headers (grid)
  const formatGridTime = useCallback((timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }, []);

  // Calculate which row the current price is in
  // const currentPriceRowIndex = useMemo(() => {
  //   if (!currentPrice || !visibleRows.length || !config) return -1;
  //   for (let i = 0; i < visibleRows.length; i++) {
  //     const rowStart = visibleRows[i];
  //     const rowEnd = rowStart + config.priceIncrement;
  //     if (currentPrice >= rowStart && currentPrice < rowEnd) {
  //       return i;
  //     }
  //   }
  //   return -1;
  // }, [currentPrice, visibleRows, config]);

  if (!gridBounds || !config) {
    return (
      <div className="flex items-center justify-center h-[500px]">
        <div className="text-center">
          <div className="loading loading-spinner loading-lg text-primary"></div>
          <p className="mt-4 text-base-content/60">Waiting for round to start...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      <div className="flex items-start">
        <div className="shrink-0 relative" style={{ width: 500, maxWidth: 800, height: gridHeight }}>
          {isLoading && historicalData.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center bg-base-200/50">
              <div className="loading loading-spinner loading-sm text-primary"></div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={historicalData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                {/* Grid lines */}
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(32, 227, 178, 0.2)"
                  horizontal={true}
                  vertical={true}
                />

                {/* X-axis: hidden since we show grid times */}
                <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} hide={true} />

                {/* Y-axis: Price - aligned with grid rows */}
                <YAxis
                  domain={yDomain}
                  ticks={yAxisTicks}
                  tickFormatter={formatPrice}
                  stroke="rgba(32, 227, 178, 0.6)"
                  fontSize={10}
                  tick={{ fill: "rgba(32, 227, 178, 0.8)" }}
                  width={55}
                  axisLine={{ stroke: "rgba(32, 227, 178, 0.4)" }}
                  tickLine={{ stroke: "rgba(32, 227, 178, 0.3)" }}
                  interval={0}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1f2937",
                    border: "1px solid #374151",
                    borderRadius: "8px",
                    color: "#fff",
                    fontSize: "12px",
                  }}
                  formatter={(value: number) => [`$${value.toLocaleString()}`, "Price"]}
                  labelFormatter={(label: number) => formatTime(label)}
                />
                {visibleRows.map(price => (
                  <ReferenceLine
                    key={`price-${price}`}
                    y={price + (config?.priceIncrement ?? 0)}
                    stroke="rgba(32, 227, 178, 0.25)"
                    strokeDasharray="2 2"
                  />
                ))}

                {currentPrice && (
                  <ReferenceLine y={currentPrice} stroke="#20E3B2" strokeDasharray="4 4" strokeWidth={1} />
                )}

                {/* Price line - trading style */}
                <Line
                  type="monotone"
                  dataKey="price"
                  stroke="#20E3B2"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{
                    r: 4,
                    fill: "#20E3B2",
                    stroke: "#fff",
                    strokeWidth: 2,
                  }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="flex flex-col">
          <div className="flex flex-col">
            {visibleRows.map((priceStart, rowIndex) => (
              <div key={priceStart} className="flex relative">
                {visibleCols.map((timestamp, colIndex) => (
                  <GridCell
                    key={`${priceStart}-${timestamp}`}
                    priceRangeStart={priceStart}
                    timeSlotStart={timestamp}
                    rowIndex={rowIndex}
                    colIndex={colIndex}
                  />
                ))}
              </div>
            ))}
          </div>

          <div className="flex" style={{ height: cellHeight }}>
            {visibleCols.map(timestamp => (
              <div
                key={`bottom-${timestamp}`}
                className="flex items-center justify-center text-xs text-base-content/60"
                style={{ width: cellWidth }}
              >
                {formatGridTime(timestamp)}
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col shrink-0">
          {visibleRows.map(priceStart => (
            <div
              key={priceStart}
              className="flex items-start justify-start pl-2 text-xs text-teal-600/60"
              style={{ height: cellHeight }}
            >
              {formatPrice(priceStart + config.priceIncrement)}
            </div>
          ))}
          <div style={{ height: cellHeight }} />
        </div>
      </div>
    </div>
  );
}
