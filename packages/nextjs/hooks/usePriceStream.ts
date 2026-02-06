"use client";

/**
 * usePriceStream - Lightweight WebSocket hook for price-only updates
 *
 * Use this hook when you need just price data without the full round state
 * (grid bounds, hit cells, etc). This is useful for:
 * - Displaying a simple price ticker
 * - Building standalone price charts
 * - Scenarios where you don't need the full game state from useKeeperWebSocket
 *
 * Note: This creates a separate socket connection. If you also use
 * useKeeperWebSocket in the same component tree, you will have two connections.
 * For the main game UI, prefer useKeeperWebSocket which provides complete data.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Socket, io } from "socket.io-client";
import { KEEPER_WS_URL } from "~~/lib/game/constants";
import type { PriceTickPayload } from "~~/lib/game/types";

type PriceStreamState = {
  isConnected: boolean;
  currentPrice: number | null;
  priceHistory: PriceTickPayload[];
};

export function usePriceStream(marketId: number, maxHistoryLength = 120) {
  const socketRef = useRef<Socket | null>(null);
  const [state, setState] = useState<PriceStreamState>({
    isConnected: false,
    currentPrice: null,
    priceHistory: [],
  });

  const connect = useCallback(() => {
    if (socketRef.current?.connected) {
      return;
    }

    console.log(`[PriceStream] Connecting to ${KEEPER_WS_URL}...`);

    const socket = io(KEEPER_WS_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    });

    socket.on("connect", () => {
      console.log("[PriceStream] Connected");
      setState(prev => ({ ...prev, isConnected: true }));
      // Subscribe to price stream
      socket.emit("SUBSCRIBE_PRICE_STREAM", { marketId });
    });

    socket.on("disconnect", reason => {
      console.log("[PriceStream] Disconnected:", reason);
      setState(prev => ({ ...prev, isConnected: false }));
    });

    socket.on("connect_error", error => {
      console.error("[PriceStream] Connection error:", error.message);
    });

    socket.on("PRICE_STREAM_SUBSCRIBED", (payload: { marketId: number }) => {
      console.log(`[PriceStream] Subscribed to market ${payload.marketId}`);
    });

    socket.on("PRICE_TICK", (tick: PriceTickPayload) => {
      setState(prev => {
        // Add new tick and maintain max history length using slice
        const newHistory =
          prev.priceHistory.length >= maxHistoryLength
            ? [...prev.priceHistory.slice(1), tick]
            : [...prev.priceHistory, tick];
        return {
          ...prev,
          currentPrice: tick.price,
          priceHistory: newHistory,
        };
      });
    });

    socketRef.current = socket;
  }, [marketId, maxHistoryLength]);

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit("UNSUBSCRIBE_PRICE_STREAM", { marketId });
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setState({
      isConnected: false,
      currentPrice: null,
      priceHistory: [],
    });
  }, [marketId]);

  const clearHistory = useCallback(() => {
    setState(prev => ({
      ...prev,
      priceHistory: [],
    }));
  }, []);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  // Resubscribe when marketId changes
  useEffect(() => {
    if (socketRef.current?.connected) {
      socketRef.current.emit("SUBSCRIBE_PRICE_STREAM", { marketId });
    }
  }, [marketId]);

  return {
    ...state,
    connect,
    disconnect,
    clearHistory,
  };
}
