"use client";

import { useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Address } from "@scaffold-ui/components";
import { AnimatePresence, motion } from "framer-motion";
import { useDisconnect } from "wagmi";
import { useOutsideClick } from "~~/hooks/scaffold-eth";
import { cn } from "~~/lib/utils";

export function WalletStatus() {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { disconnect } = useDisconnect();

  useOutsideClick(dropdownRef, () => setIsDropdownOpen(false));

  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, openChainModal, mounted }) => {
        const connected = mounted && account && chain;

        if (!connected) {
          return (
            <motion.button
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg",
                "bg-gradient-to-r from-[#20E3B2]/20 to-[#20E3B2]/10",
                "border border-[#20E3B2]/50",
                "text-[#20E3B2] font-semibold text-sm",
                "hover:from-[#20E3B2]/30 hover:to-[#20E3B2]/20",
                "hover:border-[#20E3B2]/70",
                "transition-all duration-200",
                "shadow-[0_0_10px_rgba(32,227,178,0.2)]",
                "hover:shadow-[0_0_15px_rgba(32,227,178,0.4)]",
              )}
              onClick={openConnectModal}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              <span className="font-[family-name:var(--font-share-tech-orbitron)] tracking-wider">Connect Wallet</span>
            </motion.button>
          );
        }

        // if (isOnWrongNetwork) {
        //   return (
        //     <motion.button
        //       className={cn(
        //         "flex items-center gap-2 px-4 py-2 rounded-lg",
        //         "bg-red-500/20 border border-red-500/50",
        //         "text-red-400 font-semibold text-sm",
        //         "hover:bg-red-500/30",
        //         "transition-all duration-200",
        //       )}
        //       onClick={openChainModal}
        //       whileHover={{ scale: 1.02 }}
        //       whileTap={{ scale: 0.98 }}
        //     >
        //       <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
        //       <span className="font-[family-name:var(--font-share-tech-orbitron)]">
        //         Switch to {targetNetwork.name}
        //       </span>
        //     </motion.button>
        //   );
        // }

        return (
          <div className="relative" ref={dropdownRef}>
            <motion.button
              className={cn(
                "flex items-center gap-3 px-5 py-1 rounded-lg",
                "bg-gray-800/50 border border-[#20E3B2]/30",
                "hover:border-[#20E3B2]/60",
                "transition-all duration-200",
              )}
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
            >
              {/* Address */}
              <div className="flex flex-col items-start">
                <span className="font-[family-name:var(--font-share-tech-orbitron)] text-[#20E3B2] text-sm tracking-wider">
                  {account.displayName}
                </span>
                <span className="text-[10px] text-gray-500">{chain.name}</span>
              </div>

              {/* Dropdown arrow */}
              <motion.svg
                className="w-4 h-4 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                animate={{ rotate: isDropdownOpen ? 180 : 0 }}
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </motion.svg>
            </motion.button>

            {/* Dropdown menu */}
            <AnimatePresence>
              {isDropdownOpen && (
                <motion.div
                  className={cn(
                    "absolute right-0 mt-2 w-64 rounded-xl overflow-hidden",
                    "bg-gray-900/95 backdrop-blur-md",
                    "border border-[#20E3B2]/30",
                    "shadow-[0_0_20px_rgba(32,227,178,0.15)]",
                    "z-50",
                  )}
                  initial={{ opacity: 0, y: -10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -10, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                >
                  {/* Header */}
                  <div className="px-4 py-3 border-b border-gray-700/50">
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Connected Wallet</p>
                    <div className="flex items-center gap-2">
                      <Address address={account.address as `0x${string}`} format="short" />
                    </div>
                  </div>

                  {/* Network info */}
                  <div className="px-4 py-3 border-b border-gray-700/50">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-500">Network</span>
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-[#20E3B2]" />
                        <span className="text-sm text-gray-300">{chain.name}</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="p-2 space-y-1">
                    <button
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 rounded-lg",
                        "text-gray-300 hover:bg-gray-700/50",
                        "transition-colors duration-150",
                      )}
                      onClick={() => {
                        openChainModal();
                        setIsDropdownOpen(false);
                      }}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                        />
                      </svg>
                      <span className="text-sm">Switch Network</span>
                    </button>
                    <button
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 rounded-lg",
                        "text-red-400 hover:bg-red-500/10",
                        "transition-colors duration-150",
                      )}
                      onClick={() => {
                        disconnect();
                        setIsDropdownOpen(false);
                      }}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                        />
                      </svg>
                      <span className="text-sm">Disconnect</span>
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
