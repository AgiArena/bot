/**
 * Setup CollateralVault Script
 *
 * This script configures the CollateralVault contract:
 * 1. Sets the KeeperRegistry address for BLS signature verification
 *
 * Run after deploying contracts, before testing arbitration.
 */

import { createWalletClient, createPublicClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Chain config
const RPC_URL = process.env.RPC_URL || "http://localhost:33010";
const CHAIN_ID = 111222333;

// Contract addresses (VPS2 deployment 2026-02-03)
const COLLATERAL_VAULT_ADDRESS = "0xE8f29Ab983F547CeA70cD73de06ff490C6F5903f" as const;
const KEEPER_REGISTRY_ADDRESS = "0xE80FB0E8974EFE237fEf83B0df470664fc51fa99" as const;

// Admin account (used for contract setup)
// Using dev1 as deployer/admin
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY ||
  "0x3ab8db6b8d1da0f5ebb92e6ede820ab85f78e5c43d3cbb9b56b8c3be8da50a49"; // dev1

// ABIs
const COLLATERAL_VAULT_ABI = [
  {
    name: "setKeeperRegistry",
    type: "function",
    inputs: [{ name: "_keeperRegistry", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "keeperRegistry",
    type: "function",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
] as const;

// Chain definition
const indexL3 = {
  id: CHAIN_ID,
  name: "Index L3",
  nativeCurrency: { name: "IND", symbol: "IND", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

async function main() {
  console.log("=== CollateralVault Setup Script ===\n");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`CollateralVault: ${COLLATERAL_VAULT_ADDRESS}`);
  console.log(`KeeperRegistry: ${KEEPER_REGISTRY_ADDRESS}\n`);

  const publicClient = createPublicClient({
    chain: indexL3,
    transport: http(RPC_URL),
  });

  // Check chain connection
  const chainId = await publicClient.getChainId();
  console.log(`Connected to chain: ${chainId}`);

  // Check current KeeperRegistry setting
  const currentKeeperRegistry = await publicClient.readContract({
    address: COLLATERAL_VAULT_ADDRESS,
    abi: COLLATERAL_VAULT_ABI,
    functionName: "keeperRegistry",
  });

  console.log(`\nCurrent KeeperRegistry: ${currentKeeperRegistry}`);

  if (currentKeeperRegistry !== "0x0000000000000000000000000000000000000000") {
    console.log("KeeperRegistry already set!");

    if (getAddress(currentKeeperRegistry) === getAddress(KEEPER_REGISTRY_ADDRESS)) {
      console.log("✓ Correctly configured to KeeperRegistry");
    } else {
      console.log("⚠ Warning: Different KeeperRegistry address than expected!");
      console.log(`  Expected: ${KEEPER_REGISTRY_ADDRESS}`);
      console.log(`  Actual:   ${currentKeeperRegistry}`);
    }
    return;
  }

  // Set KeeperRegistry
  console.log("\nSetting KeeperRegistry...");

  const account = privateKeyToAccount(ADMIN_PRIVATE_KEY as `0x${string}`);
  console.log(`Using admin account: ${account.address}`);

  const walletClient = createWalletClient({
    account,
    chain: indexL3,
    transport: http(RPC_URL),
  });

  try {
    const setTx = await walletClient.writeContract({
      address: COLLATERAL_VAULT_ADDRESS,
      abi: COLLATERAL_VAULT_ABI,
      functionName: "setKeeperRegistry",
      args: [KEEPER_REGISTRY_ADDRESS],
    });

    console.log(`Transaction: ${setTx}`);
    await publicClient.waitForTransactionReceipt({ hash: setTx });

    // Verify
    const newKeeperRegistry = await publicClient.readContract({
      address: COLLATERAL_VAULT_ADDRESS,
      abi: COLLATERAL_VAULT_ABI,
      functionName: "keeperRegistry",
    });

    console.log(`\n✓ KeeperRegistry set to: ${newKeeperRegistry}`);
    console.log("\nCollateralVault is now configured for arbitration!");
  } catch (error) {
    console.error(`\nError setting KeeperRegistry: ${(error as Error).message}`);
    process.exit(1);
  }
}

main().catch(console.error);
