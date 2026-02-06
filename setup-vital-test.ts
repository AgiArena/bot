/**
 * Setup Vital Test - Register bots and fund collateral
 */

import { createWalletClient, createPublicClient, http, parseEther, formatEther, encodeFunctionData, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Chain config - using nginx
const RPC_URL = process.env.RPC_URL || "http://116.203.156.98/rpc";
const CHAIN_ID = 111222333;

// Contract addresses (VPS2 deployment 2026-02-03)
const WIND_ADDRESS = "0x4e5b65FB12d4165E22f5861D97A33BA45c006114" as const;
const BOT_REGISTRY_ADDRESS = "0x9dF23e34ac13A7145ebA1164660E701839197B1b" as const;
const COLLATERAL_VAULT_ADDRESS = "0xE8f29Ab983F547CeA70cD73de06ff490C6F5903f" as const;

// Bots to register (dev2 and dev3)
const BOTS = [
  {
    name: "Bot1 (dev2)",
    privateKey: "0x203298e6a2b845c6dde179f3f991ae4c081ad963e20c9fe39d45893c00a0aea5" as const,
    endpoint: "http://127.0.0.1:6001",
    pubkeyHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
  },
  {
    name: "Bot2 (dev3)",
    privateKey: "0x237112963af91b42ca778fbe434a819b7e862cd025be3c86ce453bdd3e633165" as const,
    endpoint: "http://127.0.0.1:6002",
    pubkeyHash: "0x0000000000000000000000000000000000000000000000000000000000000002",
  },
];

// Amount to wrap/stake
const STAKE_AMOUNT = parseEther("100");
const COLLATERAL_AMOUNT = parseEther("10");

// ABIs
const WIND_ABI = [
  { name: "deposit", type: "function", inputs: [], outputs: [], stateMutability: "payable" },
  { name: "approve", type: "function", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const BOT_REGISTRY_ABI = [
  { name: "registerBot", type: "function", inputs: [{ name: "endpoint", type: "string" }, { name: "pubkeyHash", type: "bytes32" }], outputs: [], stateMutability: "nonpayable" },
  { name: "isActive", type: "function", inputs: [{ name: "bot", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { name: "getActiveBotCount", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const COLLATERAL_VAULT_ABI = [
  { name: "deposit", type: "function", inputs: [{ name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { name: "getAvailableBalance", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const indexL3 = {
  id: CHAIN_ID,
  name: "Index L3",
  nativeCurrency: { name: "IND", symbol: "IND", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

async function main() {
  console.log("=== Vital Test Setup ===\n");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`WIND: ${WIND_ADDRESS}`);
  console.log(`BotRegistry: ${BOT_REGISTRY_ADDRESS}`);
  console.log(`CollateralVault: ${COLLATERAL_VAULT_ADDRESS}\n`);

  const publicClient = createPublicClient({
    chain: indexL3,
    transport: http(RPC_URL),
  });

  const chainId = await publicClient.getChainId();
  console.log(`Connected to chain: ${chainId}\n`);

  for (const bot of BOTS) {
    const account = privateKeyToAccount(bot.privateKey);
    console.log(`\n--- ${bot.name}: ${account.address} ---`);

    const walletClient = createWalletClient({
      account,
      chain: indexL3,
      transport: http(RPC_URL),
    });

    // Check native balance
    const nativeBalance = await publicClient.getBalance({ address: account.address });
    console.log(`  IND balance: ${formatEther(nativeBalance)}`);

    // Check WIND balance
    let windBalance = await publicClient.readContract({
      address: WIND_ADDRESS,
      abi: WIND_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });
    console.log(`  WIND balance: ${formatEther(windBalance)}`);

    // Wrap IND to WIND if needed
    const needed = STAKE_AMOUNT + COLLATERAL_AMOUNT;
    if (windBalance < needed) {
      const wrapAmount = needed - windBalance + parseEther("1");
      console.log(`  Wrapping ${formatEther(wrapAmount)} IND to WIND...`);

      const wrapTx = await walletClient.sendTransaction({
        to: WIND_ADDRESS,
        value: wrapAmount,
        data: encodeFunctionData({ abi: WIND_ABI, functionName: "deposit" }),
      });
      await publicClient.waitForTransactionReceipt({ hash: wrapTx });
      console.log(`  Wrapped! TX: ${wrapTx.slice(0, 18)}...`);

      windBalance = await publicClient.readContract({
        address: WIND_ADDRESS,
        abi: WIND_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
    }

    // Check if already registered
    const isRegistered = await publicClient.readContract({
      address: BOT_REGISTRY_ADDRESS,
      abi: BOT_REGISTRY_ABI,
      functionName: "isActive",
      args: [account.address],
    });

    if (!isRegistered) {
      // Approve BotRegistry
      console.log(`  Approving BotRegistry for stake...`);
      const approveTx = await walletClient.writeContract({
        address: WIND_ADDRESS,
        abi: WIND_ABI,
        functionName: "approve",
        args: [BOT_REGISTRY_ADDRESS, STAKE_AMOUNT],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });

      // Register bot
      console.log(`  Registering bot...`);
      try {
        const registerTx = await walletClient.writeContract({
          address: BOT_REGISTRY_ADDRESS,
          abi: BOT_REGISTRY_ABI,
          functionName: "registerBot",
          args: [bot.endpoint, bot.pubkeyHash as `0x${string}`],
        });
        await publicClient.waitForTransactionReceipt({ hash: registerTx });
        console.log(`  ✓ Bot registered! TX: ${registerTx.slice(0, 18)}...`);
      } catch (error) {
        console.log(`  ⚠️ Registration failed: ${(error as Error).message}`);
      }
    } else {
      console.log(`  Already registered in BotRegistry`);
    }

    // Check collateral balance
    const collateralBalance = await publicClient.readContract({
      address: COLLATERAL_VAULT_ADDRESS,
      abi: COLLATERAL_VAULT_ABI,
      functionName: "getAvailableBalance",
      args: [account.address],
    });
    console.log(`  Collateral balance: ${formatEther(collateralBalance)}`);

    // Deposit collateral if needed
    if (collateralBalance < COLLATERAL_AMOUNT) {
      console.log(`  Approving CollateralVault...`);
      const approveTx = await walletClient.writeContract({
        address: WIND_ADDRESS,
        abi: WIND_ABI,
        functionName: "approve",
        args: [COLLATERAL_VAULT_ADDRESS, COLLATERAL_AMOUNT],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });

      console.log(`  Depositing ${formatEther(COLLATERAL_AMOUNT)} WIND collateral...`);
      try {
        const depositTx = await walletClient.writeContract({
          address: COLLATERAL_VAULT_ADDRESS,
          abi: COLLATERAL_VAULT_ABI,
          functionName: "deposit",
          args: [COLLATERAL_AMOUNT],
        });
        await publicClient.waitForTransactionReceipt({ hash: depositTx });
        console.log(`  ✓ Collateral deposited! TX: ${depositTx.slice(0, 18)}...`);
      } catch (error) {
        console.log(`  ⚠️ Deposit failed: ${(error as Error).message}`);
      }
    } else {
      console.log(`  Sufficient collateral already deposited`);
    }
  }

  // Final status
  console.log("\n=== Final Status ===");
  const botCount = await publicClient.readContract({
    address: BOT_REGISTRY_ADDRESS,
    abi: BOT_REGISTRY_ABI,
    functionName: "getActiveBotCount",
  });
  console.log(`Active bots: ${botCount}`);
}

main().catch(console.error);
