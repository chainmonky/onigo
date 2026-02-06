"use client";

import { motion } from "framer-motion";
import { BalanceDisplay, BetAmountSelector, ChartWithGrid, CyberpunkNavbar, GameToasts } from "~~/components/game";
import { useKeeperWebSocket } from "~~/hooks/useKeeperWebSocket";
import { useGameStore } from "~~/store/gameStore";

export function PriceGridGame() {
  const { currentRound } = useGameStore();

  useKeeperWebSocket();

  return (
    <div className="min-h-screen bg-base-200">
      {/* Toast notifications */}
      <GameToasts />

      {/* Cyberpunk Navbar with Timer */}
      <CyberpunkNavbar />

      {/* Main content */}
      <main className="w-full px-4 py-4">
        <div className="w-full flex flex-col gap-4">
          {/* Main - Unified Chart + Grid */}
          <motion.section className="!w-full" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <div className="card bg-base-100 shadow-lg">
              <div className="card-body p-4">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-4">
                    <h2 className="card-title text-lg">Price Prediction</h2>
                    {currentRound?.currentPrice && (
                      <div className="badge badge-primary font-mono">${currentRound.currentPrice.toLocaleString()}</div>
                    )}
                  </div>
                  {currentRound?.phase === "BETTING" && (
                    <div className="badge badge-primary badge-outline animate-pulse">Click cells to bet</div>
                  )}
                  {currentRound?.phase === "LIVE" && (
                    <div className="badge badge-success badge-outline">Watching price...</div>
                  )}
                  {currentRound?.phase === "SETTLING" && (
                    <div className="badge badge-warning badge-outline">Settling...</div>
                  )}
                </div>

                {/* Unified Chart + Grid */}
                <ChartWithGrid />

                {/* Legend */}
                <div className="mt-4 pt-4 border-t border-base-200">
                  <div className="flex flex-wrap gap-4 text-xs text-base-content/60">
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 bg-base-100 border border-base-300 rounded" />
                      <span>Available</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 bg-primary rounded" />
                      <span>Your Bet</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 bg-success/30 border border-success rounded" />
                      <span>Price Hit</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 bg-success rounded" />
                      <span>Win!</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-3 bg-primary rounded-sm" />
                      <span>Price Line</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.section>

          {/* Right sidebar - Controls */}
          <motion.aside
            className="w-full flex flex-col xl:flex-row gap-4"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
          >
            <BalanceDisplay />
            <BetAmountSelector />

            {/* Market info card */}
            {currentRound && (
              <motion.div
                className="card bg-base-100 shadow-lg"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
              >
                <div className="card-body p-4">
                  <h3 className="text-sm font-medium text-base-content/60 mb-2">Market Info</h3>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-base-content/60">Price Step:</span>
                      <span className="font-mono">${currentRound.config.priceIncrement}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-base-content/60">Time Step:</span>
                      <span className="font-mono">{currentRound.config.timeIncrement}s</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-base-content/60">Initial Price:</span>
                      <span className="font-mono text-primary">${currentRound.initialPrice.toLocaleString()}</span>
                    </div>
                    {currentRound.hitCells.length > 0 && (
                      <div className="flex justify-between pt-1 border-t border-base-200">
                        <span className="text-base-content/60">Cells Hit:</span>
                        <span className="font-mono text-success">{currentRound.hitCells.length}</span>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </motion.aside>
        </div>
      </main>
    </div>
  );
}
