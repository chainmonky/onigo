"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BROKER_WS_URL } from "~~/lib/game/constants";
import type { ConnectionStatus } from "~~/lib/game/types";

// Broker request/response types
export type CreateSessionRequest = {
  playerAddress: string;
  amount: string;
  marketId: string;
  roundId: string;
  bets: {
    amount: string;
    cells: { timeSlotStart: string; dataRangeStart: string }[];
  }[];
  payload: unknown[];
  playerSignature: string;
};

export type SessionCreatedResponse = {
  appSessionId: string;
};

export type SessionErrorResponse = {
  error: string;
};

export type RoundSettledResponse = {
  marketId: number;
  roundId: number;
  txHash: string;
  winners: number;
  totalPayout: string;
};

export type BrokerSessionInfo = {
  playerAddress: string;
  appSessionId: string;
  marketId: number;
  roundId: string;
  betsCount: number;
};

export type BrokerRoundSummary = {
  marketId: number;
  roundId: number;
  betCount: number;
  totalPool: string;
};

export type BrokerBalanceResponse = {
  address: `0x${string}`;
  asset: string;
  amount: string;
  formatted: string;
};

export function useBrokerWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [brokerAddress, setBrokerAddress] = useState<`0x${string}` | null>(null);
  const [isSessionPending, setIsSessionPending] = useState(false);
  const messageHandlersRef = useRef<Map<string, ((data: any) => void)[]>>(new Map());

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    setConnectionStatus("connecting");
    console.log(`[Broker WebSocket] Connecting to ${BROKER_WS_URL}...`);

    const ws = new WebSocket(BROKER_WS_URL);

    ws.onopen = () => {
      console.log("[Broker WebSocket] Connected");
      setConnectionStatus("connected");

      // Request broker address on connect
      ws.send(JSON.stringify({ type: "get_broker_address" }));
    };

    ws.onclose = () => {
      console.log("[Broker WebSocket] Disconnected");
      setConnectionStatus("disconnected");
      setBrokerAddress(null);
      wsRef.current = null;
    };

    ws.onerror = error => {
      console.error("[Broker WebSocket] Connection error:", error);
      setConnectionStatus("error");
    };

    ws.onmessage = event => {
      try {
        const msg = JSON.parse(event.data);
        console.log(`[Broker WebSocket] Received: ${msg.type}`);

        // Handle broker address response
        if (msg.type === "broker_address") {
          console.log(`[Broker WebSocket] Broker address: ${msg.address}`);
          setBrokerAddress(msg.address);
        }

        // Trigger registered handlers
        const handlers = messageHandlersRef.current.get(msg.type) || [];
        handlers.forEach(handler => handler(msg));
      } catch (err) {
        console.error("[Broker WebSocket] Error parsing message:", err);
      }
    };

    wsRef.current = ws;
  }, []);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionStatus("disconnected");
    setBrokerAddress(null);
  }, []);

  // Get broker address
  const getBrokerAddress = useCallback((): Promise<`0x${string}`> => {
    return new Promise((resolve, reject) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        reject(new Error("Broker not connected"));
        return;
      }

      if (brokerAddress) {
        resolve(brokerAddress);
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error("Timeout getting broker address"));
      }, 10000);

      const handler = (data: { address: `0x${string}` }) => {
        clearTimeout(timeout);
        setBrokerAddress(data.address);
        resolve(data.address);
      };

      // Register one-time handler
      const handlers = messageHandlersRef.current.get("broker_address") || [];
      const oneTimeHandler = (msg: any) => {
        handler(msg);
        // Remove self after execution
        const idx = handlers.indexOf(oneTimeHandler);
        if (idx > -1) handlers.splice(idx, 1);
      };
      handlers.push(oneTimeHandler);
      messageHandlersRef.current.set("broker_address", handlers);

      wsRef.current.send(JSON.stringify({ type: "get_broker_address" }));
    });
  }, [brokerAddress]);

  // Create session (place bet)
  const createSession = useCallback((request: CreateSessionRequest): Promise<SessionCreatedResponse> => {
    return new Promise((resolve, reject) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        reject(new Error("Broker not connected"));
        return;
      }

      setIsSessionPending(true);

      const timeout = setTimeout(() => {
        setIsSessionPending(false);
        cleanup();
        reject(new Error("Timeout creating session"));
      }, 30000);

      const cleanup = () => {
        clearTimeout(timeout);
        const createdHandlers = messageHandlersRef.current.get("session_created") || [];
        const errorHandlers = messageHandlersRef.current.get("session_error") || [];

        const createdIdx = createdHandlers.indexOf(handleCreated);
        const errorIdx = errorHandlers.indexOf(handleError);

        if (createdIdx > -1) createdHandlers.splice(createdIdx, 1);
        if (errorIdx > -1) errorHandlers.splice(errorIdx, 1);
      };

      const handleCreated = (data: SessionCreatedResponse) => {
        setIsSessionPending(false);
        cleanup();
        console.log(`[Broker WebSocket] Session created: ${data.appSessionId}`);
        resolve(data);
      };

      const handleError = (data: SessionErrorResponse) => {
        setIsSessionPending(false);
        cleanup();
        console.error(`[Broker WebSocket] Session error: ${data.error}`);
        reject(new Error(data.error));
      };

      // Register handlers
      const createdHandlers = messageHandlersRef.current.get("session_created") || [];
      const errorHandlers = messageHandlersRef.current.get("session_error") || [];
      createdHandlers.push(handleCreated);
      errorHandlers.push(handleError);
      messageHandlersRef.current.set("session_created", createdHandlers);
      messageHandlersRef.current.set("session_error", errorHandlers);

      // Send request
      wsRef.current.send(JSON.stringify({ type: "create_session", ...request }));
    });
  }, []);

  // Get all active sessions
  const getSessions = useCallback((): Promise<BrokerSessionInfo[]> => {
    return new Promise((resolve, reject) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        reject(new Error("Broker not connected"));
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timeout getting sessions"));
      }, 10000);

      const cleanup = () => {
        clearTimeout(timeout);
        const handlers = messageHandlersRef.current.get("sessions") || [];
        const idx = handlers.indexOf(handleSessions);
        if (idx > -1) handlers.splice(idx, 1);
      };

      const handleSessions = (data: { sessions: BrokerSessionInfo[] }) => {
        cleanup();
        resolve(data.sessions);
      };

      const handlers = messageHandlersRef.current.get("sessions") || [];
      handlers.push(handleSessions);
      messageHandlersRef.current.set("sessions", handlers);

      wsRef.current.send(JSON.stringify({ type: "get_sessions" }));
    });
  }, []);

  // Get all bets summary
  const getBets = useCallback((): Promise<BrokerRoundSummary[]> => {
    return new Promise((resolve, reject) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        reject(new Error("Broker not connected"));
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timeout getting bets"));
      }, 10000);

      const cleanup = () => {
        clearTimeout(timeout);
        const handlers = messageHandlersRef.current.get("bets") || [];
        const idx = handlers.indexOf(handleBets);
        if (idx > -1) handlers.splice(idx, 1);
      };

      const handleBets = (data: { rounds: BrokerRoundSummary[] }) => {
        cleanup();
        resolve(data.rounds);
      };

      const handlers = messageHandlersRef.current.get("bets") || [];
      handlers.push(handleBets);
      messageHandlersRef.current.set("bets", handlers);

      wsRef.current.send(JSON.stringify({ type: "get_bets" }));
    });
  }, []);

  // Trigger round settlement
  const settleRound = useCallback((marketId: number, roundId: number): Promise<RoundSettledResponse> => {
    return new Promise((resolve, reject) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        reject(new Error("Broker not connected"));
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timeout settling round"));
      }, 60000);

      const cleanup = () => {
        clearTimeout(timeout);
        const settledHandlers = messageHandlersRef.current.get("round_settled") || [];
        const errorHandlers = messageHandlersRef.current.get("settle_error") || [];
        const settledIdx = settledHandlers.indexOf(handleSettled);
        const errorIdx = errorHandlers.indexOf(handleError);
        if (settledIdx > -1) settledHandlers.splice(settledIdx, 1);
        if (errorIdx > -1) errorHandlers.splice(errorIdx, 1);
      };

      const handleSettled = (data: RoundSettledResponse) => {
        cleanup();
        console.log(`[Broker WebSocket] Round settled: ${data.txHash}`);
        resolve(data);
      };

      const handleError = (data: SessionErrorResponse) => {
        cleanup();
        console.error(`[Broker WebSocket] Settlement error: ${data.error}`);
        reject(new Error(data.error));
      };

      const settledHandlers = messageHandlersRef.current.get("round_settled") || [];
      const errorHandlers = messageHandlersRef.current.get("settle_error") || [];
      settledHandlers.push(handleSettled);
      errorHandlers.push(handleError);
      messageHandlersRef.current.set("round_settled", settledHandlers);
      messageHandlersRef.current.set("settle_error", errorHandlers);

      wsRef.current.send(JSON.stringify({ type: "settle_round", marketId, roundId }));
    });
  }, []);

  // Subscribe to events
  const onSessionCreated = useCallback((callback: (data: SessionCreatedResponse) => void) => {
    const handlers = messageHandlersRef.current.get("session_created") || [];
    const wrappedCallback = (data: any) => callback(data);
    handlers.push(wrappedCallback);
    messageHandlersRef.current.set("session_created", handlers);

    return () => {
      const idx = handlers.indexOf(wrappedCallback);
      if (idx > -1) handlers.splice(idx, 1);
    };
  }, []);

  const onSessionError = useCallback((callback: (data: SessionErrorResponse) => void) => {
    const handlers = messageHandlersRef.current.get("session_error") || [];
    const wrappedCallback = (data: any) => callback(data);
    handlers.push(wrappedCallback);
    messageHandlersRef.current.set("session_error", handlers);

    return () => {
      const idx = handlers.indexOf(wrappedCallback);
      if (idx > -1) handlers.splice(idx, 1);
    };
  }, []);

  const onRoundSettled = useCallback((callback: (data: RoundSettledResponse) => void) => {
    const handlers = messageHandlersRef.current.get("round_settled") || [];
    const wrappedCallback = (data: any) => callback(data);
    handlers.push(wrappedCallback);
    messageHandlersRef.current.set("round_settled", handlers);

    return () => {
      const idx = handlers.indexOf(wrappedCallback);
      if (idx > -1) handlers.splice(idx, 1);
    };
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    socket: wsRef.current,
    isConnected: connectionStatus === "connected",
    connectionStatus,
    brokerAddress,
    isSessionPending,
    connect,
    disconnect,
    getBrokerAddress,
    createSession,
    getSessions,
    getBets,
    settleRound,
    onSessionCreated,
    onSessionError,
    onRoundSettled,
  };
}
