/**
 * Rotate Keeper BLS Keys Script
 *
 * This script rotates all keeper BLS keys from old 64-byte G1 to new 128-byte G2 format.
 *
 * Process:
 * 1. Each keeper calls requestKeyRotation with their new G2 pubkey
 * 2. Admin calls forceKeyRotation for each keeper (dev/test shortcut)
 */

import { createWalletClient, createPublicClient, http, parseEther, formatEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Chain config
const RPC_URL = process.env.RPC_URL || "http://localhost:33010";
const CHAIN_ID = 111222333;

// Contract addresses
const KEEPER_REGISTRY_ADDRESS = "0xE80FB0E8974EFE237fEf83B0df470664fc51fa99" as const;

// Keeper private keys (dev3, dev4, dev5)
const KEEPER_KEYS = [
  "0x237112963af91b42ca778fbe434a819b7e862cd025be3c86ce453bdd3e633165", // dev3
  "0xdbd4bf6a5edb48b1819a2e94920c156ff8296670d5df72e4b8a22df0b6ce573d", // dev4
  "0xae804cd43a8471813628b123189674469b92e3874674e540b9567e9e986d394d", // dev5
];

const KEEPER_INSTANCE_IDS = ["keeper1", "keeper2", "keeper3"];

// Admin key (dev1 - deployer)
const ADMIN_PRIVATE_KEY = "0x3ab8db6b8d1da0f5ebb92e6ede820ab85f78e5c43d3cbb9b56b8c3be8da50a49";

// ABIs
const KEEPER_REGISTRY_ABI = [
  {
    name: "requestKeyRotation",
    type: "function",
    inputs: [{ name: "newPubkey", type: "bytes" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "forceKeyRotation",
    type: "function",
    inputs: [{ name: "keeper", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "keepers",
    type: "function",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [
      { name: "addr", type: "address" },
      { name: "ip", type: "bytes32" },
      { name: "blsPubkey", type: "bytes" },
      { name: "status", type: "uint8" },
      { name: "registeredAt", type: "uint256" },
      { name: "stakedAmount", type: "uint256" },
    ],
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

function readKeeperBlsPubkey(instanceId: string): string | null {
  const possiblePaths = [
    path.join(__dirname, "..", "..", "keeper", "data", `bls_key_${instanceId}.json`),
    path.join(__dirname, "..", "data", `bls_key_${instanceId}.json`),
  ];

  for (const keyPath of possiblePaths) {
    try {
      if (fs.existsSync(keyPath)) {
        const content = fs.readFileSync(keyPath, "utf-8");
        const keyFile = JSON.parse(content);
        let pubkey = keyFile.public_key as string;
        if (!pubkey.startsWith("0x")) pubkey = "0x" + pubkey;
        const pubkeyBytes = (pubkey.length - 2) / 2;
        if (pubkeyBytes === 128) {
          return pubkey;
        }
      }
    } catch (e) {}
  }
  return null;
}

async function main() {
  console.log("=== Keeper Key Rotation Script ===\n");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`KeeperRegistry: ${KEEPER_REGISTRY_ADDRESS}\n`);

  const publicClient = createPublicClient({
    chain: indexL3,
    transport: http(RPC_URL),
  });

  const chainId = await publicClient.getChainId();
  console.log(`Connected to chain: ${chainId}\n`);

  const adminAccount = privateKeyToAccount(ADMIN_PRIVATE_KEY as `0x${string}`);
  const adminClient = createWalletClient({
    account: adminAccount,
    chain: indexL3,
    transport: http(RPC_URL),
  });
  console.log(`Admin: ${adminAccount.address}\n`);

  for (let i = 0; i < KEEPER_KEYS.length; i++) {
    const privateKey = KEEPER_KEYS[i] as `0x${string}`;
    const instanceId = KEEPER_INSTANCE_IDS[i];
    const account = privateKeyToAccount(privateKey);

    console.log(`--- Keeper ${i + 1}: ${account.address} (${instanceId}) ---`);

    // Check current pubkey length
    const data = await publicClient.readContract({
      address: KEEPER_REGISTRY_ADDRESS,
      abi: KEEPER_REGISTRY_ABI,
      functionName: "keepers",
      args: [account.address],
    });
    const currentPubkey = data[2] as `0x${string}`;
    const currentBytes = (currentPubkey.length - 2) / 2;
    console.log(`  Current pubkey: ${currentBytes} bytes`);

    if (currentBytes === 128) {
      console.log(`  Already has G2 key, skipping`);
      continue;
    }

    // Read new G2 pubkey
    const newPubkey = readKeeperBlsPubkey(instanceId);
    if (!newPubkey) {
      console.log(`  ERROR: New G2 pubkey not found for ${instanceId}`);
      continue;
    }
    console.log(`  New G2 pubkey: ${newPubkey.slice(0, 34)}...${newPubkey.slice(-8)}`);

    // Step 1: Keeper requests key rotation
    console.log(`  Requesting key rotation...`);
    const keeperClient = createWalletClient({
      account,
      chain: indexL3,
      transport: http(RPC_URL),
    });

    try {
      const requestTx = await keeperClient.writeContract({
        address: KEEPER_REGISTRY_ADDRESS,
        abi: KEEPER_REGISTRY_ABI,
        functionName: "requestKeyRotation",
        args: [newPubkey as `0x${string}`],
      });
      console.log(`  Request tx: ${requestTx}`);
      await publicClient.waitForTransactionReceipt({ hash: requestTx });
    } catch (e: any) {
      console.log(`  Request failed: ${e.message}`);
      continue;
    }

    // Step 2: Admin forces the rotation (dev shortcut)
    console.log(`  Admin forcing rotation...`);
    try {
      const forceTx = await adminClient.writeContract({
        address: KEEPER_REGISTRY_ADDRESS,
        abi: KEEPER_REGISTRY_ABI,
        functionName: "forceKeyRotation",
        args: [account.address],
      });
      console.log(`  Force tx: ${forceTx}`);
      await publicClient.waitForTransactionReceipt({ hash: forceTx });
      console.log(`  ✓ Key rotated!`);
    } catch (e: any) {
      console.log(`  Force failed: ${e.message}`);
    }
  }

  // Verify final state
  console.log("\n=== Final Verification ===");
  for (let i = 0; i < KEEPER_KEYS.length; i++) {
    const account = privateKeyToAccount(KEEPER_KEYS[i] as `0x${string}`);
    const data = await publicClient.readContract({
      address: KEEPER_REGISTRY_ADDRESS,
      abi: KEEPER_REGISTRY_ABI,
      functionName: "keepers",
      args: [account.address],
    });
    const pubkey = data[2] as `0x${string}`;
    const bytes = (pubkey.length - 2) / 2;
    console.log(`Keeper ${i + 1}: ${bytes} bytes - ${bytes === 128 ? "✓ G2" : "✗ OLD"}`);
  }
}

main().catch(console.error);
