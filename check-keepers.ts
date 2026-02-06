import { createPublicClient, http } from "viem";

const RPC_URL = process.env.RPC_URL || "http://localhost:33010";
const KEEPER_REGISTRY = "0xE80FB0E8974EFE237fEf83B0df470664fc51fa99";

const abi = [
  { name: "getActiveKeeperCount", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "isActiveKeeper", type: "function", inputs: [{ name: "addr", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
] as const;

const client = createPublicClient({ transport: http(RPC_URL) });

const keepers = [
  "0xCE46e65a7A7527499e92337E5FBf958eABf314fa",
  "0xdafa61604B4Aa82092E1407F8027c71026982E6f",
  "0x1663f734483ceCB07AD6BC80919eA9a5cdDb7FE9",
];

async function main() {
  const count = await client.readContract({ address: KEEPER_REGISTRY, abi, functionName: "getActiveKeeperCount" });
  console.log("Active keeper count:", count);

  for (const addr of keepers) {
    const isActive = await client.readContract({
      address: KEEPER_REGISTRY,
      abi,
      functionName: "isActiveKeeper",
      args: [addr as `0x${string}`]
    });
    console.log(`${addr}: ${isActive ? "ACTIVE" : "NOT REGISTERED"}`);
  }
}

main();
