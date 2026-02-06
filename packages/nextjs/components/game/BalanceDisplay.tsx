"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useGameStore } from "~~/store/gameStore";

export function BalanceDisplay() {
  const { balance, getTotalPendingBetAmount, pendingBets } = useGameStore();

  const pendingAmount = getTotalPendingBetAmount();
  const availableBalance = balance - pendingAmount;

  return (
    <motion.div
      className="card bg-base-100 shadow-lg"
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
    >
      <div className="card-body p-4">
        <h3 className="text-sm font-medium text-base-content/60 mb-2">Your Balance</h3>

        {/* Main balance */}
        <div className="flex items-baseline gap-1">
          <AnimatePresence mode="wait">
            <motion.span
              key={balance}
              className="text-3xl font-bold text-base-content"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
            >
              ${balance.toFixed(2)}
            </motion.span>
          </AnimatePresence>
          <span className="text-sm text-base-content/60">USDC</span>
        </div>

        {/* Pending bets indicator */}
        <AnimatePresence>
          {pendingAmount > 0 && (
            <motion.div
              className="mt-2 pt-2 border-t border-base-200"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
            >
              <div className="flex justify-between text-sm">
                <span className="text-base-content/60">Pending bets:</span>
                <span className="text-warning font-medium">-${pendingAmount.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm mt-1">
                <span className="text-base-content/60">Cells selected:</span>
                <span className="text-primary font-medium">{pendingBets.size}</span>
              </div>
              <div className="flex justify-between text-sm mt-1 pt-1 border-t border-base-200">
                <span className="text-base-content/60">Available:</span>
                <span className="font-bold text-success">${availableBalance.toFixed(2)}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Wallet icon */}
        <div className="absolute top-4 right-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 text-primary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
            />
          </svg>
        </div>
      </div>
    </motion.div>
  );
}
