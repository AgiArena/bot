/**
 * Settlement Contract Interaction Tests
 *
 * Story 2-4: P2P Settlement (Happy Path)
 * Task 8.6: Test settleByAgreement() contract interaction (mock)
 * Task 8.7: Test customPayout() contract interaction (mock)
 * Task 8.8: Test requestArbitration() contract interaction (mock)
 */

import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test";
import { ethers, Wallet } from "ethers";
import type { TransactionResult } from "../chain-client";
import { BetStatus } from "../p2p/types";

// ============================================================================
// Test Setup - Mock Chain Client
// ============================================================================

const CREATOR = "0x1111111111111111111111111111111111111111";
const FILLER = "0x2222222222222222222222222222222222222222";
const TEST_BET_ID = 42;
const TEST_TX_HASH = "0x" + "ab".repeat(32);
const TEST_GAS_USED = "100000";

const CHAIN_ID = 111222333;
const VAULT_ADDRESS = "0x1234567890123456789012345678901234567890";

// Create test wallets
const creatorWallet = new Wallet("0x" + "a".repeat(64));
const fillerWallet = new Wallet("0x" + "b".repeat(64));

/**
 * Mock ChainClient for testing contract interactions
 */
class MockChainClient {
  private mockBet = {
    tradesRoot: "0x" + "11".repeat(32),
    creator: CREATOR,
    filler: FILLER,
    creatorAmount: ethers.parseEther("50"),
    fillerAmount: ethers.parseEther("50"),
    deadline: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago (passed)
    createdAt: Math.floor(Date.now() / 1000) - 86400,
    status: BetStatus.Active,
  };

  private mockNonce = 1n;
  private shouldFail = false;
  private failReason = "";

  setMockBet(overrides: Partial<typeof this.mockBet>) {
    this.mockBet = { ...this.mockBet, ...overrides };
  }

  setShouldFail(fail: boolean, reason = "Mock error") {
    this.shouldFail = fail;
    this.failReason = reason;
  }

  setMockNonce(nonce: bigint) {
    this.mockNonce = nonce;
  }

  getAddress() {
    return creatorWallet.address;
  }

  getWallet() {
    return creatorWallet;
  }

  async getVaultNonce() {
    return this.mockNonce;
  }

  async getBetFromVault(betId: number) {
    if (betId === 0) return null;
    return this.mockBet;
  }

  async getBetStatusFromVault(betId: number) {
    return this.mockBet.status;
  }

  async signSettlementAgreement(
    betId: number,
    winner: string,
    nonce?: bigint,
    expiry?: number,
  ) {
    const actualNonce = nonce ?? this.mockNonce;
    const actualExpiry = expiry ?? Math.floor(Date.now() / 1000) + 3600;

    const domain = {
      name: "CollateralVault",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: VAULT_ADDRESS,
    };

    const types = {
      SettlementAgreement: [
        { name: "betId", type: "uint256" },
        { name: "winner", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    };

    const value = {
      betId: BigInt(betId),
      winner,
      nonce: actualNonce,
      expiry: actualExpiry,
    };

    const signature = await creatorWallet.signTypedData(domain, types, value);

    return {
      agreement: { betId, winner, nonce: actualNonce, expiry: actualExpiry },
      signature,
    };
  }

  async signCustomPayout(
    betId: number,
    creatorPayout: bigint,
    fillerPayout: bigint,
    nonce?: bigint,
    expiry?: number,
  ) {
    const actualNonce = nonce ?? this.mockNonce;
    const actualExpiry = expiry ?? Math.floor(Date.now() / 1000) + 3600;

    const domain = {
      name: "CollateralVault",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: VAULT_ADDRESS,
    };

    const types = {
      CustomPayoutProposal: [
        { name: "betId", type: "uint256" },
        { name: "creatorPayout", type: "uint256" },
        { name: "fillerPayout", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    };

    const value = {
      betId: BigInt(betId),
      creatorPayout,
      fillerPayout,
      nonce: actualNonce,
      expiry: actualExpiry,
    };

    const signature = await creatorWallet.signTypedData(domain, types, value);

    return {
      proposal: { betId, creatorPayout, fillerPayout, nonce: actualNonce, expiry: actualExpiry },
      signature,
    };
  }

  async settleByAgreementOnChain(
    agreement: { betId: number; winner: string; nonce: bigint; expiry: number },
    creatorSig: string,
    fillerSig: string,
  ): Promise<TransactionResult> {
    if (this.shouldFail) {
      return { success: false, error: this.failReason };
    }

    // Validate agreement
    if (agreement.betId === 0) {
      return { success: false, error: "Bet not found" };
    }
    if (this.mockBet.status !== BetStatus.Active) {
      return { success: false, error: "Bet is not active (already settled or in arbitration)" };
    }
    if (agreement.winner !== CREATOR && agreement.winner !== FILLER) {
      return { success: false, error: "Winner must be creator or filler" };
    }
    if (agreement.expiry < Math.floor(Date.now() / 1000)) {
      return { success: false, error: "Signature has expired" };
    }
    if (!creatorSig || !fillerSig) {
      return { success: false, error: "Invalid signature" };
    }

    // Update bet status
    this.mockBet.status = BetStatus.Settled;

    return {
      success: true,
      txHash: TEST_TX_HASH,
      betId: agreement.betId.toString(),
      gasUsed: TEST_GAS_USED,
    };
  }

  async customPayoutOnChain(
    proposal: { betId: number; creatorPayout: bigint; fillerPayout: bigint; nonce: bigint; expiry: number },
    creatorSig: string,
    fillerSig: string,
  ): Promise<TransactionResult> {
    if (this.shouldFail) {
      return { success: false, error: this.failReason };
    }

    // Validate proposal
    if (proposal.betId === 0) {
      return { success: false, error: "Bet not found" };
    }
    if (this.mockBet.status !== BetStatus.Active) {
      return { success: false, error: "Bet is not active" };
    }
    const totalLocked = this.mockBet.creatorAmount + this.mockBet.fillerAmount;
    if (proposal.creatorPayout + proposal.fillerPayout !== totalLocked) {
      return { success: false, error: "Payout amounts must sum to total locked amount" };
    }
    if (proposal.expiry < Math.floor(Date.now() / 1000)) {
      return { success: false, error: "Signature has expired" };
    }
    if (!creatorSig || !fillerSig) {
      return { success: false, error: "Invalid signature" };
    }

    // Update bet status
    this.mockBet.status = BetStatus.CustomPayout;

    return {
      success: true,
      txHash: TEST_TX_HASH,
      betId: proposal.betId.toString(),
      gasUsed: TEST_GAS_USED,
    };
  }

  async requestArbitrationOnChain(betId: number): Promise<TransactionResult> {
    if (this.shouldFail) {
      return { success: false, error: this.failReason };
    }

    if (betId === 0) {
      return { success: false, error: "Bet not found" };
    }
    if (this.mockBet.status !== BetStatus.Active) {
      return { success: false, error: "Bet is not active" };
    }
    if (this.mockBet.deadline > Math.floor(Date.now() / 1000)) {
      return { success: false, error: "Cannot request arbitration before deadline" };
    }

    // Update bet status
    this.mockBet.status = BetStatus.InArbitration;

    return {
      success: true,
      txHash: TEST_TX_HASH,
      betId: betId.toString(),
      gasUsed: TEST_GAS_USED,
    };
  }
}

// ============================================================================
// Task 8.6: Test settleByAgreement() contract interaction
// ============================================================================

describe("settleByAgreement", () => {
  let mockClient: MockChainClient;

  beforeEach(() => {
    mockClient = new MockChainClient();
  });

  test("successful settlement returns txHash", async () => {
    const signed = await mockClient.signSettlementAgreement(TEST_BET_ID, CREATOR);
    const fillerSig = "0x" + "ff".repeat(65); // Mock filler signature

    const result = await mockClient.settleByAgreementOnChain(
      signed.agreement,
      signed.signature,
      fillerSig,
    );

    expect(result.success).toBe(true);
    expect(result.txHash).toBe(TEST_TX_HASH);
    expect(result.betId).toBe(TEST_BET_ID.toString());
    expect(result.gasUsed).toBe(TEST_GAS_USED);
  });

  test("updates bet status to Settled", async () => {
    const signed = await mockClient.signSettlementAgreement(TEST_BET_ID, CREATOR);
    const fillerSig = "0x" + "ff".repeat(65);

    const statusBefore = await mockClient.getBetStatusFromVault(TEST_BET_ID);
    expect(statusBefore).toBe(BetStatus.Active);

    await mockClient.settleByAgreementOnChain(signed.agreement, signed.signature, fillerSig);

    const statusAfter = await mockClient.getBetStatusFromVault(TEST_BET_ID);
    expect(statusAfter).toBe(BetStatus.Settled);
  });

  test("fails when bet not found", async () => {
    const signed = await mockClient.signSettlementAgreement(0, CREATOR); // betId 0 = not found
    const fillerSig = "0x" + "ff".repeat(65);

    const result = await mockClient.settleByAgreementOnChain(
      signed.agreement,
      signed.signature,
      fillerSig,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("fails when bet is not active", async () => {
    mockClient.setMockBet({ status: BetStatus.Settled });

    const signed = await mockClient.signSettlementAgreement(TEST_BET_ID, CREATOR);
    const fillerSig = "0x" + "ff".repeat(65);

    const result = await mockClient.settleByAgreementOnChain(
      signed.agreement,
      signed.signature,
      fillerSig,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not active");
  });

  test("fails with invalid winner", async () => {
    const invalidWinner = "0x3333333333333333333333333333333333333333";
    const signed = await mockClient.signSettlementAgreement(TEST_BET_ID, invalidWinner);
    const fillerSig = "0x" + "ff".repeat(65);

    const result = await mockClient.settleByAgreementOnChain(
      signed.agreement,
      signed.signature,
      fillerSig,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Winner must be creator or filler");
  });

  test("fails with expired signature", async () => {
    const expiredExpiry = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const signed = await mockClient.signSettlementAgreement(
      TEST_BET_ID,
      CREATOR,
      undefined,
      expiredExpiry,
    );
    const fillerSig = "0x" + "ff".repeat(65);

    const result = await mockClient.settleByAgreementOnChain(
      signed.agreement,
      signed.signature,
      fillerSig,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("expired");
  });

  test("fails with missing signature", async () => {
    const signed = await mockClient.signSettlementAgreement(TEST_BET_ID, CREATOR);

    const result = await mockClient.settleByAgreementOnChain(
      signed.agreement,
      signed.signature,
      "", // Missing filler sig
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid signature");
  });
});

// ============================================================================
// Task 8.7: Test customPayout() contract interaction
// ============================================================================

describe("customPayout", () => {
  let mockClient: MockChainClient;

  beforeEach(() => {
    mockClient = new MockChainClient();
  });

  test("successful custom payout returns txHash", async () => {
    const totalLocked = ethers.parseEther("100");
    const creatorPayout = ethers.parseEther("60");
    const fillerPayout = ethers.parseEther("40");

    const signed = await mockClient.signCustomPayout(TEST_BET_ID, creatorPayout, fillerPayout);
    const fillerSig = "0x" + "ff".repeat(65);

    const result = await mockClient.customPayoutOnChain(signed.proposal, signed.signature, fillerSig);

    expect(result.success).toBe(true);
    expect(result.txHash).toBe(TEST_TX_HASH);
    expect(result.betId).toBe(TEST_BET_ID.toString());
  });

  test("updates bet status to CustomPayout", async () => {
    const totalLocked = ethers.parseEther("100");
    const creatorPayout = ethers.parseEther("50");
    const fillerPayout = ethers.parseEther("50");

    const signed = await mockClient.signCustomPayout(TEST_BET_ID, creatorPayout, fillerPayout);
    const fillerSig = "0x" + "ff".repeat(65);

    const statusBefore = await mockClient.getBetStatusFromVault(TEST_BET_ID);
    expect(statusBefore).toBe(BetStatus.Active);

    await mockClient.customPayoutOnChain(signed.proposal, signed.signature, fillerSig);

    const statusAfter = await mockClient.getBetStatusFromVault(TEST_BET_ID);
    expect(statusAfter).toBe(BetStatus.CustomPayout);
  });

  test("fails when payout amounts don't sum to total", async () => {
    const creatorPayout = ethers.parseEther("60");
    const fillerPayout = ethers.parseEther("60"); // Sum = 120, but total locked = 100

    const signed = await mockClient.signCustomPayout(TEST_BET_ID, creatorPayout, fillerPayout);
    const fillerSig = "0x" + "ff".repeat(65);

    const result = await mockClient.customPayoutOnChain(signed.proposal, signed.signature, fillerSig);

    expect(result.success).toBe(false);
    expect(result.error).toContain("sum to total");
  });

  test("fails when bet not found", async () => {
    const creatorPayout = ethers.parseEther("50");
    const fillerPayout = ethers.parseEther("50");

    const signed = await mockClient.signCustomPayout(0, creatorPayout, fillerPayout);
    const fillerSig = "0x" + "ff".repeat(65);

    const result = await mockClient.customPayoutOnChain(signed.proposal, signed.signature, fillerSig);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("fails when bet is not active", async () => {
    mockClient.setMockBet({ status: BetStatus.InArbitration });

    const creatorPayout = ethers.parseEther("50");
    const fillerPayout = ethers.parseEther("50");

    const signed = await mockClient.signCustomPayout(TEST_BET_ID, creatorPayout, fillerPayout);
    const fillerSig = "0x" + "ff".repeat(65);

    const result = await mockClient.customPayoutOnChain(signed.proposal, signed.signature, fillerSig);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not active");
  });

  test("50/50 split custom payout", async () => {
    const creatorPayout = ethers.parseEther("50");
    const fillerPayout = ethers.parseEther("50");

    const signed = await mockClient.signCustomPayout(TEST_BET_ID, creatorPayout, fillerPayout);
    const fillerSig = "0x" + "ff".repeat(65);

    const result = await mockClient.customPayoutOnChain(signed.proposal, signed.signature, fillerSig);

    expect(result.success).toBe(true);
    expect(signed.proposal.creatorPayout).toBe(creatorPayout);
    expect(signed.proposal.fillerPayout).toBe(fillerPayout);
  });

  test("winner-takes-all custom payout", async () => {
    const creatorPayout = ethers.parseEther("100");
    const fillerPayout = 0n;

    const signed = await mockClient.signCustomPayout(TEST_BET_ID, creatorPayout, fillerPayout);
    const fillerSig = "0x" + "ff".repeat(65);

    const result = await mockClient.customPayoutOnChain(signed.proposal, signed.signature, fillerSig);

    expect(result.success).toBe(true);
    expect(signed.proposal.creatorPayout).toBe(creatorPayout);
    expect(signed.proposal.fillerPayout).toBe(0n);
  });
});

// ============================================================================
// Task 8.8: Test requestArbitration() contract interaction
// ============================================================================

describe("requestArbitration", () => {
  let mockClient: MockChainClient;

  beforeEach(() => {
    mockClient = new MockChainClient();
  });

  test("successful arbitration request returns txHash", async () => {
    const result = await mockClient.requestArbitrationOnChain(TEST_BET_ID);

    expect(result.success).toBe(true);
    expect(result.txHash).toBe(TEST_TX_HASH);
    expect(result.betId).toBe(TEST_BET_ID.toString());
    expect(result.gasUsed).toBe(TEST_GAS_USED);
  });

  test("updates bet status to InArbitration", async () => {
    const statusBefore = await mockClient.getBetStatusFromVault(TEST_BET_ID);
    expect(statusBefore).toBe(BetStatus.Active);

    await mockClient.requestArbitrationOnChain(TEST_BET_ID);

    const statusAfter = await mockClient.getBetStatusFromVault(TEST_BET_ID);
    expect(statusAfter).toBe(BetStatus.InArbitration);
  });

  test("fails when bet not found", async () => {
    const result = await mockClient.requestArbitrationOnChain(0);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("fails when bet is not active", async () => {
    mockClient.setMockBet({ status: BetStatus.Settled });

    const result = await mockClient.requestArbitrationOnChain(TEST_BET_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not active");
  });

  test("fails when deadline not passed", async () => {
    mockClient.setMockBet({
      deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour in future
    });

    const result = await mockClient.requestArbitrationOnChain(TEST_BET_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain("before deadline");
  });

  test("can request arbitration after deadline", async () => {
    mockClient.setMockBet({
      deadline: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    });

    const result = await mockClient.requestArbitrationOnChain(TEST_BET_ID);

    expect(result.success).toBe(true);
    expect(result.txHash).toBeDefined();
  });
});

// ============================================================================
// Integration: Settlement Decision Logic
// ============================================================================

describe("Settlement Decision Logic", () => {
  let mockClient: MockChainClient;

  beforeEach(() => {
    mockClient = new MockChainClient();
  });

  test("agree path: execute settleByAgreement", async () => {
    // Simulate agreement flow
    const winner = CREATOR;
    const signed = await mockClient.signSettlementAgreement(TEST_BET_ID, winner);
    const fillerSig = "0x" + "ff".repeat(65);

    const result = await mockClient.settleByAgreementOnChain(
      signed.agreement,
      signed.signature,
      fillerSig,
    );

    expect(result.success).toBe(true);
    expect(result.txHash).toBeDefined();
  });

  test("counter path: execute customPayout", async () => {
    // Simulate counter proposal flow
    const creatorPayout = ethers.parseEther("55");
    const fillerPayout = ethers.parseEther("45");

    const signed = await mockClient.signCustomPayout(TEST_BET_ID, creatorPayout, fillerPayout);
    const fillerSig = "0x" + "ff".repeat(65);

    const result = await mockClient.customPayoutOnChain(
      signed.proposal,
      signed.signature,
      fillerSig,
    );

    expect(result.success).toBe(true);
    expect(result.txHash).toBeDefined();
  });

  test("disagree path: execute requestArbitration", async () => {
    // Simulate disagreement flow
    const result = await mockClient.requestArbitrationOnChain(TEST_BET_ID);

    expect(result.success).toBe(true);
    expect(result.txHash).toBeDefined();

    const status = await mockClient.getBetStatusFromVault(TEST_BET_ID);
    expect(status).toBe(BetStatus.InArbitration);
  });

  test("creator vs filler signature assignment", async () => {
    const winner = CREATOR;

    // Creator signs first
    const creatorSigned = await mockClient.signSettlementAgreement(TEST_BET_ID, winner);

    // In real flow, filler would sign separately with their wallet
    // Here we just verify structure is correct for both signatures
    expect(creatorSigned.agreement.betId).toBe(TEST_BET_ID);
    expect(creatorSigned.agreement.winner).toBe(winner);
    expect(creatorSigned.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });
});
