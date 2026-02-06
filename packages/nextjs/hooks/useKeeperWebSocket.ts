"use client";

import { useCallback, useEffect, useRef } from "react";
import { Socket, io } from "socket.io-client";
import { KEEPER_WS_URL } from "~~/lib/game/constants";
import type {
  KeeperPhaseChangePayload,
  KeeperPriceUpdatePayload,
  KeeperRoundEndPayload,
  KeeperRoundStartPayload,
} from "~~/lib/game/types";
import { useGameStore } from "~~/store/gameStore";

export function useKeeperWebSocket() {
  const socketRef = useRef<Socket | null>(null);

  const {
    marketId,
    connectionStatus,
    setConnectionStatus,
    handleRoundStart,
    handlePhaseChange,
    handlePriceUpdate,
    handleRoundEnd,
  } = useGameStore();

  const connect = useCallback(() => {
    if (socketRef.current?.connected) {
      return;
    }

    setConnectionStatus("connecting");
    console.log(`[Keeper Socket.IO] Connecting to ${KEEPER_WS_URL}...`);

    const socket = io(KEEPER_WS_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    });

    socket.on("connect", () => {
      console.log("[Keeper Socket.IO] Connected");
      setConnectionStatus("connected");

      // Subscribe to market
      socket.emit("SUBSCRIBE", { marketId });
    });

    socket.on("disconnect", reason => {
      console.log("[Keeper Socket.IO] Disconnected:", reason);
      setConnectionStatus("disconnected");
    });

    socket.on("connect_error", error => {
      console.error("[Keeper Socket.IO] Connection error:", error.message);
      setConnectionStatus("error");
    });

    socket.on("CONNECTED", () => {
      console.log("[Keeper Socket.IO] Server acknowledged connection");
    });

    socket.on("SUBSCRIBED", (payload: { marketId: number }) => {
      console.log(`[Keeper Socket.IO] Subscribed to market ${payload.marketId}`);
    });

    socket.on("ROUND_START", (payload: KeeperRoundStartPayload) => {
      console.log(`[Keeper Socket.IO] Round ${payload.roundId} started`);
      handleRoundStart(payload);
    });

    socket.on("PHASE_CHANGE", (payload: KeeperPhaseChangePayload) => {
      console.log(`[Keeper Socket.IO] Phase changed to ${payload.phase}`);
      handlePhaseChange(payload.phase);
    });

    socket.on("PRICE_UPDATE", (payload: KeeperPriceUpdatePayload) => {
      handlePriceUpdate(payload);
    });

    socket.on("ROUND_END", (payload: KeeperRoundEndPayload) => {
      console.log(`[Keeper Socket.IO] Round ${payload.roundId} ended`);
      handleRoundEnd(payload);
    });

    socket.on("message", (data: string) => {
      try {
        const message = JSON.parse(data);
        switch (message.type) {
          case "ROUND_START":
            handleRoundStart(message.payload);
            break;
          case "PHASE_CHANGE":
            handlePhaseChange(message.payload.phase);
            break;
          case "PRICE_UPDATE":
            handlePriceUpdate(message.payload);
            break;
          case "ROUND_END":
            handleRoundEnd(message.payload);
            break;
        }
      } catch {}
    });

    socketRef.current = socket;
  }, [marketId, setConnectionStatus, handleRoundStart, handlePhaseChange, handlePriceUpdate, handleRoundEnd]);

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setConnectionStatus("disconnected");
  }, [setConnectionStatus]);

  const subscribe = useCallback((newMarketId: number) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit("SUBSCRIBE", { marketId: newMarketId });
    }
  }, []);

  const unsubscribe = useCallback((oldMarketId: number) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit("UNSUBSCRIBE", { marketId: oldMarketId });
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  useEffect(() => {
    if (socketRef.current?.connected) {
      subscribe(marketId);
    }
  }, [marketId, subscribe]);

  return {
    socket: socketRef.current,
    isConnected: connectionStatus === "connected",
    connect,
    disconnect,
    subscribe,
    unsubscribe,
  };
}
