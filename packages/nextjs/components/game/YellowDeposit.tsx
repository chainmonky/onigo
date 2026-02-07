"use client";

import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, ArrowDownCircle, CheckCircle2, Layers, Loader2, Shield, Wallet, Zap } from "lucide-react";
import { useAccount, useConnect } from "wagmi";
import { injected } from "wagmi/connectors";
import { Badge } from "~~/components/ui/badge";
import { Button } from "~~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~~/components/ui/card";
import { Input } from "~~/components/ui/input";
import { useYellowDeposit } from "~~/hooks/useYellowDeposit";

// Yellow Network Deposit Component
export default function YellowDepositCard() {
  const { isConnected } = useAccount();
  const { connect } = useConnect();
  const { amount, setAmount, balance, state, checkAndApprove, deposit, reset, isLoading, isCorrectChain } =
    useYellowDeposit();
  // In YellowDepositCard component, add this after the connect wallet check:

  if (isConnected && !isCorrectChain) {
    return (
      <Card className="bg-base-100 border-error/20 shadow-lg shadow-error/5">
        <CardContent className="p-6">
          <div className="text-center space-y-4">
            <div className="w-12 h-12 mx-auto rounded-full bg-error/10 flex items-center justify-center">
              <AlertCircle className="w-6 h-6 text-error" />
            </div>
            <div>
              <h3 className="font-semibold text-base-content">Wrong Network</h3>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }
  if (!isConnected) {
    return (
      <Card className="bg-base-100 border-primary/20 shadow-lg shadow-primary/5">
        <CardContent className="p-6">
          <div className="text-center space-y-4">
            <div className="w-12 h-12 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
              <Wallet className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-base-content">Connect Wallet</h3>
              <p className="text-sm text-base-content/60 mt-1">Connect to deposit funds to Yellow Network</p>
            </div>
            <Button
              onClick={() => connect({ connector: injected() })}
              className="w-full bg-primary hover:bg-primary/90"
            >
              <Wallet className="w-4 h-4 mr-2" />
              Connect Wallet
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const getStepIcon = () => {
    switch (state.step) {
      case "approving":
      case "depositing":
      case "connecting-clearnode":
      case "authenticating":
      case "creating-channel":
      case "resizing-channel":
      case "verifying-balance":
        return <Loader2 className="w-4 h-4 animate-spin" />;
      case "success":
        return <CheckCircle2 className="w-4 h-4 text-success" />;
      case "error":
        return <AlertCircle className="w-4 h-4 text-error" />;
      default:
        return <ArrowDownCircle className="w-4 h-4" />;
    }
  };

  const getButtonText = () => {
    switch (state.step) {
      case "idle":
      case "needs-approval":
        return "1. Approve yUSD";
      case "approving":
        return "Approving...";
      case "approved":
        return "2. Deposit to Custody";
      case "depositing":
        return "Depositing...";
      case "connecting-clearnode":
        return "Connecting...";
      case "authenticating":
        return "Authenticating...";
      case "creating-channel":
        return "Creating Channel...";
      case "resizing-channel":
        return "Allocating Funds...";
      case "verifying-balance":
        return "Verifying...";
      case "success":
        return "Complete!";
      case "error":
        return "Try Again";
      default:
        return "Deposit";
    }
  };

  const isSuccess = state.step === "success";
  const showInput = !isSuccess;

  return (
    <Card className="bg-base-100 border-primary/20 shadow-lg shadow-primary/5 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            Yellow Network Deposit
          </CardTitle>
          {isSuccess && (
            <Badge variant="outline" className="bg-success/20 text-success border-success/30">
              Active
            </Badge>
          )}
        </div>
        <p className="text-xs text-base-content/60">Deposit yUSD for instant, gasless gameplay</p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Balance Display */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-base-200/50">
          <span className="text-sm text-base-content/60">Wallet Balance</span>
          <span className="font-mono font-medium">
            {parseFloat(balance).toFixed(2)} <span className="text-xs text-base-content/60">yUSD</span>
          </span>
        </div>

        {/* Unified Balance (after success) */}
        <AnimatePresence>
          {isSuccess && state.unifiedBalance && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="p-3 rounded-lg bg-success/10 border border-success/20"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm text-success flex items-center gap-2">
                  <Shield className="w-4 h-4" />
                  Unified Balance
                </span>
                <span className="font-mono font-bold text-success">
                  {parseFloat(state.unifiedBalance).toFixed(2)} yUSD
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Input Section */}
        {showInput && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-base-content/60">Amount</label>
              <button
                onClick={() => setAmount(balance)}
                className="text-xs text-primary hover:text-primary/80 transition-colors"
              >
                Max
              </button>
            </div>
            <div className="relative">
              <Input
                type="number"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="10"
                disabled={isLoading}
                className="bg-base-200 border-base-300 pr-12 font-mono"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-base-content/40">yUSD</span>
            </div>
          </div>
        )}

        {/* Progress Steps */}
        {isLoading && state.step !== "approving" && state.step !== "depositing" && (
          <div className="space-y-2 p-3 rounded-lg bg-base-200/30">
            <div className="flex items-center gap-2 text-xs">
              <Layers className="w-3 h-3 text-primary" />
              <span className="text-base-content/60">Progress</span>
            </div>
            <div className="space-y-1">
              {[
                { key: "depositing", label: "On-chain Deposit", done: !!state.depositHash },
                {
                  key: "authenticating",
                  label: "Connect Yellow",
                  done: ["creating-channel", "resizing-channel", "verifying-balance", "success"].includes(state.step),
                },
                {
                  key: "creating-channel",
                  label: "Create Channel",
                  done: ["resizing-channel", "verifying-balance", "success"].includes(state.step),
                },
                {
                  key: "resizing-channel",
                  label: "Allocate Funds",
                  done: ["verifying-balance", "success"].includes(state.step),
                },
                { key: "verifying-balance", label: "Verify Balance", done: state.step === "success" },
              ].map(step => (
                <div key={step.key} className="flex items-center gap-2">
                  <div
                    className={`w-1.5 h-1.5 rounded-full ${
                      step.done ? "bg-success" : state.step === step.key ? "bg-primary animate-pulse" : "bg-base-300"
                    }`}
                  />
                  <span
                    className={`text-xs ${
                      step.done ? "text-success" : state.step === step.key ? "text-primary" : "text-base-content/40"
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Transaction Links */}
        {(state.approveHash || state.depositHash) && (
          <div className="flex flex-wrap gap-2">
            {state.approveHash && (
              <a
                href={`https://sepolia.basescan.org/tx/${state.approveHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline flex items-center gap-1"
              >
                Approval ↗
              </a>
            )}
            {state.depositHash && (
              <a
                href={`https://sepolia.basescan.org/tx/${state.depositHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline flex items-center gap-1"
              >
                Deposit ↗
              </a>
            )}
          </div>
        )}

        {/* Error Message */}
        {state.step === "error" && (
          <div className="p-3 rounded-lg bg-error/10 border border-error/20 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
            <p className="text-xs text-error">{state.error}</p>
          </div>
        )}

        {/* Action Button */}
        <Button
          onClick={
            state.step === "error"
              ? reset
              : state.step === "approved"
                ? deposit
                : state.step === "success"
                  ? reset
                  : checkAndApprove
          }
          disabled={
            (!amount || parseFloat(amount) <= 0 || isLoading) && state.step !== "error" && state.step !== "success"
          }
          className={`w-full ${isSuccess ? "bg-success hover:bg-success/90" : "bg-primary hover:bg-primary/90"}`}
        >
          {getStepIcon()}
          <span className="ml-2">{getButtonText()}</span>
        </Button>

        {/* Success Message */}
        {isSuccess && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="text-center space-y-2">
            <p className="text-sm text-success">🎉 Funds ready for instant gameplay!</p>
            <p className="text-xs text-base-content/60">No gas fees for future bets</p>
          </motion.div>
        )}
      </CardContent>
    </Card>
  );
}
