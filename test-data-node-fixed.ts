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

  // Use current timestamp to avoid expiry
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = Math.floor(Math.random() * 1000000);
  const method = 'GET';

  // IMPORTANT: The path in EIP-712 signature must match what the middleware sees
  // The /api prefix is stripped by the router, so we sign /v1/prices/finnhub
  const signPath = '/v1/prices/finnhub';
  const requestPath = '/api/v1/prices/finnhub';

  const value = {
    method,
    path: signPath,  // Sign with the path as middleware sees it
    timestamp: BigInt(timestamp),
    nonce: BigInt(nonce),
  };

  console.log('=== Request Parameters ===');
  console.log('Method:', method);
  console.log('Sign path:', signPath);
  console.log('Request path:', requestPath);
  console.log('Timestamp:', timestamp);
  console.log('Nonce:', nonce);

  // Compute hashes
  const domainSeparator = TypedDataEncoder.hashDomain(domain);
  const structHash = TypedDataEncoder.hashStruct('DataNodeRequest', types, value);
  const digest = TypedDataEncoder.hash(domain, types, value);

  console.log('\n=== EIP-712 Hashes ===');
  console.log('Domain separator:', domainSeparator);
  console.log('Struct hash:', structHash);
  console.log('Message digest:', digest);

  // Sign
  const signature = await wallet.signTypedData(domain, types, value);
  console.log('\n=== Signature ===');
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

  console.log('\n=== Request Headers ===');
  console.log(JSON.stringify(headers, null, 2));

  console.log('\n=== Making Request ===');
  const response = await fetch(`${DATA_NODE_URL}${requestPath}`, { headers });
  console.log('Status:', response.status);
  const text = await response.text();
  console.log('Response:', text.slice(0, 500));

  // If failed, let's also try the health endpoint (no auth)
  if (response.status !== 200) {
    console.log('\n=== Testing Health Endpoint (no auth) ===');
    const healthResp = await fetch(`${DATA_NODE_URL}/health`);
    console.log('Health status:', healthResp.status);
    console.log('Health response:', await healthResp.text());
  }
}

main().catch(console.error);
