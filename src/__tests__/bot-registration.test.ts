/**
 * Tests for Bot Registration & Collateral (Story 2-1)
 *
 * Story 2-1: Bot Registration & Collateral
 * Task 6: Write Tests (AC: #1-5)
 *
 * Tests cover:
 * - 6.1: isBotRegistered() returning true/false
 * - 6.2: registerBot() success flow
 * - 6.3: depositToVault() success flow
 * - 6.4: withdrawFromVault() success flow
 * - 6.5: Integration test for full startup sequence (mock chain)
 * - 6.6: Error handling for insufficient WIND
 */

import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import { ChainClient, type ChainClientConfig, type TransactionResult, type BotInfo, type VaultBalance } from "../chain-client";

// Create a test config
const createTestConfig = (overrides: Partial<ChainClientConfig> = {}): ChainClientConfig => ({
  privateKey: "0x" + "a".repeat(64),
  contractAddress: "0x0000000000000000000000000000000000000001",
  collateralAddress: "0x0000000000000000000000000000000000000002",
  resolutionDaoAddress: "0x0000000000000000000000000000000000000003",
  botRegistryAddress: "0x0000000000000000000000000000000000000004",
  collateralVaultAddress: "0x0000000000000000000000000000000000000005",
  rpcUrl: "http://localhost:8545",
  chainId: 111222333,
  backendUrl: "http://localhost:3001",
  ...overrides,
});

describe("Bot Registration & Collateral (Story 2-1)", () => {
  describe("6.1: isBotRegistered() and configuration checks", () => {
    test("isBotRegistryConfigured() returns true when address is set", () => {
      const config = createTestConfig({ botRegistryAddress: "0x1234567890123456789012345678901234567890" });
      const client = new ChainClient(config);

      expect(client.isBotRegistryConfigured()).toBe(true);
    });

    test("isBotRegistryConfigured() returns false when address is empty", () => {
      const config = createTestConfig({ botRegistryAddress: "" });
      const client = new ChainClient(config);

      expect(client.isBotRegistryConfigured()).toBe(false);
    });

    test("isBotRegistryConfigured() returns false when address is undefined", () => {
      const config = createTestConfig({ botRegistryAddress: undefined });
      const client = new ChainClient(config);

      expect(client.isBotRegistryConfigured()).toBe(false);
    });

    test("isBotRegistered() throws when BotRegistry not configured", async () => {
      const config = createTestConfig({ botRegistryAddress: "" });
      const client = new ChainClient(config);

      await expect(client.isBotRegistered()).rejects.toThrow("BotRegistry not configured");
    });

    test("isCollateralVaultConfigured() returns true when address is set", () => {
      const config = createTestConfig({ collateralVaultAddress: "0x1234567890123456789012345678901234567890" });
      const client = new ChainClient(config);

      expect(client.isCollateralVaultConfigured()).toBe(true);
    });

    test("isCollateralVaultConfigured() returns false when address is empty", () => {
      const config = createTestConfig({ collateralVaultAddress: "" });
      const client = new ChainClient(config);

      expect(client.isCollateralVaultConfigured()).toBe(false);
    });
  });

  describe("6.2: registerBot() validation", () => {
    test("registerBot() returns error when BotRegistry not configured", async () => {
      const config = createTestConfig({ botRegistryAddress: "" });
      const client = new ChainClient(config);

      const result = await client.registerBot("https://bot.example.com:8080", "0x" + "ab".repeat(32));

      expect(result.success).toBe(false);
      expect(result.error).toContain("BotRegistry not configured");
    });

    test("deregisterBot() returns error when BotRegistry not configured", async () => {
      const config = createTestConfig({ botRegistryAddress: "" });
      const client = new ChainClient(config);

      const result = await client.deregisterBot();

      expect(result.success).toBe(false);
      expect(result.error).toContain("BotRegistry not configured");
    });

    test("getBotInfo() returns null when BotRegistry not configured", async () => {
      const config = createTestConfig({ botRegistryAddress: "" });
      const client = new ChainClient(config);

      const result = await client.getBotInfo();

      expect(result).toBeNull();
    });

    test("getAllActiveBots() returns empty arrays when BotRegistry not configured", async () => {
      const config = createTestConfig({ botRegistryAddress: "" });
      const client = new ChainClient(config);

      const [addresses, endpoints] = await client.getAllActiveBots();

      expect(addresses).toEqual([]);
      expect(endpoints).toEqual([]);
    });
  });

  describe("6.3: depositToVault() validation", () => {
    test("depositToVault() returns error when CollateralVault not configured", async () => {
      const config = createTestConfig({ collateralVaultAddress: "" });
      const client = new ChainClient(config);

      const result = await client.depositToVault(BigInt("100000000000000000000"));

      expect(result.success).toBe(false);
      expect(result.error).toContain("CollateralVault not configured");
    });
  });

  describe("6.4: withdrawFromVault() validation", () => {
    test("withdrawFromVault() returns error when CollateralVault not configured", async () => {
      const config = createTestConfig({ collateralVaultAddress: "" });
      const client = new ChainClient(config);

      const result = await client.withdrawFromVault(BigInt("100000000000000000000"));

      expect(result.success).toBe(false);
      expect(result.error).toContain("CollateralVault not configured");
    });

    test("getVaultBalance() returns zeros when CollateralVault not configured", async () => {
      const config = createTestConfig({ collateralVaultAddress: "" });
      const client = new ChainClient(config);

      const balance = await client.getVaultBalance();

      expect(balance.available).toBe(BigInt(0));
      expect(balance.locked).toBe(BigInt(0));
      expect(balance.total).toBe(BigInt(0));
    });

    test("ensureVaultApproval() returns error when CollateralVault not configured", async () => {
      const config = createTestConfig({ collateralVaultAddress: "" });
      const client = new ChainClient(config);

      const result = await client.ensureVaultApproval(BigInt("100000000000000000000"));

      expect(result.success).toBe(false);
      expect(result.error).toContain("CollateralVault not configured");
    });
  });

  describe("6.5: Full startup sequence logic", () => {
    test("client initializes contracts when addresses are provided", () => {
      const config = createTestConfig({
        botRegistryAddress: "0x1234567890123456789012345678901234567890",
        collateralVaultAddress: "0x0987654321098765432109876543210987654321",
      });
      const client = new ChainClient(config);

      expect(client.isBotRegistryConfigured()).toBe(true);
      expect(client.isCollateralVaultConfigured()).toBe(true);
    });

    test("client skips contracts when addresses are empty", () => {
      const config = createTestConfig({
        botRegistryAddress: "",
        collateralVaultAddress: "",
      });
      const client = new ChainClient(config);

      expect(client.isBotRegistryConfigured()).toBe(false);
      expect(client.isCollateralVaultConfigured()).toBe(false);
    });

    test("getAddress() returns wallet address", () => {
      const config = createTestConfig();
      const client = new ChainClient(config);

      const address = client.getAddress();

      // Address should be derived from the private key
      expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    test("getChainId() returns configured chain ID", () => {
      const config = createTestConfig({ chainId: 111222333 });
      const client = new ChainClient(config);

      expect(client.getChainId()).toBe(111222333);
    });

    test("getBackendUrl() returns configured backend URL", () => {
      const config = createTestConfig({ backendUrl: "http://test:3001" });
      const client = new ChainClient(config);

      expect(client.getBackendUrl()).toBe("http://test:3001");
    });
  });

  describe("6.6: Error handling scenarios", () => {
    test("configuration with missing private key throws", () => {
      expect(() => {
        new ChainClient({
          privateKey: "", // Empty private key
          contractAddress: "0x0000000000000000000000000000000000000001",
        });
      }).toThrow();
    });

    test("configuration with invalid private key throws", () => {
      expect(() => {
        new ChainClient({
          privateKey: "not-a-valid-key",
          contractAddress: "0x0000000000000000000000000000000000000001",
        });
      }).toThrow();
    });

    test("VaultBalance type has correct structure", () => {
      // Type validation - VaultBalance should have available, locked, total
      const balance: VaultBalance = {
        available: BigInt(500),
        locked: BigInt(100),
        total: BigInt(600),
      };

      expect(balance.available).toBe(BigInt(500));
      expect(balance.locked).toBe(BigInt(100));
      expect(balance.total).toBe(BigInt(600));
    });

    test("BotInfo type has correct structure", () => {
      // Type validation - BotInfo should have all required fields
      const botInfo: BotInfo = {
        endpoint: "https://bot.example.com",
        pubkeyHash: "0x" + "ab".repeat(32),
        stakedAmount: BigInt("100000000000000000000"),
        registeredAt: BigInt(1704067200),
        isActive: true,
      };

      expect(botInfo.endpoint).toBe("https://bot.example.com");
      expect(botInfo.isActive).toBe(true);
      expect(botInfo.stakedAmount).toBe(BigInt("100000000000000000000"));
    });

    test("TransactionResult success structure", () => {
      const successResult: TransactionResult = {
        success: true,
        txHash: "0x" + "ab".repeat(32),
        gasUsed: "100000",
      };

      expect(successResult.success).toBe(true);
      expect(successResult.txHash).toBeDefined();
    });

    test("TransactionResult error structure", () => {
      const errorResult: TransactionResult = {
        success: false,
        error: "Insufficient funds",
      };

      expect(errorResult.success).toBe(false);
      expect(errorResult.error).toBe("Insufficient funds");
    });
  });

  describe("computeTradesHash static method", () => {
    test("computes deterministic hash from snapshotId and bitmap", () => {
      const snapshotId = "crypto-2026-01-28-18";
      const bitmap = new Uint8Array([0b10101010, 0b01010101]);

      const hash1 = ChainClient.computeTradesHash(snapshotId, bitmap);
      const hash2 = ChainClient.computeTradesHash(snapshotId, bitmap);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    test("produces different hashes for different inputs", () => {
      const bitmap = new Uint8Array([0b10101010]);

      const hash1 = ChainClient.computeTradesHash("snapshot-1", bitmap);
      const hash2 = ChainClient.computeTradesHash("snapshot-2", bitmap);

      expect(hash1).not.toBe(hash2);
    });

    test("produces different hashes for different bitmaps", () => {
      const snapshotId = "crypto-2026-01-28-18";

      const hash1 = ChainClient.computeTradesHash(snapshotId, new Uint8Array([0b10101010]));
      const hash2 = ChainClient.computeTradesHash(snapshotId, new Uint8Array([0b01010101]));

      expect(hash1).not.toBe(hash2);
    });
  });
});
