import { keccak256, toUtf8Bytes, AbiCoder, TypedDataEncoder, Wallet, concat, hexlify, recoverAddress } from 'ethers';

const WIND_ADDRESS = '0x5dE1C21682EF8b39aeB0BA9FA6068C650d3f744e';
const CHAIN_ID = 111222333;
const PRIVATE_KEY = '0xe81662053657623793d767b6cb13e614f6c6916b1488de33928baea8ce513c4c';

const domain = {
  name: 'DataNode',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: WIND_ADDRESS,
};

const types = {
  DataNodeRequest: [
    { name: 'method', type: 'string' },
    { name: 'path', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

const timestamp = 1770084386n;
const nonce = 386866n;
const value = {
  method: 'GET',
  path: '/api/v1/prices/finnhub',
  timestamp,
  nonce,
};

// Get hashes
const domainSeparator = TypedDataEncoder.hashDomain(domain);
const structHash = TypedDataEncoder.hashStruct('DataNodeRequest', types, value);

// Compute full message hash (what gets signed)
// "\x19\x01" || domainSeparator || structHash
const messagePrefix = hexlify(new Uint8Array([0x19, 0x01]));
const fullMessage = concat([messagePrefix, domainSeparator, structHash]);
const messageHash = keccak256(fullMessage);

console.log('Domain separator:', domainSeparator);
console.log('Struct hash:', structHash);
console.log('Message hash:', messageHash);

// Also get ethers computed hash
const ethersHash = TypedDataEncoder.hash(domain, types, value);
console.log('Ethers message hash:', ethersHash);
console.log('Hash match:', messageHash === ethersHash);

// Sign and verify
const wallet = new Wallet(PRIVATE_KEY);
console.log('\nWallet address:', wallet.address);

const signature = await wallet.signTypedData(domain, types, value);
console.log('Signature:', signature);

// Recover address
const recoveredAddress = recoverAddress(ethersHash, signature);
console.log('Recovered address:', recoveredAddress);
console.log('Address match:', recoveredAddress.toLowerCase() === wallet.address.toLowerCase());
