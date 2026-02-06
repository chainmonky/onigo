"use client";

import { useEffect, useState } from "react";
import { ConnectionStatus } from "./ConnectionStatus";
import { WalletStatus } from "./WalletStatus";
import { motion } from "framer-motion";
import { cn } from "~~/lib/utils";
import { useGameStore } from "~~/store/gameStore";

export function CyberpunkNavbar() {
  const { currentRound, marketId } = useGameStore();
  const [timeLeft, setTimeLeft] = useState<number>(0);

  const phase = currentRound?.phase;
  const timing = currentRound?.timing;

  useEffect(() => {
    if (!timing || !phase) {
      setTimeLeft(0);
      return;
    }

    let endTime: number;
    if (phase === "BETTING") {
      endTime = timing.bettingEndTime;
    } else if (phase === "LIVE") {
      endTime = timing.liveEndTime;
    } else {
      endTime = timing.liveEndTime;
    }

    const updateTimer = () => {
      const now = Math.floor(Date.now() / 1000);
      const remaining = Math.max(0, endTime - now);
      setTimeLeft(remaining);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [timing, phase]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getProgress = () => {
    if (!timing || !phase) return 0;
    let startTime: number;
    let endTime: number;

    if (phase === "BETTING") {
      startTime = timing.roundStartTime;
      endTime = timing.bettingEndTime;
    } else if (phase === "LIVE") {
      startTime = timing.bettingEndTime;
      endTime = timing.liveEndTime;
    } else {
      return 100;
    }

    const total = endTime - startTime;
    const elapsed = Math.floor(Date.now() / 1000) - startTime;
    return Math.min(100, (elapsed / total) * 100);
  };

  const progress = getProgress();
  const isUrgent = timeLeft <= 10 && timeLeft > 0;

  return (
    <header className="sticky top-0 z-50 px-4 py-2">
      {/* Main navbar container with cyberpunk styling */}
      <motion.nav
        className={cn(
          "relative mx-auto max-w-8xl",
          "bg-gradient-to-r from-gray-900/95 via-gray-800/95 to-gray-900/95",
          "backdrop-blur-md rounded-2xl",
          "border border-[rgba(32,227,178,0.3)]",
          "shadow-[0_0_20px_rgba(32,227,178,0.15),inset_0_1px_0_rgba(255,255,255,0.05)]",
        )}
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        {/* Top glow line */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-1/2 h-px bg-gradient-to-r from-transparent via-[#20E3B2] to-transparent" />

        {/* Corner accents - isomorphic style */}
        <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-[#20E3B2] rounded-tl-2xl opacity-60" />
        <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-[#20E3B2] rounded-tr-2xl opacity-60" />
        <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-[#20E3B2] rounded-bl-2xl opacity-60" />
        <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-[#20E3B2] rounded-br-2xl opacity-60" />

        {/* Content */}
        <div className="flex items-center justify-between px-4 py-2 h-14">
          {/* Left - Logo */}
          <div className="flex items-center gap-3">
            {/* Logo with glow */}
            <div className="relative">
              <h1 className="font-[family-name:var(--font-orbitron)] text-xl font-bold text-[#20E3B2] tracking-wider">
                ONIGO
              </h1>
              <div className="absolute inset-0 blur-sm bg-[#20E3B2] opacity-30 -z-10" />
            </div>
            <div className="hidden sm:block h-6 w-px bg-gradient-to-b from-transparent via-[#20E3B2]/50 to-transparent" />
            <span className="hidden sm:block text-xs font-[family-name:var(--font-share-tech-orbitron)] text-gray-400 uppercase tracking-widest">
              Prediction
            </span>
          </div>

          {/* Center - Timer */}
          <div className="flex items-center gap-4">
            {currentRound ? (
              <div className="flex items-center gap-3">
                {/* Round number */}
                <div className="hidden md:flex items-center gap-2 px-3 py-1 rounded-lg bg-gray-800/50 border border-gray-700/50">
                  <span className="text-xs text-gray-500 uppercase tracking-wider">Round</span>
                  <span className="font-[family-name:var(--font-share-tech-orbitron)] text-[#20E3B2] font-bold">
                    #{currentRound.roundId}
                  </span>
                </div>

                {/* Current price */}
                {currentRound?.currentPrice && (
                  <div className="hidden lg:flex items-center gap-2 px-3 py-1 rounded-lg bg-gray-800/50 border border-gray-700/50">
                    <span className="text-xs text-gray-500">BTC</span>
                    <span className="font-[family-name:var(--font-share-tech-orbitron)] text-[#20E3B2] font-bold">
                      ${currentRound.currentPrice.toLocaleString()}
                    </span>
                  </div>
                )}

                {/* Phase badge */}
                <div
                  className={cn(
                    "px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider",
                    "border backdrop-blur-sm",
                    phase === "BETTING" && "bg-[#20E3B2]/10 border-[#20E3B2]/50 text-[#20E3B2]",
                    phase === "LIVE" && "bg-emerald-500/10 border-emerald-500/50 text-emerald-400",
                    phase === "SETTLING" && "bg-amber-500/10 border-amber-500/50 text-amber-400",
                  )}
                >
                  {phase}
                </div>

                {/* Timer display */}
                <div className="flex items-center gap-2">
                  <motion.div
                    className={cn(
                      "font-[family-name:var(--font-share-tech-orbitron)] text-2xl font-bold tracking-wider",
                      isUrgent && "text-red-500",
                      !isUrgent && phase === "BETTING" && "text-[#20E3B2]",
                      !isUrgent && phase === "LIVE" && "text-emerald-400",
                      !isUrgent && phase === "SETTLING" && "text-amber-400",
                    )}
                    animate={isUrgent ? { opacity: [1, 0.5, 1] } : {}}
                    transition={{ duration: 0.5, repeat: isUrgent ? Infinity : 0 }}
                  >
                    {formatTime(timeLeft)}
                  </motion.div>

                  {/* Progress bar */}
                  <div className="hidden sm:block w-20 h-1.5 bg-gray-700/50 rounded-full overflow-hidden">
                    <motion.div
                      className={cn(
                        "h-full rounded-full",
                        phase === "BETTING" && "bg-[#20E3B2]",
                        phase === "LIVE" && "bg-emerald-400",
                        phase === "SETTLING" && "bg-amber-400",
                        isUrgent && "bg-red-500",
                      )}
                      animate={{ width: `${progress}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-gray-500">
                <div className="w-2 h-2 rounded-full bg-gray-600 animate-pulse" />
                <span className="text-xs font-[family-name:var(--font-share-tech-orbitron)]">AWAITING ROUND...</span>
              </div>
            )}
          </div>

          {/* Right - Info */}
          <div className="flex items-center gap-3">
            {/* Market ID */}
            <div className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-800/30 border border-gray-700/30">
              <div className="w-1.5 h-1.5 rounded-full bg-[#20E3B2] animate-pulse" />
              <span className="text-xs font-[family-name:var(--font-share-tech-orbitron)] text-gray-400">
                Market {marketId}
              </span>
            </div>

            {/* Connection status (Keeper) */}
            <div className="hidden md:block">
              <ConnectionStatus />
            </div>

            {/* Wallet Status */}
            <WalletStatus />
          </div>
        </div>

        {/* Bottom glow line */}
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1/3 h-px bg-gradient-to-r from-transparent via-[#20E3B2]/50 to-transparent" />
      </motion.nav>
    </header>
  );
}
