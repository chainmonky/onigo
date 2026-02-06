/**
 * Game Constants
 */

// WebSocket URLs
// Socket.IO handles protocol upgrade automatically, so we use http:// URLs
export const KEEPER_WS_URL = process.env.NEXT_PUBLIC_KEEPER_URL ?? "http://localhost:3001";
export const BROKER_WS_URL = process.env.NEXT_PUBLIC_BROKER_URL ?? "http://localhost:3002";

// Default Market ID
export const DEFAULT_MARKET_ID = 1;

// Bet amounts available
export const BET_AMOUNTS = [5, 10, 20] as const;
export type BetAmount = (typeof BET_AMOUNTS)[number];

// Grid display settings
// More rows and columns to match keeper's smaller increments
export const GRID_CONFIG = {
  CELL_WIDTH: 70,
  CELL_HEIGHT: 50,
  MAX_VISIBLE_ROWS: 15, // More rows for smaller price increments
  MAX_VISIBLE_COLS: 12, // More columns for 5-second time increments
};

// Mock user balance (will be replaced with real wallet balance)
export const MOCK_BALANCE = 100.0;

// Color theme for the game (matching Hyperliquid teal theme)
export const GAME_COLORS = {
  // Grid colors
  gridBg: "var(--color-base-200)",
  gridSurface: "var(--color-base-100)",
  gridBorder: "var(--color-base-300)",
  gridBorderHover: "var(--color-primary)",

  // Bet cell colors
  betActive: "#20E3B2", // Teal/primary
  betActiveGlow: "rgba(32, 227, 178, 0.5)",
  betPending: "#20E3B2",
  betWon: "#20E3B2",
  betLost: "#f85149",

  // Price indicator
  priceText: "var(--color-base-content)",
  priceBadge: "var(--color-primary)",

  // Hit cell indicator
  hitCell: "rgba(32, 227, 178, 0.3)",
  hitCellBorder: "rgba(32, 227, 178, 0.6)",
};
