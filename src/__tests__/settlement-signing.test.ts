/**
 * Settlement EIP-712 Signing Tests
 *
 * Story 2-4: P2P Settlement (Happy Path)
 * Task 8.4: Test EIP-712 settlement signing and verification
 */

import { describe, test, expect, beforeAll, mock } from "bun:test";
import { ethers, Wallet } from "ethers";
import {
  SETTLEMENT_AGREEMENT_TYPES,
  CUSTOM_PAYOUT_TYPES,
  SETTLEMENT_PROPOSAL_TYPES,
  getCollateralVaultDomain,
  P2P_DOMAIN,
} from "../p2p/types";

// ============================================================================
// Test Setup
// ============================================================================

const TEST_CHAIN_ID = 111222333;
const TEST_VAULT_ADDRESS = "0x1234567890123456789012345678901234567890";
const TEST_BET_ID = 42;

// Test wallets
let creatorWallet: Wallet;
let fillerWallet: Wallet;

beforeAll(() => {
  // Create test wallets with deterministic keys
  creatorWallet = new Wallet("0x" + "a".repeat(64));
  fillerWallet = new Wallet("0x" + "b".repeat(64));
});

// ============================================================================
// Task 8.4: Test EIP-712 settlement signing and verification
// ============================================================================

describe("EIP-712 Settlement Agreement Signing", () => {
  test("signs SettlementAgreement with correct domain and types", async () => {
    const domain = getCollateralVaultDomain(TEST_CHAIN_ID, TEST_VAULT_ADDRESS);

    const agreement = {
      betId: BigInt(TEST_BET_ID),
      winner: creatorWallet.address,
      nonce: 1n,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    };

    const signature = await creatorWallet.signTypedData(
      domain,
      SETTLEMENT_AGREEMENT_TYPES,
      agreement,
    );

    expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  test("verifies SettlementAgreement signature recovers signer", async () => {
    const domain = getCollateralVaultDomain(TEST_CHAIN_ID, TEST_VAULT_ADDRESS);

    const agreement = {
      betId: BigInt(TEST_BET_ID),
      winner: fillerWallet.address,
      nonce: 1n,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    };

    const signature = await creatorWallet.signTypedData(
      domain,
      SETTLEMENT_AGREEMENT_TYPES,
      agreement,
    );

    // Recover signer
    const recoveredAddress = ethers.verifyTypedData(
      domain,
      SETTLEMENT_AGREEMENT_TYPES,
      agreement,
      signature,
    );

    expect(recoveredAddress.toLowerCase()).toBe(creatorWallet.address.toLowerCase());
  });

  test("different signers produce different signatures", async () => {
    const domain = getCollateralVaultDomain(TEST_CHAIN_ID, TEST_VAULT_ADDRESS);

    const agreement = {
      betId: BigInt(TEST_BET_ID),
      winner: creatorWallet.address,
      nonce: 1n,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    };

    const creatorSig = await creatorWallet.signTypedData(
      domain,
      SETTLEMENT_AGREEMENT_TYPES,
      agreement,
    );

    const fillerSig = await fillerWallet.signTypedData(
      domain,
      SETTLEMENT_AGREEMENT_TYPES,
      agreement,
    );

    expect(creatorSig).not.toBe(fillerSig);
  });

  test("changing agreement data changes signature", async () => {
    const domain = getCollateralVaultDomain(TEST_CHAIN_ID, TEST_VAULT_ADDRESS);

    const agreement1 = {
      betId: BigInt(TEST_BET_ID),
      winner: creatorWallet.address,
      nonce: 1n,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    };

    const agreement2 = {
      ...agreement1,
      winner: fillerWallet.address, // Different winner
    };

    const sig1 = await creatorWallet.signTypedData(
      domain,
      SETTLEMENT_AGREEMENT_TYPES,
      agreement1,
    );

    const sig2 = await creatorWallet.signTypedData(
      domain,
      SETTLEMENT_AGREEMENT_TYPES,
      agreement2,
    );

    expect(sig1).not.toBe(sig2);
  });
});

describe("EIP-712 Custom Payout Signing", () => {
  test("signs CustomPayoutProposal with correct domain and types", async () => {
    const domain = getCollateralVaultDomain(TEST_CHAIN_ID, TEST_VAULT_ADDRESS);

    const proposal = {
      betId: BigInt(TEST_BET_ID),
      creatorPayout: ethers.parseEther("60"),
      fillerPayout: ethers.parseEther("40"),
      nonce: 1n,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    };

    const signature = await creatorWallet.signTypedData(
      domain,
      CUSTOM_PAYOUT_TYPES,
      proposal,
    );

    expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  test("verifies CustomPayoutProposal signature recovers signer", async () => {
    const domain = getCollateralVaultDomain(TEST_CHAIN_ID, TEST_VAULT_ADDRESS);

    const proposal = {
      betId: BigInt(TEST_BET_ID),
      creatorPayout: ethers.parseEther("50"),
      fillerPayout: ethers.parseEther("50"),
      nonce: 2n,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    };

    const signature = await fillerWallet.signTypedData(
      domain,
      CUSTOM_PAYOUT_TYPES,
      proposal,
    );

    const recoveredAddress = ethers.verifyTypedData(
      domain,
      CUSTOM_PAYOUT_TYPES,
      proposal,
      signature,
    );

    expect(recoveredAddress.toLowerCase()).toBe(fillerWallet.address.toLowerCase());
  });

  test("both parties can sign same custom payout", async () => {
    const domain = getCollateralVaultDomain(TEST_CHAIN_ID, TEST_VAULT_ADDRESS);

    const proposal = {
      betId: BigInt(TEST_BET_ID),
      creatorPayout: ethers.parseEther("70"),
      fillerPayout: ethers.parseEther("30"),
      nonce: 1n,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    };

    const creatorSig = await creatorWallet.signTypedData(
      domain,
      CUSTOM_PAYOUT_TYPES,
      proposal,
    );

    const fillerSig = await fillerWallet.signTypedData(
      domain,
      CUSTOM_PAYOUT_TYPES,
      proposal,
    );

    // Both should be valid signatures
    expect(creatorSig).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(fillerSig).toMatch(/^0x[0-9a-fA-F]{130}$/);

    // They should be different
    expect(creatorSig).not.toBe(fillerSig);
  });
});

describe("EIP-712 Settlement Proposal (P2P) Signing", () => {
  test("signs SettlementProposal with P2P domain", async () => {
    const proposal = {
      betId: BigInt(TEST_BET_ID),
      winner: creatorWallet.address,
      winsCount: 6n,
      validTrades: 10n,
      isTie: false,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      settlementNonce: 1n, // Required for nonce synchronization
    };

    const signature = await creatorWallet.signTypedData(
      P2P_DOMAIN,
      SETTLEMENT_PROPOSAL_TYPES,
      proposal,
    );

    expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  test("verifies SettlementProposal signature", async () => {
    const proposal = {
      betId: BigInt(TEST_BET_ID),
      winner: fillerWallet.address,
      winsCount: 4n,
      validTrades: 10n,
      isTie: false,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      settlementNonce: 1n,
    };

    const signature = await creatorWallet.signTypedData(
      P2P_DOMAIN,
      SETTLEMENT_PROPOSAL_TYPES,
      proposal,
    );

    const recoveredAddress = ethers.verifyTypedData(
      P2P_DOMAIN,
      SETTLEMENT_PROPOSAL_TYPES,
      proposal,
      signature,
    );

    expect(recoveredAddress.toLowerCase()).toBe(creatorWallet.address.toLowerCase());
  });

  test("tie scenario signature", async () => {
    const proposal = {
      betId: BigInt(TEST_BET_ID),
      winner: fillerWallet.address, // Filler wins on tie
      winsCount: 5n,
      validTrades: 10n,
      isTie: true,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      settlementNonce: 2n,
    };

    const signature = await fillerWallet.signTypedData(
      P2P_DOMAIN,
      SETTLEMENT_PROPOSAL_TYPES,
      proposal,
    );

    const recoveredAddress = ethers.verifyTypedData(
      P2P_DOMAIN,
      SETTLEMENT_PROPOSAL_TYPES,
      proposal,
      signature,
    );

    expect(recoveredAddress.toLowerCase()).toBe(fillerWallet.address.toLowerCase());
  });

  test("different settlementNonce produces different signature", async () => {
    const baseProposal = {
      betId: BigInt(TEST_BET_ID),
      winner: creatorWallet.address,
      winsCount: 6n,
      validTrades: 10n,
      isTie: false,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    };

    const sig1 = await creatorWallet.signTypedData(
      P2P_DOMAIN,
      SETTLEMENT_PROPOSAL_TYPES,
      { ...baseProposal, settlementNonce: 1n },
    );

    const sig2 = await creatorWallet.signTypedData(
      P2P_DOMAIN,
      SETTLEMENT_PROPOSAL_TYPES,
      { ...baseProposal, settlementNonce: 2n },
    );

    expect(sig1).not.toBe(sig2);
  });
});

describe("Domain separation", () => {
  test("CollateralVault domain differs from P2P domain", () => {
    const vaultDomain = getCollateralVaultDomain(TEST_CHAIN_ID, TEST_VAULT_ADDRESS);

    expect(vaultDomain.name).toBe("CollateralVault");
    expect(P2P_DOMAIN.name).toBe("AgiArenaP2P");
    expect(vaultDomain.name).not.toBe(P2P_DOMAIN.name);
  });

  test("CollateralVault domain includes verifyingContract", () => {
    const vaultDomain = getCollateralVaultDomain(TEST_CHAIN_ID, TEST_VAULT_ADDRESS);

    expect(vaultDomain.verifyingContract).toBe(TEST_VAULT_ADDRESS);
    expect((P2P_DOMAIN as any).verifyingContract).toBeUndefined();
  });

  test("same message signed with different domains produces different signatures", async () => {
    const vaultDomain = getCollateralVaultDomain(TEST_CHAIN_ID, TEST_VAULT_ADDRESS);

    // Sign SettlementAgreement with CollateralVault domain
    const agreement = {
      betId: BigInt(TEST_BET_ID),
      winner: creatorWallet.address,
      nonce: 1n,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    };

    const vaultSig = await creatorWallet.signTypedData(
      vaultDomain,
      SETTLEMENT_AGREEMENT_TYPES,
      agreement,
    );

    // Sign same agreement with P2P domain (this would be wrong in practice)
    const p2pSig = await creatorWallet.signTypedData(
      P2P_DOMAIN,
      SETTLEMENT_AGREEMENT_TYPES,
      agreement,
    );

    expect(vaultSig).not.toBe(p2pSig);
  });
});
