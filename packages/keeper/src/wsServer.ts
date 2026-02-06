import { Server as SocketIOServer, Socket } from "socket.io";

export type OnSubscribeCallback = (marketId: number, socket: Socket) => void;

export class WebSocketServer {
  private io: SocketIOServer;
  private subscriptions = new Map<number, Set<Socket>>();
  private priceStreamSubscriptions = new Map<number, Set<Socket>>();
  private onSubscribeCallback: OnSubscribeCallback | null = null;

  constructor(port: number) {
    this.io = new SocketIOServer(port, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
      transports: ["websocket", "polling"],
    });
    console.log(`[WS] Socket.IO server started on port ${port}`);

    this.io.on("connection", (socket) => {
      console.log(`[WS] Client connected: ${socket.id}`);

      socket.on("SUBSCRIBE", (data: { marketId?: number }) => {
        if (data?.marketId !== undefined) {
          this.subscribe(socket, data.marketId);
        }
      });

      socket.on("UNSUBSCRIBE", (data: { marketId?: number }) => {
        if (data?.marketId !== undefined) {
          this.unsubscribe(socket, data.marketId);
        }
      });

      // Price stream subscription - lightweight price-only updates
      socket.on("SUBSCRIBE_PRICE_STREAM", (data: { marketId?: number }) => {
        if (data?.marketId !== undefined) {
          this.subscribePriceStream(socket, data.marketId);
        }
      });

      socket.on("UNSUBSCRIBE_PRICE_STREAM", (data: { marketId?: number }) => {
        if (data?.marketId !== undefined) {
          this.unsubscribePriceStream(socket, data.marketId);
        }
      });

      socket.on("disconnect", (reason) => {
        console.log(`[WS] Client disconnected: ${socket.id} (${reason})`);
        this.removeClient(socket);
      });

      socket.on("error", (err) => {
        console.error("[WS] Client error:", err);
      });

      socket.emit("CONNECTED");
    });
  }

  private subscribe(socket: Socket, marketId: number) {
    if (!this.subscriptions.has(marketId)) {
      this.subscriptions.set(marketId, new Set());
    }
    this.subscriptions.get(marketId)!.add(socket);
    socket.emit("SUBSCRIBED", { marketId });
    console.log(`[WS] Client ${socket.id} subscribed to market ${marketId}`);
    if (this.onSubscribeCallback) {
      this.onSubscribeCallback(marketId, socket);
    }
  }

  private subscribePriceStream(socket: Socket, marketId: number) {
    if (!this.priceStreamSubscriptions.has(marketId)) {
      this.priceStreamSubscriptions.set(marketId, new Set());
    }
    this.priceStreamSubscriptions.get(marketId)!.add(socket);
    socket.emit("PRICE_STREAM_SUBSCRIBED", { marketId });
    console.log(`[WS] Client ${socket.id} subscribed to price stream for market ${marketId}`);
  }

  private unsubscribePriceStream(socket: Socket, marketId: number) {
    this.priceStreamSubscriptions.get(marketId)?.delete(socket);
    console.log(`[WS] Client ${socket.id} unsubscribed from price stream for market ${marketId}`);
  }

  onSubscribe(callback: OnSubscribeCallback) {
    this.onSubscribeCallback = callback;
  }

  sendToClient(socket: Socket, message: unknown) {
    const msg = message as { type: string; payload: unknown };
    socket.emit(msg.type, msg.payload);
  }

  private unsubscribe(socket: Socket, marketId: number) {
    this.subscriptions.get(marketId)?.delete(socket);
    console.log(`[WS] Client ${socket.id} unsubscribed from market ${marketId}`);
  }

  private removeClient(socket: Socket) {
    for (const clients of this.subscriptions.values()) {
      clients.delete(socket);
    }
    for (const clients of this.priceStreamSubscriptions.values()) {
      clients.delete(socket);
    }
  }

  broadcast(marketId: number, message: unknown) {
    const clients = this.subscriptions.get(marketId);
    if (clients) {
      let sentCount = 0;
      const msg = message as { type: string; payload: unknown };
      for (const socket of clients) {
        if (socket.connected) {
          socket.emit(msg.type, msg.payload);
          sentCount++;
        }
      }
      if (sentCount > 0) {
        console.log(`[WS] Broadcast ${msg.type} to ${sentCount} clients for market ${marketId}`);
      }
    }
  }

  // Broadcast price-only updates to price stream subscribers
  broadcastPriceStream(marketId: number, priceData: { price: number; timestamp: number; source: string }) {
    const clients = this.priceStreamSubscriptions.get(marketId);
    if (clients) {
      let sentCount = 0;
      for (const socket of clients) {
        if (socket.connected) {
          socket.emit("PRICE_TICK", {
            marketId,
            price: priceData.price,
            timestamp: priceData.timestamp,
            source: priceData.source,
          });
          sentCount++;
        }
      }
      if (sentCount > 0) {
        console.log(`[WS] Price tick to ${sentCount} stream clients: $${priceData.price.toLocaleString()}`);
      }
    }
  }

  getClientCount(marketId: number): number {
    return this.subscriptions.get(marketId)?.size || 0;
  }

  getPriceStreamClientCount(marketId: number): number {
    return this.priceStreamSubscriptions.get(marketId)?.size || 0;
  }

  close() {
    this.io.close();
    console.log("[WS] Server closed");
  }
}
