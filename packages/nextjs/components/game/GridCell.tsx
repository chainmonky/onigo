"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { BetCell } from "~~/lib/game/types";
import { cn } from "~~/lib/utils";
import { useGameStore } from "~~/store/gameStore";

type GridCellProps = {
  priceRangeStart: number;
  timeSlotStart: number;
  rowIndex: number;
  colIndex: number;
};

export function GridCell({ priceRangeStart, timeSlotStart, rowIndex, colIndex }: GridCellProps) {
  const { currentRound, selectedBetAmount, toggleCellBet, isCellSelected, isCellHit } = useGameStore();

  const cell: BetCell = {
    dataRangeStart: priceRangeStart,
    timeSlotStart: timeSlotStart,
  };

  const isSelected = isCellSelected(cell);
  const isHit = isCellHit(cell);
  const isBettingPhase = currentRound?.phase === "BETTING";
  const isLivePhase = currentRound?.phase === "LIVE";
  const isWinning = isHit && isSelected && isLivePhase;

  const handleClick = () => {
    if (!isBettingPhase) return;
    toggleCellBet(cell);
  };
  const config = currentRound?.config;
  const gridBounds = currentRound?.gridBounds;
  let multiplier = 1.5;

  if (config && gridBounds && currentRound?.currentPrice) {
    const centerRowIndex = Math.floor(gridBounds.rows.length / 2);
    const distanceFromCenter = Math.abs(rowIndex - centerRowIndex);
    const timeMultiplier = 1 + colIndex * 0.1;
    multiplier = 1.5 + distanceFromCenter * 0.5 + timeMultiplier * 0.2;
    multiplier = Math.round(multiplier * 100) / 100;
  }

  return (
    <motion.button
      className={cn(
        "relative flex flex-col items-center justify-center overflow-visible",
        "border border-[rgba(32,227,178,0.3)] transition-all duration-150",
        "min-h-[50px] min-w-[70px]",
        !isSelected && !isHit && "bg-base-100 hover:bg-base-200",
        isSelected && !isHit && "bg-primary text-primary-content shadow-lg",
        isHit && !isSelected && "bg-success/30 border-success",
        isHit &&
          isSelected &&
          "bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow-2xl border-yellow-400 border-2",
        isBettingPhase && "cursor-pointer hover:scale-[1.02]",
        !isBettingPhase && "cursor-default",
      )}
      onClick={handleClick}
      disabled={!isBettingPhase}
      whileHover={isBettingPhase ? { scale: 1.02 } : undefined}
      whileTap={isBettingPhase ? { scale: 0.98 } : undefined}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={
        isWinning
          ? {
              opacity: 1,
              scale: [1, 1.08, 1],
              boxShadow: [
                "0 0 0 0 rgba(32, 227, 178, 0)",
                "0 0 20px 10px rgba(32, 227, 178, 0.6)",
                "0 0 0 0 rgba(32, 227, 178, 0)",
              ],
            }
          : { opacity: 1, scale: 1 }
      }
      transition={
        isWinning
          ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" }
          : { duration: 0.15, delay: rowIndex * 0.02 + colIndex * 0.01 }
      }
    >
      <AnimatePresence>
        {isWinning && (
          <motion.div
            className="absolute inset-0 bg-gradient-to-br from-yellow-200/30 to-emerald-300/30 rounded"
            animate={{ opacity: [0.3, 0.6, 0.3] }}
            transition={{ duration: 0.8, repeat: Infinity }}
          />
        )}
      </AnimatePresence>
      {!isSelected && (
        <span className={cn("text-xs font-mono z-10", isHit ? "text-success font-semibold" : "text-base-content/60")}>
          {multiplier.toFixed(2)}x
        </span>
      )}

      {isSelected && (
        <motion.div
          className="flex flex-col items-center z-10"
          initial={{ scale: 0 }}
          animate={isWinning ? { scale: [1, 1.1, 1] } : { scale: 1 }}
          transition={isWinning ? { duration: 0.6, repeat: Infinity } : { type: "spring", stiffness: 500, damping: 30 }}
        >
          <span className={cn("text-sm font-bold", isWinning && "text-yellow-100")}>${selectedBetAmount}</span>
          <span className={cn("text-xs", isWinning ? "text-yellow-200" : "opacity-80")}>{multiplier.toFixed(2)}x</span>
        </motion.div>
      )}

      {isHit && isLivePhase && !isSelected && (
        <motion.div
          className="absolute top-1 right-1 w-2 h-2 rounded-full bg-success"
          initial={{ scale: 0 }}
          animate={{ scale: [1, 1.2, 1] }}
          transition={{ duration: 0.5, repeat: Infinity }}
        />
      )}

      <AnimatePresence>
        {isWinning && (
          <motion.div
            className="absolute -top-3 -right-3 px-2 py-1 bg-gradient-to-r from-yellow-400 to-amber-500 text-black text-xs font-black rounded-full shadow-lg z-50"
            initial={{ scale: 0, rotate: -20, y: 10 }}
            animate={{
              scale: 1,
              rotate: [0, -5, 5, 0],
              y: 0,
            }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{
              type: "spring",
              stiffness: 400,
              rotate: { duration: 0.5, repeat: Infinity, repeatDelay: 1 },
            }}
          >
            WIN!
          </motion.div>
        )}
      </AnimatePresence>
    </motion.button>
  );
}
