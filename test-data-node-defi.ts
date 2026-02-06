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
  const nonce = Math.floor(Math.random() * 1000000);
  const method = 'GET';

  // Try defi source which has data
  // Sign path WITHOUT query string (that's what middleware sees)
  const signPath = '/v1/prices/defi';
  const requestPath = '/api/v1/prices/defi?limit=10';

  const value = {
    method,
    path: signPath,
    timestamp: BigInt(timestamp),
    nonce: BigInt(nonce),
  };

  const signature = await wallet.signTypedData(domain, types, value);

  const headers = {
    'X-Signature': signature,
    'X-Timestamp': timestamp.toString(),
    'X-Nonce': nonce.toString(),
    'X-Address': wallet.address,
    'Content-Type': 'application/json',
  };

  console.log('=== Fetching DeFi Prices ===');
  const response = await fetch(`${DATA_NODE_URL}${requestPath}`, { headers });
  console.log('Status:', response.status);

  if (response.ok) {
    const data = await response.json();
    console.log('Total prices:', data.total);
    console.log('Sample prices:', JSON.stringify(data.prices.slice(0, 3), null, 2));
  } else {
    console.log('Error:', await response.text());
  }
}

main().catch(console.error);
