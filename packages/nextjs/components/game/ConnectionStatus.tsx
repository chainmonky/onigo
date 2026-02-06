"use client";

import { motion } from "framer-motion";
import { cn } from "~~/lib/utils";
import { useGameStore } from "~~/store/gameStore";

export function ConnectionStatus() {
  const { connectionStatus } = useGameStore();

  const statusConfig = {
    disconnected: {
      color: "bg-error",
      text: "Disconnected",
      pulse: false,
    },
    connecting: {
      color: "bg-warning",
      text: "Connecting...",
      pulse: true,
    },
    connected: {
      color: "bg-success",
      text: "Connected",
      pulse: false,
    },
    error: {
      color: "bg-error",
      text: "Error",
      pulse: false,
    },
  };

  const config = statusConfig[connectionStatus];

  return (
    <motion.div className="flex items-center gap-2" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="relative">
        <div className={cn("w-2.5 h-2.5 rounded-full", config.color)} />
        {config.pulse && (
          <div className={cn("absolute inset-0 w-2.5 h-2.5 rounded-full animate-ping", config.color, "opacity-75")} />
        )}
      </div>
      <span className="text-xs text-base-content/60">{config.text}</span>
    </motion.div>
  );
}
