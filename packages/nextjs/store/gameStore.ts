import { create } from "zustand";
import { BET_AMOUNTS, DEFAULT_MARKET_ID, MOCK_BALANCE } from "~~/lib/game/constants";
import type {
  Bet,
  BetCell,
  ConnectionStatus,
  KeeperPriceUpdatePayload,
  KeeperRoundEndPayload,
  KeeperRoundStartPayload,
  PriceDataPoint,
  RoundState,
} from "~~/lib/game/types";

type BetAmount = (typeof BET_AMOUNTS)[number];

type GameStore = {
  // Connection state
  connectionStatus: ConnectionStatus;
  marketId: number;

  // Round state
  currentRound: RoundState | null;

  // User state
  balance: number;
  selectedBetAmount: BetAmount;
  pendingBets: Map<string, BetCell>; // cellKey -> BetCell
  placedBets: Bet[];

  // UI state
  toasts: Array<{
    id: string;
    type: "success" | "error" | "info";
    message: string;
  }>;

  // Actions - Connection
  setConnectionStatus: (status: ConnectionStatus) => void;
  setMarketId: (marketId: number) => void;

  // Actions - Round
  handleRoundStart: (payload: KeeperRoundStartPayload) => void;
  handlePhaseChange: (phase: RoundState["phase"]) => void;
  handlePriceUpdate: (payload: KeeperPriceUpdatePayload) => void;
  handleRoundEnd: (payload: KeeperRoundEndPayload) => void;

  // Actions - Betting
  setSelectedBetAmount: (amount: BetAmount) => void;
  toggleCellBet: (cell: BetCell) => void;
  clearPendingBets: () => void;
  confirmBets: () => void;

  // Actions - Balance
  setBalance: (balance: number) => void;

  // Actions - UI
  addToast: (toast: Omit<GameStore["toasts"][0], "id">) => void;
  removeToast: (id: string) => void;

  // Helpers
  getCellKey: (cell: BetCell) => string;
  isCellSelected: (cell: BetCell) => boolean;
  isCellHit: (cell: BetCell) => boolean;
  getTotalPendingBetAmount: () => number;
};

export const useGameStore = create<GameStore>((set, get) => ({
  // Initial state
  connectionStatus: "disconnected",
  marketId: DEFAULT_MARKET_ID,
  currentRound: null,
  balance: MOCK_BALANCE,
  selectedBetAmount: BET_AMOUNTS[0],
  pendingBets: new Map(),
  placedBets: [],
  toasts: [],

  // Connection actions
  setConnectionStatus: status => set({ connectionStatus: status }),
  setMarketId: marketId => set({ marketId }),

  // Round actions
  handleRoundStart: payload => {
    // Clear previous round's pending bets
    set({
      currentRound: {
        marketId: payload.marketId,
        roundId: payload.roundId,
        phase: payload.phase,
        initialPrice: payload.initialPrice,
        currentPrice: payload.initialPrice,
        gridBounds: payload.gridBounds,
        config: payload.config,
        timing: payload.timing,
        hitCells: [],
        priceHistory: [],
      },
      pendingBets: new Map(),
    });

    get().addToast({
      type: "info",
      message: `Round ${payload.roundId} started - Place your bets!`,
    });
  },

  handlePhaseChange: phase => {
    const { currentRound } = get();
    if (!currentRound) return;

    set({
      currentRound: {
        ...currentRound,
        phase,
      },
    });

    if (phase === "LIVE") {
      get().addToast({
        type: "info",
        message: "Betting closed - Live phase started!",
      });
    }
  },

  handlePriceUpdate: payload => {
    const { currentRound } = get();
    if (!currentRound) return;

    const newPricePoint: PriceDataPoint = {
      price: payload.price,
      timestamp: payload.timestamp,
      source: payload.source,
    };

    set({
      currentRound: {
        ...currentRound,
        currentPrice: payload.price,
        hitCells: payload.hitCells,
        priceHistory: [...currentRound.priceHistory, newPricePoint],
        gridBounds: payload.gridBounds ?? currentRound.gridBounds,
      },
    });
  },

  handleRoundEnd: payload => {
    const { currentRound, placedBets } = get();
    if (!currentRound) return;

    // Build hit cells set for checking wins
    const hitSet = new Set(payload.hitCells.map(c => `${c.priceRangeStart}:${c.timeRangeStart}`));

    // Check placed bets for wins
    const results = placedBets.filter(bet => bet.roundId === payload.roundId);
    let totalHits = 0;
    results.forEach(bet => {
      bet.cells.forEach(cell => {
        const key = `${cell.dataRangeStart}:${cell.timeSlotStart}`;
        if (hitSet.has(key)) {
          totalHits++;
        }
      });
    });

    /* eslint-disable @typescript-eslint/no-unused-vars */
    let totalWins = 0;
    if (totalHits > 0) {
      totalWins = totalHits * get().selectedBetAmount; // Simplified calculation
      get().addToast({
        type: "success",
        message: `Round ended - ${totalHits} cells hit!`,
      });
    } else if (results.length > 0) {
      get().addToast({
        type: "error",
        message: "Round ended - No winning cells",
      });
    }

    set({
      currentRound: {
        ...currentRound,
        phase: "SETTLING",
        hitCells: payload.hitCells,
      },
      pendingBets: new Map(),
    });
  },

  // Betting actions
  setSelectedBetAmount: amount => set({ selectedBetAmount: amount }),

  toggleCellBet: cell => {
    const { pendingBets, getCellKey, currentRound, balance, selectedBetAmount } = get();
    if (!currentRound || currentRound.phase !== "BETTING") return;

    const key = getCellKey(cell);
    const newBets = new Map(pendingBets);

    if (newBets.has(key)) {
      newBets.delete(key);
    } else {
      // Check if user has enough balance
      const currentTotal = get().getTotalPendingBetAmount();
      if (currentTotal + selectedBetAmount > balance) {
        get().addToast({
          type: "error",
          message: "Insufficient balance",
        });
        return;
      }
      newBets.set(key, cell);
    }

    set({ pendingBets: newBets });
  },

  clearPendingBets: () => set({ pendingBets: new Map() }),

  confirmBets: () => {
    const { pendingBets, currentRound, selectedBetAmount, balance, placedBets } = get();
    if (!currentRound || pendingBets.size === 0) return;

    const totalAmount = get().getTotalPendingBetAmount();
    if (totalAmount > balance) {
      get().addToast({
        type: "error",
        message: "Insufficient balance",
      });
      return;
    }

    const bet: Bet = {
      id: `bet_${Date.now()}`,
      cells: Array.from(pendingBets.values()),
      amount: selectedBetAmount,
      placedAt: Date.now(),
      roundId: currentRound.roundId,
      marketId: currentRound.marketId,
    };

    set({
      placedBets: [...placedBets, bet],
      balance: balance - totalAmount,
      pendingBets: new Map(),
    });

    get().addToast({
      type: "success",
      message: `Bet placed: ${pendingBets.size} cells for $${totalAmount}`,
    });
  },

  // Balance actions
  setBalance: balance => set({ balance }),

  // UI actions
  addToast: toast => {
    const id = `toast_${Date.now()}`;
    set(state => ({
      toasts: [...state.toasts, { ...toast, id }],
    }));

    // Auto-remove after 4 seconds
    setTimeout(() => {
      get().removeToast(id);
    }, 4000);
  },

  removeToast: id =>
    set(state => ({
      toasts: state.toasts.filter(t => t.id !== id),
    })),

  // Helpers
  getCellKey: cell => `${cell.dataRangeStart}:${cell.timeSlotStart}`,

  isCellSelected: cell => {
    const key = get().getCellKey(cell);
    return get().pendingBets.has(key);
  },

  isCellHit: cell => {
    const { currentRound } = get();
    if (!currentRound) return false;

    return currentRound.hitCells.some(
      hitCell => hitCell.priceRangeStart === cell.dataRangeStart && hitCell.timeRangeStart === cell.timeSlotStart,
    );
  },

  getTotalPendingBetAmount: () => {
    const { pendingBets, selectedBetAmount } = get();
    return pendingBets.size * selectedBetAmount;
  },
}));
