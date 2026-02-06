"use client";

import { useCallback, useState } from "react";
import { useBrokerWebSocket } from "./useBrokerWebSocket";
import { bytesToHex, createWalletClient, custom, hexToBytes, keccak256, toBytes } from "viem";
import { useAccount } from "wagmi";
import { usdToUnits } from "~~/lib/broker/constants";
import { buildSessionPayload } from "~~/lib/broker/encoding";
import type { BetCell } from "~~/lib/game/types";

export type PlaceBetParams = {
  marketId: number;
  roundId: number;
  betAmountUsd: number;
  cells: BetCell[];
};

export type PlaceBetResult = {
  success: boolean;
  appSessionId?: string;
  error?: string;
};

export function useBrokerSession() {
  const { address, isConnected } = useAccount();
  const { isConnected: isBrokerConnected, brokerAddress, createSession, isSessionPending } = useBrokerWebSocket();

  const [isPlacingBet, setIsPlacingBet] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const signPayload = useCallback(
    async (payload: unknown[]): Promise<`0x${string}`> => {
      if (!address || !window.ethereum) {
        throw new Error("Wallet not connected");
      }

      const message = JSON.stringify(payload);
      const digestHex = keccak256(toBytes(message));

      const walletClient = createWalletClient({
        transport: custom(window.ethereum),
      });

      // Sign with EIP-191
      const eip191Signature = await walletClient.signMessage({
        account: address as `0x${string}`,
        message: { raw: digestHex },
      });

      // Convert to raw ECDSA: v = v - 27
      const sigBytes = hexToBytes(eip191Signature);
      const r = sigBytes.slice(0, 32);
      const s = sigBytes.slice(32, 64);
      const v = sigBytes[64] - 27; // Convert 27/28 to 0/1

      const rawSig = new Uint8Array(65);
      rawSig.set(r, 0);
      rawSig.set(s, 32);
      rawSig[64] = v;

      return bytesToHex(rawSig) as `0x${string}`;
    },
    [address],
  );
  /**
   * Place a bet by creating a session with the broker
   */
  const placeBet = useCallback(
    async (params: PlaceBetParams): Promise<PlaceBetResult> => {
      const { marketId, roundId, betAmountUsd, cells } = params;

      // Validate prerequisites
      if (!isConnected || !address) {
        return { success: false, error: "Wallet not connected" };
      }

      if (!isBrokerConnected || !brokerAddress) {
        return { success: false, error: "Broker not connected" };
      }

      if (cells.length === 0) {
        return { success: false, error: "No cells selected" };
      }

      setIsPlacingBet(true);
      setLastError(null);

      try {
        console.log("[BrokerSession] Building session payload...");
        console.log(`  Player: ${address}`);
        console.log(`  Broker: ${brokerAddress}`);
        console.log(`  Market: ${marketId}, Round: ${roundId}`);
        console.log(`  Amount: $${betAmountUsd} (${usdToUnits(betAmountUsd)} units)`);
        console.log(`  Cells: ${cells.length}`);

        // Build the session payload
        const { payload, bets } = buildSessionPayload(
          address as `0x${string}`,
          brokerAddress,
          marketId,
          roundId,
          betAmountUsd,
          cells,
        );

        console.log("[BrokerSession] Signing payload...");

        // Sign the payload
        const playerSignature = await signPayload(payload);
        console.log(`[BrokerSession] Signature: ${playerSignature.slice(0, 20)}...`);

        // Create the session request
        const request = {
          playerAddress: address,
          amount: usdToUnits(betAmountUsd),
          marketId: marketId.toString(),
          roundId: roundId.toString(),
          bets: bets.map(b => ({
            amount: b.amount,
            cells: b.cells,
          })),
          payload,
          playerSignature,
        };

        console.log("[BrokerSession] Sending create_session request...");

        // Send to broker
        const response = await createSession(request);

        console.log(`[BrokerSession] Session created: ${response.appSessionId}`);

        return {
          success: true,
          appSessionId: response.appSessionId,
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error("[BrokerSession] Error:", errorMessage);
        setLastError(errorMessage);
        return {
          success: false,
          error: errorMessage,
        };
      } finally {
        setIsPlacingBet(false);
      }
    },
    [address, isConnected, isBrokerConnected, brokerAddress, signPayload, createSession],
  );

  return {
    // State
    isConnected: isConnected && isBrokerConnected,
    isPlacingBet: isPlacingBet || isSessionPending,
    lastError,
    playerAddress: address,
    brokerAddress,

    // Actions
    placeBet,
  };
}
