"use client";

import { motion } from "framer-motion";
import { BET_AMOUNTS } from "~~/lib/game/constants";
import { cn } from "~~/lib/utils";
import { useGameStore } from "~~/store/gameStore";

export function BetAmountSelector() {
  const { selectedBetAmount, setSelectedBetAmount, currentRound, pendingBets, clearPendingBets, confirmBets } =
    useGameStore();

  const isBettingPhase = currentRound?.phase === "BETTING";
  const hasPendingBets = pendingBets.size > 0;

  return (
    <motion.div
      className="card bg-base-100 shadow-lg"
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
    >
      <div className="card-body p-4">
        <h3 className="text-sm font-medium text-base-content/60 mb-3">Bet Amount</h3>

        {/* Amount selector buttons */}
        <div className="flex gap-2">
          {BET_AMOUNTS.map(amount => (
            <button
              key={amount}
              className={cn(
                "btn btn-sm flex-1",
                selectedBetAmount === amount ? "btn-primary" : "btn-outline btn-primary",
                !isBettingPhase && "btn-disabled opacity-50",
              )}
              onClick={() => setSelectedBetAmount(amount)}
              disabled={!isBettingPhase}
            >
              ${amount}
            </button>
          ))}
        </div>
        <div className="mt-3 text-center">
          <span className="text-xs text-base-content/60">Per cell: </span>
          <span className="text-lg font-bold text-primary">${selectedBetAmount}</span>
        </div>

        {/* Action buttons */}
        <div className="mt-4 flex gap-2">
          <button
            className={cn("btn btn-outline btn-sm flex-1", !hasPendingBets && "btn-disabled")}
            onClick={clearPendingBets}
            disabled={!hasPendingBets || !isBettingPhase}
          >
            Clear
          </button>
          <button
            className={cn("btn btn-primary btn-sm flex-1", !hasPendingBets && "btn-disabled")}
            onClick={confirmBets}
            disabled={!hasPendingBets || !isBettingPhase}
          >
            {hasPendingBets ? `Confirm (${pendingBets.size})` : "Select cells"}
          </button>
        </div>
        {isBettingPhase && (
          <p className="text-xs text-base-content/50 text-center mt-2">Click cells on the grid to place bets</p>
        )}
        {!isBettingPhase && currentRound && (
          <p className="text-xs text-warning text-center mt-2">Betting is closed for this round</p>
        )}
      </div>
    </motion.div>
  );
}
