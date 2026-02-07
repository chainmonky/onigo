// @ts-nocheck
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Allocation,
  AuthChallengeResponse,
  Channel,
  NitroliteClient,
  PartialEIP712AuthMessage,
  RPCMethod,
  StateIntent,
  WalletStateSigner,
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createCreateChannelMessage,
  createECDSAMessageSigner,
  createEIP712AuthMessageSigner,
  createGetLedgerBalancesMessage,
  createResizeChannelMessage,
  getStateHash,
} from "@erc7824/nitrolite";
import { Hex, formatUnits, parseUnits, recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWalletClient,
  useWriteContract,
} from "wagmi";
import { Client as YellowClient } from "yellow-ts";

// Constants
const CUSTODY_ADDRESS = "0x019B65A265EB3363822f2752141b3dF16131b262" as const;
const ADJUDICATOR_ADDRESS = "0x7c7ccbc98469190849BCC6c926307794fDfB11F2" as const;
const TOKEN_ADDRESS = "0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb" as const;
const CLEARNODE_URL = "wss://clearnet-sandbox.yellow.com/ws";
const TOKEN_DECIMALS = 6;
const REQUIRED_CHAIN_ID = 84532;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "allowance",
    type: "function",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const CUSTODY_ABI = [
  {
    name: "deposit",
    type: "function",
    inputs: [
      { name: "account", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

type DepositStep =
  | "idle"
  | "wrong-chain"
  | "checking"
  | "needs-approval"
  | "approving"
  | "approved"
  | "depositing"
  | "connecting-clearnode"
  | "authenticating"
  | "creating-channel"
  | "resizing-channel"
  | "verifying-balance"
  | "success"
  | "error";

interface DepositState {
  step: DepositStep;
  error?: string;
  approveHash?: `0x${string}`;
  depositHash?: `0x${string}`;
  channelId?: string;
  unifiedBalance?: string;
  progressMessage?: string;
}

function generateSessionKey() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address };
}

export function useYellowDeposit() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [amount, setAmount] = useState<string>("");
  const [state, setState] = useState<DepositState>({ step: "idle" });

  const yellowClientRef = useRef<YellowClient | null>(null);
  const sessionSignerRef = useRef<((payload: unknown) => Promise<Hex>) | null>(null);
  const nitroliteClientRef = useRef<NitroliteClient | null>(null);
  const isProcessingRef = useRef(false);

  const isCorrectChain = chainId === REQUIRED_CHAIN_ID;

  useEffect(() => {
    return () => {
      yellowClientRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (address && !isCorrectChain && state.step === "idle") {
      setState({ step: "wrong-chain", error: `Please switch to Base Sepolia (Chain ID: ${REQUIRED_CHAIN_ID})` });
    } else if (address && isCorrectChain && state.step === "wrong-chain") {
      setState({ step: "idle" });
    }
  }, [chainId, isCorrectChain, address, state.step]);

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && isCorrectChain },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, CUSTODY_ADDRESS] : undefined,
    query: { enabled: !!address && isCorrectChain },
  });

  const {
    writeContract: writeApprove,
    data: approveHash,
    error: approveError,
    isPending: isApprovePending,
    reset: resetApprove,
  } = useWriteContract();
  const { isSuccess: isApproveSuccess, isLoading: isApproveConfirming } = useWaitForTransactionReceipt({
    hash: approveHash,
  });

  const {
    writeContract: writeDeposit,
    data: depositHash,
    error: depositError,
    isPending: isDepositPending,
    reset: resetDeposit,
  } = useWriteContract();
  const { isSuccess: isDepositSuccess, isLoading: isDepositConfirming } = useWaitForTransactionReceipt({
    hash: depositHash,
  });

  useEffect(() => {
    if (isApproveSuccess && state.step === "approving" && approveHash) {
      setState(prev => ({ ...prev, step: "approved", approveHash }));
      refetchAllowance();
    }
  }, [isApproveSuccess, state.step, approveHash, refetchAllowance]);
      const connectClearNode = useCallback(async () => {
    if (!address || !walletClient) throw new Error("Wallet not connected");
    if (!isCorrectChain) throw new Error(`Wrong chain. Please switch to Base Sepolia (${REQUIRED_CHAIN_ID})`);

    setState({ step: "connecting-clearnode", progressMessage: "Connecting to Yellow Network..." });

    console.log("=== Yellow Network Connection ===");
    console.log("User address:", address);
    console.log("Chain ID:", chainId);

          const sessionKey = generateSessionKey();
          // @ts-ignore
    sessionSignerRef.current = createECDSAMessageSigner(sessionKey.privateKey) as (payload: unknown) => Promise<Hex>;

    console.log("Session key (for RPC only):", sessionKey.address);
    const yellow = new YellowClient({ url: CLEARNODE_URL });
    yellowClientRef.current = yellow;

    await yellow.connect();
    console.log("🔌 Connected to Yellow clearnet");

    nitroliteClientRef.current = new NitroliteClient({
      walletClient: walletClient as any,
      publicClient: publicClient as any,
      stateSigner: new WalletStateSigner(walletClient as any),
      addresses: { custody: CUSTODY_ADDRESS, adjudicator: ADJUDICATOR_ADDRESS },
      chainId: REQUIRED_CHAIN_ID,
      challengeDuration: 3600n,
    });

    console.log("✓ Nitrolite client initialized with user wallet");

    yellow.listen(async (message: any) => {
      console.log("Received:", message.method);

      switch (message.method) {
        case RPCMethod.AuthChallenge: {
          console.log("🔐 Received auth challenge");

          const sessionExpireTimestamp = BigInt(Math.floor(Date.now() / 1000) + 3600);

          const authParams: PartialEIP712AuthMessage = {
            scope: "test.app",
            session_key: sessionKey.address as `0x${string}`,
            expires_at: BigInt(sessionExpireTimestamp),
            allowances: [{ asset: "ytest.usd", amount: amount || "0" }],
          };

          const eip712Signer = createEIP712AuthMessageSigner(walletClient as any, authParams, { name: "onigo" });

          const authVerifyMessage = await createAuthVerifyMessage(eip712Signer, message as AuthChallengeResponse);

          yellow.sendMessage(authVerifyMessage);
          break;
        }

        case RPCMethod.AuthVerify:
          if (message.params?.success) {
            console.log("✅ Authentication successful");
            setState({ step: "creating-channel", progressMessage: "Creating payment channel..." });

            const createChannelMessage = await createCreateChannelMessage(sessionSignerRef.current!, {
              chain_id: REQUIRED_CHAIN_ID,
              token: TOKEN_ADDRESS as Hex,
            });

            console.log("📤 Creating channel...");
            yellow.sendMessage(createChannelMessage);
          } else {
            console.error("❌ Authentication failed:", message.params);
            setState({ step: "error", error: "Authentication failed" });
            isProcessingRef.current = false;
          }
          break;

        case RPCMethod.CreateChannel: {
          console.log("🧬 Channel created successfully!");

          console.log("Participants:", message.params.channel.participants, message.params);

          if (message.params.channel.participants[0].toLowerCase() !== address.toLowerCase()) {
            console.error("❌ Channel participant mismatch!");
            console.error("Expected:", address);
            console.error("Got:", message.params.channel.participants[0]);
            setState({
              step: "error",
              error: "Channel participant mismatch - session key used instead of wallet address",
            });
            isProcessingRef.current = false;
            return;
          }

          try {
            const stateHash = getStateHash(message.params.channelId as Hex, {
              intent: message.params.state.intent as StateIntent,
              version: BigInt(message.params.state.version),
              data: message.params.state.stateData as Hex,
              allocations: message.params.state.allocations as Allocation[],
            });

            console.log("State hash:", stateHash);
            const serverSigner = await recoverMessageAddress({
              message: { raw: stateHash },
              signature: message.params.serverSignature as Hex,
            });
            console.log("Recovered server signer:", serverSigner);

            // NitroliteClient will use the ACTUAL WALLET to sign (via WalletStateSigner)
            const { channelId, txHash } = await nitroliteClientRef.current!.createChannel({
              channel: message.params.channel as unknown as Channel,
              unsignedInitialState: {
                intent: message.params.state.intent as StateIntent,
                version: BigInt(message.params.state.version),
                data: message.params.state.stateData as Hex,
                allocations: message.params.state.allocations as Allocation[],
              },

              serverSignature: message.params.serverSignature as Hex,
            });

            console.log(`🧬 Channel ${channelId} created (tx: ${txHash})`);

            await new Promise(r => setTimeout(r, 5000));
            setState({ step: "resizing-channel", channelId, progressMessage: "Allocating funds..." });

            const amountBigInt = parseUnits(amount, TOKEN_DECIMALS);
            const resizeMessage = await createResizeChannelMessage(sessionSignerRef.current!, {
              channel_id: channelId as Hex,
              resize_amount: amountBigInt,
              funds_destination: address as Hex,
            });

            yellow.sendMessage(resizeMessage);
          } catch (error: any) {
            console.error("Channel creation failed:", error);
            console.error("Error details:", {
              message: error.message,
              cause: error.cause,
            });
            setState({ step: "error", error: error.message || "Failed to create channel" });
            isProcessingRef.current = false;
          }
          break;
        }

        case RPCMethod.ResizeChannel: {
          console.log("✅ Resize approved by server");

          try {
            const resizeState = {
              channelId: message.params.channelId as Hex,
              serverSignature: message.params.serverSignature as Hex,
              intent: message.params.state.intent as StateIntent,
              version: BigInt(message.params.state.version),
              data: message.params.state.stateData as Hex,
              allocations: message.params.state.allocations as Allocation[],
            };
            let proofStates: any[] = [];
            try {
              const onChainData = await nitroliteClientRef.current!.getChannelData(message.params.channelId as Hex);
              if (onChainData.lastValidState) {
                proofStates = [onChainData.lastValidState];
                console.log("✓ Using proof state from on-chain data");
              }
            } catch (e: any) {
              console.log("No previous state");
            }

            const { txHash } = await nitroliteClientRef.current!.resizeChannel({
              resizeState: resizeState as any,
              proofStates,
            });

            console.log(`✓ Resize tx: ${txHash}`);
            await new Promise(r => setTimeout(r, 5000));

            setState({ step: "verifying-balance", progressMessage: "Verifying balance..." });
            const balMessage = await createGetLedgerBalancesMessage(sessionSignerRef.current!);
            yellow.sendMessage(balMessage);
          } catch (error: any) {
            console.error("Resize failed:", error);
            setState({ step: "error", error: error.message || "Resize failed" });
            isProcessingRef.current = false;
          }
          break;
        }

        case RPCMethod.GetLedgerBalances: {
          const balances = message.params?.ledger_balances || message.params?.balances || [];
          const yUSDEntry = balances.find(
            (b: any) =>
              b.asset.toLowerCase().includes("yusd") ||
              b.asset.toLowerCase().includes("ytest") ||
              b.asset.toLowerCase() === TOKEN_ADDRESS.toLowerCase(),
          );

          const unifiedBalance = yUSDEntry ? formatUnits(BigInt(yUSDEntry.amount), TOKEN_DECIMALS) : "0";

          console.log("✓ Unified balance:", unifiedBalance);

          await yellow.disconnect();
          setState({
            step: "success",
            unifiedBalance,
            progressMessage: "Complete!",
          });
          isProcessingRef.current = false;
          refetchBalance();
          refetchAllowance();
          break;
        }

        case RPCMethod.Error:
          console.error("❌ Error:", message.params);
          setState({
            step: "error",
            error: message.params?.error || "Operation failed",
          });
          isProcessingRef.current = false;
          break;
      }
    });

    // Send auth request (CRITICAL: use USER ADDRESS, not session key)
    setState({ step: "authenticating", progressMessage: "Authenticating..." });

    const sessionExpireTimestamp = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const authMessage = await createAuthRequestMessage({
      address: address as Hex, // USER ADDRESS (not session key)
      session_key: sessionKey.address as Hex, // Session key for delegation
      application: "onigo",
      allowances: [{ asset: "ytest.usd", amount: amount || "0" }],
      expires_at: sessionExpireTimestamp,
      scope: "test.app",
    });

    console.log("📤 Sending auth request...");
    console.log("   Address:", address);
    console.log("   Session key:", sessionKey.address);
    yellow.sendMessage(authMessage);
  }, [address, walletClient, publicClient, isCorrectChain, chainId, amount, refetchBalance, refetchAllowance]);


    
      const startClearNodeFlow = useCallback(
    async (depositHash: string) => {
      try {
        console.log("=== Starting ClearNode Flow ===");
        await connectClearNode();
      } catch (error) {
        console.error("ClearNode flow error:", error);
        yellowClientRef.current?.disconnect();
        setState({
          step: "error",
          error: error instanceof Error ? error.message : "Failed",
        });
        isProcessingRef.current = false;
      }
    },
    [connectClearNode],
  );

  useEffect(() => {
    if (isDepositSuccess && state.step === "depositing" && depositHash && !isProcessingRef.current) {
      isProcessingRef.current = true;
      setState(prev => ({ ...prev, step: "connecting-clearnode", depositHash }));
      setTimeout(() => startClearNodeFlow(depositHash), 5000);
    }
  }, [isDepositSuccess, state.step, depositHash,startClearNodeFlow]);

  useEffect(() => {
    if (approveError && state.step === "approving") {
      setState({ step: "error", error: approveError.message || "Approval failed" });
    }
  }, [approveError, state.step]);

  useEffect(() => {
    if (depositError && state.step === "depositing") {
      setState({ step: "error", error: depositError.message || "Deposit failed" });
    }
  }, [depositError, state.step]);




  const checkAndApprove = useCallback(() => {
    if (!address || !amount || !isCorrectChain) {
      setState({
        step: "error",
        error: !isCorrectChain ? "Wrong chain" : "Missing address or amount",
      });
      return;
    }
    const amountBigInt = parseUnits(amount, TOKEN_DECIMALS);
    setState({ step: "approving" });
    writeApprove({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CUSTODY_ADDRESS, amountBigInt],
    });
  }, [address, amount, isCorrectChain, writeApprove]);

  const deposit = useCallback(() => {
    if (!address || !amount || !isCorrectChain) {
      setState({
        step: "error",
        error: !isCorrectChain ? "Wrong chain" : "Missing address or amount",
      });
      return;
    }
    const amountBigInt = parseUnits(amount, TOKEN_DECIMALS);
    setState({ step: "depositing" });
    writeDeposit({
      address: CUSTODY_ADDRESS,
      abi: CUSTODY_ABI,
      functionName: "deposit",
      args: [address, TOKEN_ADDRESS, amountBigInt],
    });
  }, [address, amount, isCorrectChain, writeDeposit]);

  const reset = useCallback(() => {
    yellowClientRef.current?.disconnect();
    yellowClientRef.current = null;
    sessionSignerRef.current = null;
    nitroliteClientRef.current = null;
    isProcessingRef.current = false;
    setState({ step: isCorrectChain ? "idle" : "wrong-chain" });
    setAmount("");
    resetApprove();
    resetDeposit();
    refetchBalance();
    refetchAllowance();
  }, [isCorrectChain, resetApprove, resetDeposit, refetchBalance, refetchAllowance]);

  const switchToCorrectChain = useCallback(async () => {
    try {
      await switchChain({ chainId: REQUIRED_CHAIN_ID });
    } catch (error) {
      setState({ step: "error", error: "Failed to switch network" });
    }
  }, [switchChain]);

  return {
    amount,
    setAmount,
    balance: balance ? formatUnits(balance, TOKEN_DECIMALS) : "0",
    allowance: allowance || 0n,
    state,
    isCorrectChain,
    chainId,
    requiredChainId: REQUIRED_CHAIN_ID,
    checkAndApprove,
    deposit,
    reset,
    switchToCorrectChain,
    isLoading:
      isApprovePending ||
      isApproveConfirming ||
      isDepositPending ||
      isDepositConfirming ||
      ["connecting-clearnode", "authenticating", "creating-channel", "resizing-channel", "verifying-balance"].includes(
        state.step,
      ),
  };
}
