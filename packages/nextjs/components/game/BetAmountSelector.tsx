"use client";

import { useCallback, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { motion } from "framer-motion";
import { useAccount } from "wagmi";
import { useBrokerSession } from "~~/hooks/useBrokerSession";
import { BET_AMOUNTS } from "~~/lib/game/constants";
import { cn } from "~~/lib/utils";
import { useGameStore } from "~~/store/gameStore";

export function BetAmountSelector() {
  const {
    selectedBetAmount,
    setSelectedBetAmount,
    currentRound,
    pendingBets,
    clearPendingBets,
    confirmBets,
    addToast,
  } = useGameStore();
  const { isConnected, address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { placeBet, isPlacingBet, brokerAddress } = useBrokerSession();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isBettingPhase = currentRound?.phase === "BETTING";
  const hasPendingBets = pendingBets.size > 0;
  const canBet = isConnected && isBettingPhase && !isPlacingBet && !isSubmitting;

  /**
   * Handle bet confirmation - creates session with broker
   */
  const handleConfirmBets = useCallback(async () => {
    if (!currentRound || pendingBets.size === 0) return;

    // Check if broker is connected
    if (!brokerAddress) {
      addToast({
        type: "error",
        message: "Broker not connected. Please wait...",
      });
      return;
    }

    setIsSubmitting(true);

    try {
      // Convert pending bets to array
      const cells = Array.from(pendingBets.values());

      console.log("[BetAmountSelector] Placing bet...", {
        marketId: currentRound.marketId,
        roundId: currentRound.roundId,
        amount: selectedBetAmount,
        cells: cells.length,
      });

      // Place bet with broker
      const result = await placeBet({
        marketId: currentRound.marketId,
        roundId: currentRound.roundId,
        betAmountUsd: selectedBetAmount,
        cells,
      });

      if (result.success) {
        // Success - update local state
        confirmBets();
        addToast({
          type: "success",
          message: `Bet placed! Session: ${result.appSessionId?.slice(0, 10)}...`,
        });
      } else {
        // Error from broker
        addToast({
          type: "error",
          message: result.error || "Failed to place bet",
        });
      }
    } catch (err) {
      console.error("[BetAmountSelector] Error placing bet:", err);
      addToast({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to place bet",
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [currentRound, pendingBets, selectedBetAmount, brokerAddress, placeBet, confirmBets, addToast]);

  // If wallet not connected, show connect prompt
  if (!isConnected) {
    return (
      <motion.div
        className="card bg-base-100 shadow-lg"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <div className="card-body p-4">
          <h3 className="text-sm font-medium text-base-content/60 mb-3">Place Your Bets</h3>

          <div className="flex flex-col items-center gap-4 py-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <svg className="w-6 h-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-sm text-base-content/80 mb-1">Connect your wallet to participate</p>
              <p className="text-xs text-base-content/50">Place bets on price movements and win rewards</p>
            </div>
            <button className="btn btn-primary btn-sm gap-2" onClick={openConnectModal}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                />
              </svg>
              Connect Wallet
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="card bg-base-100 shadow-lg"
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
    >
      <div className="card-body p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-base-content/60">Bet Amount</h3>
          {address && (
            <span className="text-xs text-primary/70 font-mono">
              {address.slice(0, 6)}...{address.slice(-4)}
            </span>
          )}
        </div>

        {/* Amount selector buttons */}
        <div className="flex gap-2">
          {BET_AMOUNTS.map(amount => (
            <button
              key={amount}
              className={cn(
                "btn btn-sm flex-1",
                selectedBetAmount === amount ? "btn-primary" : "btn-outline btn-primary",
                !canBet && "btn-disabled opacity-50",
              )}
              onClick={() => setSelectedBetAmount(amount)}
              disabled={!canBet}
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
            className={cn("btn btn-outline btn-sm flex-1", (!hasPendingBets || !canBet) && "btn-disabled")}
            onClick={clearPendingBets}
            disabled={!hasPendingBets || !canBet || isSubmitting}
          >
            Clear
          </button>
          <button
            className={cn("btn btn-primary btn-sm flex-1", (!hasPendingBets || !canBet) && "btn-disabled")}
            onClick={handleConfirmBets}
            disabled={!hasPendingBets || !canBet}
          >
            {isSubmitting || isPlacingBet ? (
              <>
                <span className="loading loading-spinner loading-xs"></span>
                Placing...
              </>
            ) : hasPendingBets ? (
              `Confirm (${pendingBets.size})`
            ) : (
              "Select cells"
            )}
          </button>
        </div>

        {/* Status messages */}
        {canBet && !brokerAddress && (
          <p className="text-xs text-warning text-center mt-2">
            <span className="loading loading-spinner loading-xs mr-1"></span>
            Connecting to broker...
          </p>
        )}
        {canBet && brokerAddress && (
          <p className="text-xs text-base-content/50 text-center mt-2">Click cells on the grid to place bets</p>
        )}
        {!isBettingPhase && currentRound && (
          <p className="text-xs text-warning text-center mt-2">Betting is closed for this round</p>
        )}
        {!currentRound && (
          <p className="text-xs text-base-content/50 text-center mt-2">Waiting for round to start...</p>
        )}
      </div>
    </motion.div>
  );
}
