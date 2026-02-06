/**
 * Tests for P2P Server & Discovery
 *
 * Story 2-2: P2P Server & Discovery
 * Task 6: Write tests (AC: #1, #2, #3, #4)
 *
 * Tests cover:
 * - 6.1: Create P2P server test file
 * - 6.2: Test /p2p/info and /p2p/health endpoints
 * - 6.3: Test /p2p/propose with valid/invalid signatures
 * - 6.4: Test /p2p/accept with valid/invalid signatures
 * - 6.5: Test peer discovery with mock BotRegistry
 * - 6.6: Test transport retry logic
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { ethers } from "ethers";
import {
  startP2PServer,
  validateProposalSignature,
  validateAcceptanceSignature,
  computeProposalHash,
  computeAcceptanceHash,
  type P2PServerConfig,
  type P2PServerHandle,
  P2P_DOMAIN,
  TRADE_PROPOSAL_TYPES,
  TRADE_ACCEPTANCE_TYPES,
  type TradeProposal,
  type TradeAcceptance,
  computeRequiredMatch,
  PeerDiscovery,
  P2PTransport,
  P2PTransportError,
} from "../p2p";

// Test wallet for signing
const TEST_PRIVATE_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
const TEST_ADDRESS = wallet.address;

// Global port counter to ensure unique ports across all tests
let globalPortCounter = 19000;

// Different wallet for acceptance testing
const FILLER_PRIVATE_KEY = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const fillerWallet = new ethers.Wallet(FILLER_PRIVATE_KEY);
const FILLER_ADDRESS = fillerWallet.address;

// Test server config
function createTestServerConfig(port: number = 9900): P2PServerConfig {
  return {
    port,
    endpoint: `http://localhost:${port}`,
    address: TEST_ADDRESS,
    pubkeyHash: ethers.keccak256(ethers.toUtf8Bytes("test-pubkey")),
    rateLimitPerSecond: 100, // High limit for tests
    startTime: Date.now(),
  };
}

// Helper to create a valid signed proposal
async function createSignedProposal(
  creator: ethers.Wallet = wallet,
  overrides: Partial<Omit<TradeProposal, "signature">> = {}
): Promise<TradeProposal> {
  const now = Math.floor(Date.now() / 1000);
  const data = {
    creator: creator.address,
    tradesHash: ethers.keccak256(ethers.toUtf8Bytes("test-trades")),
    snapshotId: "crypto-2026-01-28-18",
    creatorStake: BigInt("1000000000000000000"), // 1 WIND
    oddsBps: 20000, // 2.0x
    resolutionDeadline: now + 86400, // 24h
    nonce: BigInt(0),
    expiry: now + 3600, // 1h
    ...overrides,
  };

  const signature = await creator.signTypedData(
    P2P_DOMAIN,
    TRADE_PROPOSAL_TYPES,
    data
  );

  return { ...data, signature };
}

// Helper to create a valid signed acceptance
async function createSignedAcceptance(
  filler: ethers.Wallet = fillerWallet,
  proposalHash: string,
  overrides: Partial<Omit<TradeAcceptance, "signature">> = {}
): Promise<TradeAcceptance> {
  const now = Math.floor(Date.now() / 1000);
  const data = {
    proposalHash,
    filler: filler.address,
    fillAmount: BigInt("500000000000000000"), // 0.5 WIND (for 2.0x odds)
    nonce: BigInt(0),
    expiry: now + 3600,
    ...overrides,
  };

  const signature = await filler.signTypedData(
    P2P_DOMAIN,
    TRADE_ACCEPTANCE_TYPES,
    data
  );

  return { ...data, signature };
}

// Serialize BigInt for fetch body
function serializeBody(obj: object): string {
  return JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

describe("P2P Server & Discovery (Story 2-2)", () => {
  // ============================================================================
  // 6.1: Server Test File + Types Tests
  // ============================================================================
  describe("6.1: P2P Types and Schemas", () => {
    test("P2P_DOMAIN has correct values", () => {
      expect(P2P_DOMAIN.name).toBe("AgiArenaP2P");
      expect(P2P_DOMAIN.version).toBe("1");
      expect(P2P_DOMAIN.chainId).toBe(111222333);
    });

    test("TRADE_PROPOSAL_TYPES has required fields", () => {
      const fields = TRADE_PROPOSAL_TYPES.TradeProposal;
      const fieldNames = fields.map((f) => f.name);

      expect(fieldNames).toContain("creator");
      expect(fieldNames).toContain("tradesHash");
      expect(fieldNames).toContain("snapshotId");
      expect(fieldNames).toContain("creatorStake");
      expect(fieldNames).toContain("oddsBps");
      expect(fieldNames).toContain("resolutionDeadline");
      expect(fieldNames).toContain("nonce");
      expect(fieldNames).toContain("expiry");
    });

    test("TRADE_ACCEPTANCE_TYPES has required fields", () => {
      const fields = TRADE_ACCEPTANCE_TYPES.TradeAcceptance;
      const fieldNames = fields.map((f) => f.name);

      expect(fieldNames).toContain("proposalHash");
      expect(fieldNames).toContain("filler");
      expect(fieldNames).toContain("fillAmount");
      expect(fieldNames).toContain("nonce");
      expect(fieldNames).toContain("expiry");
    });

    test("computeRequiredMatch calculates correctly", () => {
      // At 2.0x odds (20000 bps), creator stakes 1, filler needs 0.5
      const result = computeRequiredMatch(
        BigInt("1000000000000000000"), // 1 WIND
        20000 // 2.0x
      );
      expect(result).toBe(BigInt("500000000000000000")); // 0.5 WIND

      // At 1.0x odds (10000 bps), creator stakes 1, filler needs 1
      const result2 = computeRequiredMatch(
        BigInt("1000000000000000000"),
        10000
      );
      expect(result2).toBe(BigInt("1000000000000000000"));
    });
  });

  // ============================================================================
  // 6.2: Test /p2p/info and /p2p/health endpoints
  // ============================================================================
  describe("6.2: GET /p2p/info and /p2p/health", () => {
    let server: P2PServerHandle;
    let port: number;

    beforeEach(() => {
      port = ++globalPortCounter;
      server = startP2PServer(createTestServerConfig(port));
    });

    afterEach(() => {
      server?.stop();
    });

    test("GET /p2p/info returns bot information", async () => {
      const response = await fetch(`http://localhost:${port}/p2p/info`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.address).toBe(TEST_ADDRESS);
      expect(data.endpoint).toBe(`http://localhost:${port}`);
      expect(data.version).toBe("1.0.0");
      expect(typeof data.uptime).toBe("number");
      expect(typeof data.pubkeyHash).toBe("string");
    });

    test("GET /p2p/health returns healthy status", async () => {
      const response = await fetch(`http://localhost:${port}/p2p/health`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.status).toBe("healthy");
      expect(typeof data.timestamp).toBe("number");
      expect(typeof data.uptime).toBe("number");
    });

    test("unknown endpoints return 404", async () => {
      const response = await fetch(`http://localhost:${port}/unknown`);
      expect(response.status).toBe(404);
    });

    test("CORS headers are present", async () => {
      const response = await fetch(`http://localhost:${port}/p2p/info`);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  // ============================================================================
  // 6.3: Test /p2p/propose with valid/invalid signatures
  // ============================================================================
  describe("6.3: POST /p2p/propose", () => {
    let server: P2PServerHandle;
    let port: number;

    beforeEach(() => {
      port = ++globalPortCounter;
      server = startP2PServer(createTestServerConfig(port));
    });

    afterEach(() => {
      server?.stop();
    });

    test("valid proposal is accepted", async () => {
      const proposal = await createSignedProposal();

      const response = await fetch(`http://localhost:${port}/p2p/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeBody(proposal),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.received).toBe(true);
      expect(typeof data.proposalHash).toBe("string");
    });

    test("proposal with invalid signature is rejected", async () => {
      const proposal = await createSignedProposal();
      // Tamper with the signature
      proposal.signature = "0x" + "ab".repeat(65);

      const response = await fetch(`http://localhost:${port}/p2p/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeBody(proposal),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe(true);
    });

    test("proposal signed by wrong address is rejected", async () => {
      // Create proposal claiming to be from wallet but signed by fillerWallet
      const proposal = await createSignedProposal(fillerWallet, {
        creator: TEST_ADDRESS, // Wrong: claims to be TEST_ADDRESS
      });

      const response = await fetch(`http://localhost:${port}/p2p/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeBody(proposal),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.code).toBe("SIGNER_MISMATCH");
    });

    test("expired proposal is rejected", async () => {
      const now = Math.floor(Date.now() / 1000);
      const proposal = await createSignedProposal(wallet, {
        expiry: now - 100, // Already expired
      });

      const response = await fetch(`http://localhost:${port}/p2p/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeBody(proposal),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe("EXPIRED");
    });

    test("proposal with missing fields is rejected", async () => {
      const response = await fetch(`http://localhost:${port}/p2p/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creator: TEST_ADDRESS }), // Missing required fields
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe("MISSING_FIELDS");
    });

    test("invalid JSON body is rejected", async () => {
      const response = await fetch(`http://localhost:${port}/p2p/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe("INVALID_JSON");
    });
  });

  // ============================================================================
  // 6.4: Test /p2p/accept with valid/invalid signatures
  // ============================================================================
  describe("6.4: POST /p2p/accept", () => {
    let server: P2PServerHandle;
    let port: number;

    beforeEach(() => {
      port = ++globalPortCounter;
      server = startP2PServer(createTestServerConfig(port));
    });

    afterEach(() => {
      server?.stop();
    });

    test("valid acceptance is accepted", async () => {
      const proposal = await createSignedProposal();
      const proposalHash = computeProposalHash(proposal);
      const acceptance = await createSignedAcceptance(fillerWallet, proposalHash);

      const response = await fetch(`http://localhost:${port}/p2p/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeBody(acceptance),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.received).toBe(true);
      expect(typeof data.acceptanceHash).toBe("string");
    });

    test("acceptance with invalid signature is rejected", async () => {
      const acceptance = await createSignedAcceptance(fillerWallet, "0x" + "ab".repeat(32));
      acceptance.signature = "0x" + "cd".repeat(65);

      const response = await fetch(`http://localhost:${port}/p2p/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeBody(acceptance),
      });

      expect(response.status).toBe(401);
    });

    test("acceptance signed by wrong address is rejected", async () => {
      // Create acceptance claiming to be from fillerWallet but signed by wallet
      const acceptance = await createSignedAcceptance(wallet, "0x" + "ab".repeat(32), {
        filler: FILLER_ADDRESS, // Claims to be filler but signed by wallet
      });

      const response = await fetch(`http://localhost:${port}/p2p/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeBody(acceptance),
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.code).toBe("SIGNER_MISMATCH");
    });

    test("expired acceptance is rejected", async () => {
      const now = Math.floor(Date.now() / 1000);
      const acceptance = await createSignedAcceptance(fillerWallet, "0x" + "ab".repeat(32), {
        expiry: now - 100,
      });

      const response = await fetch(`http://localhost:${port}/p2p/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializeBody(acceptance),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe("EXPIRED");
    });
  });

  // ============================================================================
  // 6.5: Test peer discovery with mock BotRegistry
  // ============================================================================
  describe("6.5: Peer Discovery", () => {
    // Mock ChainClient for discovery tests
    const mockChainClient = {
      getAddress: () => TEST_ADDRESS,
      getAllActiveBots: mock(() =>
        Promise.resolve([
          [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
            TEST_ADDRESS, // Self - should be excluded
          ],
          [
            "http://bot1.example.com:8080",
            "http://bot2.example.com:8080",
            "http://self.example.com:8080",
          ],
        ])
      ),
    };

    beforeEach(() => {
      mockChainClient.getAllActiveBots.mockReset();
      mockChainClient.getAllActiveBots.mockImplementation(() =>
        Promise.resolve([
          [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
            TEST_ADDRESS,
          ],
          [
            "http://bot1.example.com:8080",
            "http://bot2.example.com:8080",
            "http://self.example.com:8080",
          ],
        ])
      );
    });

    test("fetchPeersFromRegistry returns peers excluding self", async () => {
      const discovery = new PeerDiscovery(mockChainClient as any, TEST_ADDRESS);
      const peers = await discovery.fetchPeersFromRegistry();

      // Should exclude self
      expect(peers.length).toBe(2);
      expect(peers.find((p) => p.address === TEST_ADDRESS.toLowerCase())).toBeUndefined();
    });

    test("peer cache is used within TTL", async () => {
      const discovery = new PeerDiscovery(mockChainClient as any, TEST_ADDRESS, {
        cacheTtlMs: 60000,
      });

      // First call
      await discovery.fetchPeersFromRegistry();
      expect(mockChainClient.getAllActiveBots).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await discovery.fetchPeersFromRegistry();
      expect(mockChainClient.getAllActiveBots).toHaveBeenCalledTimes(1);
    });

    test("refreshPeers invalidates cache", async () => {
      const discovery = new PeerDiscovery(mockChainClient as any, TEST_ADDRESS);

      await discovery.fetchPeersFromRegistry();
      expect(mockChainClient.getAllActiveBots).toHaveBeenCalledTimes(1);

      // Force refresh
      await discovery.refreshPeers();
      expect(mockChainClient.getAllActiveBots).toHaveBeenCalledTimes(2);
    });

    test("getPeer returns correct peer by address", async () => {
      const discovery = new PeerDiscovery(mockChainClient as any, TEST_ADDRESS);
      await discovery.fetchPeersFromRegistry();

      const peer = discovery.getPeer("0x1111111111111111111111111111111111111111");
      expect(peer).toBeDefined();
      expect(peer?.endpoint).toBe("http://bot1.example.com:8080");
    });

    test("getPeerCount returns correct count", async () => {
      const discovery = new PeerDiscovery(mockChainClient as any, TEST_ADDRESS);
      await discovery.fetchPeersFromRegistry();

      expect(discovery.getPeerCount()).toBe(2);
    });

    test("clearCache removes all peers", async () => {
      const discovery = new PeerDiscovery(mockChainClient as any, TEST_ADDRESS);
      await discovery.fetchPeersFromRegistry();
      expect(discovery.getPeerCount()).toBe(2);

      discovery.clearCache();
      expect(discovery.getPeerCount()).toBe(0);
    });

    test("handles empty registry gracefully", async () => {
      mockChainClient.getAllActiveBots.mockImplementation(() =>
        Promise.resolve([[], []])
      );

      const discovery = new PeerDiscovery(mockChainClient as any, TEST_ADDRESS);
      const peers = await discovery.fetchPeersFromRegistry();

      expect(peers.length).toBe(0);
    });

    test("handles registry error gracefully", async () => {
      mockChainClient.getAllActiveBots.mockImplementation(() =>
        Promise.reject(new Error("RPC error"))
      );

      const discovery = new PeerDiscovery(mockChainClient as any, TEST_ADDRESS);
      const peers = await discovery.fetchPeersFromRegistry();

      // Should return empty array on error
      expect(peers.length).toBe(0);
    });
  });

  // ============================================================================
  // 6.6: Test transport retry logic
  // ============================================================================
  describe("6.6: Transport Retry Logic", () => {
    let server: P2PServerHandle;
    let port: number;

    beforeEach(() => {
      port = ++globalPortCounter;
      server = startP2PServer(createTestServerConfig(port));
    });

    afterEach(() => {
      server?.stop();
    });

    test("successful request doesn't retry", async () => {
      const transport = new P2PTransport({ maxRetries: 3 });
      const result = await transport.checkPeerHealth(`http://localhost:${port}`);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("healthy");
      }
    });

    test("transport handles connection refused gracefully", async () => {
      const transport = new P2PTransport({
        maxRetries: 1,
        baseDelayMs: 10,
        timeoutMs: 100,
      });

      // Try to connect to a non-existent server
      const result = await transport.checkPeerHealth("http://localhost:19999");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(P2PTransportError);
      }
    });

    test("sendProposal sends correctly formatted request", async () => {
      const transport = new P2PTransport();
      const proposal = await createSignedProposal();

      const result = await transport.sendProposal(`http://localhost:${port}`, proposal);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.received).toBe(true);
        expect(result.data.proposalHash).toBeDefined();
      }
    });

    test("sendAcceptance sends correctly formatted request", async () => {
      const transport = new P2PTransport();
      const proposal = await createSignedProposal();
      const proposalHash = computeProposalHash(proposal);
      const acceptance = await createSignedAcceptance(fillerWallet, proposalHash);

      const result = await transport.sendAcceptance(`http://localhost:${port}`, acceptance);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.received).toBe(true);
        expect(result.data.acceptanceHash).toBeDefined();
      }
    });

    test("getPeerInfo returns correct data", async () => {
      const transport = new P2PTransport();
      const result = await transport.getPeerInfo(`http://localhost:${port}`);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.address).toBe(TEST_ADDRESS);
        expect(result.data.version).toBe("1.0.0");
      }
    });

    test("transport config defaults are correct", () => {
      const transport = new P2PTransport();
      const config = transport.getConfig();

      expect(config.maxRetries).toBe(3);
      expect(config.baseDelayMs).toBe(200);
      expect(config.maxDelayMs).toBe(2000);
      expect(config.timeoutMs).toBe(5000);
    });

    test("transport respects custom config", () => {
      const transport = new P2PTransport({
        maxRetries: 5,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        timeoutMs: 3000,
      });
      const config = transport.getConfig();

      expect(config.maxRetries).toBe(5);
      expect(config.baseDelayMs).toBe(100);
      expect(config.maxDelayMs).toBe(1000);
      expect(config.timeoutMs).toBe(3000);
    });
  });

  // ============================================================================
  // Additional: Signature Validation Tests
  // ============================================================================
  describe("Signature Validation Functions", () => {
    test("validateProposalSignature returns signer for valid signature", async () => {
      const proposal = await createSignedProposal();
      const signer = validateProposalSignature(proposal);

      expect(signer).toBe(TEST_ADDRESS);
    });

    test("validateProposalSignature returns null for invalid signature", async () => {
      const proposal = await createSignedProposal();
      proposal.signature = "0x" + "00".repeat(65);

      const signer = validateProposalSignature(proposal);
      expect(signer).toBeNull();
    });

    test("validateAcceptanceSignature returns signer for valid signature", async () => {
      const acceptance = await createSignedAcceptance(fillerWallet, "0x" + "ab".repeat(32));
      const signer = validateAcceptanceSignature(acceptance);

      expect(signer).toBe(FILLER_ADDRESS);
    });

    test("validateAcceptanceSignature returns null for invalid signature", async () => {
      const acceptance = await createSignedAcceptance(fillerWallet, "0x" + "ab".repeat(32));
      acceptance.signature = "0x" + "00".repeat(65);

      const signer = validateAcceptanceSignature(acceptance);
      expect(signer).toBeNull();
    });

    test("computeProposalHash is deterministic", async () => {
      const proposal = await createSignedProposal();
      const hash1 = computeProposalHash(proposal);
      const hash2 = computeProposalHash(proposal);

      expect(hash1).toBe(hash2);
    });

    test("different proposals have different hashes", async () => {
      const proposal1 = await createSignedProposal();
      const proposal2 = await createSignedProposal(wallet, {
        creatorStake: BigInt("2000000000000000000"),
      });

      const hash1 = computeProposalHash(proposal1);
      const hash2 = computeProposalHash(proposal2);

      expect(hash1).not.toBe(hash2);
    });

    test("computeAcceptanceHash is deterministic", async () => {
      const acceptance = await createSignedAcceptance(fillerWallet, "0x" + "ab".repeat(32));
      const hash1 = computeAcceptanceHash(acceptance);
      const hash2 = computeAcceptanceHash(acceptance);

      expect(hash1).toBe(hash2);
    });
  });

  // ============================================================================
  // Additional: Rate Limiting Tests
  // ============================================================================
  describe("Rate Limiting", () => {
    test("requests within limit succeed", async () => {
      const port = ++globalPortCounter;
      const server = startP2PServer({
        ...createTestServerConfig(port),
        rateLimitPerSecond: 5,
      });

      try {
        // Make 5 requests (at limit)
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            fetch(`http://localhost:${port}/p2p/health`)
          )
        );

        const allOk = results.every((r) => r.ok);
        expect(allOk).toBe(true);
      } finally {
        server.stop();
      }
    });

    test("requests over limit are rejected with 429", async () => {
      const port = ++globalPortCounter;
      const server = startP2PServer({
        ...createTestServerConfig(port),
        rateLimitPerSecond: 2,
      });

      try {
        // Make requests sequentially to ensure proper rate limiting
        const results: Response[] = [];
        for (let i = 0; i < 5; i++) {
          results.push(await fetch(`http://localhost:${port}/p2p/health`));
        }

        // At least one should be rate limited
        const hasRateLimited = results.some((r) => r.status === 429);
        expect(hasRateLimited).toBe(true);
      } finally {
        server.stop();
      }
    });
  });

  // ============================================================================
  // Additional: Handler Integration Tests
  // ============================================================================
  describe("Handler Integration", () => {
    test("onProposal handler is called for valid proposals", async () => {
      const port = ++globalPortCounter;
      let receivedProposal: TradeProposal | null = null;

      const server = startP2PServer(createTestServerConfig(port), {
        onProposal: async (proposal) => {
          receivedProposal = proposal;
        },
      });

      try {
        const proposal = await createSignedProposal();
        await fetch(`http://localhost:${port}/p2p/propose`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: serializeBody(proposal),
        });

        expect(receivedProposal).not.toBeNull();
        expect(receivedProposal?.creator).toBe(TEST_ADDRESS);
      } finally {
        server.stop();
      }
    });

    test("onAcceptance handler is called for valid acceptances", async () => {
      const port = ++globalPortCounter;
      let receivedAcceptance: TradeAcceptance | null = null;

      const server = startP2PServer(createTestServerConfig(port), {
        onAcceptance: async (acceptance) => {
          receivedAcceptance = acceptance;
        },
      });

      try {
        const proposal = await createSignedProposal();
        const proposalHash = computeProposalHash(proposal);
        const acceptance = await createSignedAcceptance(fillerWallet, proposalHash);

        await fetch(`http://localhost:${port}/p2p/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: serializeBody(acceptance),
        });

        expect(receivedAcceptance).not.toBeNull();
        expect(receivedAcceptance?.filler).toBe(FILLER_ADDRESS);
      } finally {
        server.stop();
      }
    });

    test("handler errors don't affect response", async () => {
      const port = ++globalPortCounter;

      const server = startP2PServer(createTestServerConfig(port), {
        onProposal: async () => {
          throw new Error("Handler error");
        },
      });

      try {
        const proposal = await createSignedProposal();
        const response = await fetch(`http://localhost:${port}/p2p/propose`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: serializeBody(proposal),
        });

        // Should still succeed despite handler error
        expect(response.ok).toBe(true);
      } finally {
        server.stop();
      }
    });
  });
});
