import { WebSocketServer as WSServer, WebSocket } from "ws";

export type OnSubscribeCallback = (marketId: number, ws: WebSocket) => void;

export class WebSocketServer {
  private wss: WSServer;
  private subscriptions = new Map<number, Set<WebSocket>>();
  private onSubscribeCallback: OnSubscribeCallback | null = null;

  constructor(port: number) {
    this.wss = new WSServer({ port });
    console.log(`[WS] Server started on port ${port}`);

    this.wss.on("connection", (ws) => {
      console.log(`[WS] Client connected`);

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            type: string;
            payload?: { marketId?: number };
          };
          if (msg.type === "SUBSCRIBE" && msg.payload?.marketId !== undefined) {
            this.subscribe(ws, msg.payload.marketId);
          } else if (msg.type === "UNSUBSCRIBE" && msg.payload?.marketId !== undefined) {
            this.unsubscribe(ws, msg.payload.marketId);
          }
        } catch (err) {
          console.error("[WS] Failed to parse message:", err);
        }
      });

      ws.on("close", () => {
        console.log(`[WS] Client disconnected`);
        this.removeClient(ws);
      });

      ws.on("error", (err) => {
        console.error("[WS] Client error:", err);
      });

      ws.send(JSON.stringify({ type: "CONNECTED" }));
    });
  }

  private subscribe(ws: WebSocket, marketId: number) {
    if (!this.subscriptions.has(marketId)) {
      this.subscriptions.set(marketId, new Set());
    }
    this.subscriptions.get(marketId)!.add(ws);
    ws.send(JSON.stringify({ type: "SUBSCRIBED", payload: { marketId } }));
    console.log(`[WS] Client subscribed to market ${marketId}`);
    if (this.onSubscribeCallback) {
      this.onSubscribeCallback(marketId, ws);
    }
  }

  onSubscribe(callback: OnSubscribeCallback) {
    this.onSubscribeCallback = callback;
  }

  sendToClient(ws: WebSocket, message: unknown) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private unsubscribe(ws: WebSocket, marketId: number) {
    this.subscriptions.get(marketId)?.delete(ws);
    console.log(`[WS] Client unsubscribed from market ${marketId}`);
  }

  private removeClient(ws: WebSocket) {
    for (const clients of this.subscriptions.values()) {
      clients.delete(ws);
    }
  }

  broadcast(marketId: number, message: unknown) {
    const data = JSON.stringify(message);
    const clients = this.subscriptions.get(marketId);
    if (clients) {
      let sentCount = 0;
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
          sentCount++;
        }
      }
      if (sentCount > 0) {
        console.log(`[WS] Broadcast to ${sentCount} clients for market ${marketId}`);
      }
    }
  }

  getClientCount(marketId: number): number {
    return this.subscriptions.get(marketId)?.size || 0;
  }

  close() {
    this.wss.close();
    console.log("[WS] Server closed");
  }
}
