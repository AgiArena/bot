import { Wallet, TypedDataEncoder } from 'ethers';

const DATA_NODE_URL = 'http://localhost:4000';
const PRIVATE_KEY = '0xe81662053657623793d767b6cb13e614f6c6916b1488de33928baea8ce513c4c';
const WIND_ADDRESS = '0x5dE1C21682EF8b39aeB0BA9FA6068C650d3f744e';
const CHAIN_ID = 111222333;

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

async function main() {
  const wallet = new Wallet(PRIVATE_KEY);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = Date.now() % 1000000;
  const method = 'GET';
  const path = '/api/v1/prices/finnhub';
  
  const value = {
    method,
    path,
    timestamp: BigInt(timestamp),
    nonce: BigInt(nonce),
  };
  
  console.log('=== EIP-712 Debug ===');
  console.log('Domain:', JSON.stringify(domain, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  console.log('Value:', JSON.stringify(value, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  
  // Compute hashes using TypedDataEncoder
  const domainSeparator = TypedDataEncoder.hashDomain(domain);
  console.log('\nDomain separator:', domainSeparator);
  
  const structHash = TypedDataEncoder.hashStruct('DataNodeRequest', types, value);
  console.log('Struct hash:', structHash);
  
  const digest = TypedDataEncoder.hash(domain, types, value);
  console.log('Message digest:', digest);
  
  // Sign
  const signature = await wallet.signTypedData(domain, types, value);
  console.log('Signature:', signature);
  console.log('Signer:', wallet.address);
  
  // Make request
  const headers = {
    'X-Signature': signature,
    'X-Timestamp': timestamp.toString(),
    'X-Nonce': nonce.toString(),
    'X-Address': wallet.address,
    'Content-Type': 'application/json',
  };
  
  console.log('\n=== Making Request ===');
  const response = await fetch(`${DATA_NODE_URL}${path}`, { headers });
  console.log('Status:', response.status);
  const text = await response.text();
  console.log('Response:', text.slice(0, 300));
}

main().catch(console.error);
