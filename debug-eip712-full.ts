import { keccak256, toUtf8Bytes, AbiCoder, TypedDataEncoder, Wallet, concat, hexlify, recoverAddress, solidityPackedKeccak256, encodeBytes32String } from 'ethers';

const WIND_ADDRESS = '0x5dE1C21682EF8b39aeB0BA9FA6068C650d3f744e';
const CHAIN_ID = 111222333;
const PRIVATE_KEY = '0xe81662053657623793d767b6cb13e614f6c6916b1488de33928baea8ce513c4c';

// Manual computation of EIP-712 to match Rust implementation

console.log('=== Manual EIP-712 Computation ===\n');

// 1. Domain type hash
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
const domainTypeHash = keccak256(toUtf8Bytes(DOMAIN_TYPE));
console.log('Domain type string:', DOMAIN_TYPE);
console.log('Domain type hash:', domainTypeHash);

// 2. Name and version hashes
const nameHash = keccak256(toUtf8Bytes('DataNode'));
const versionHash = keccak256(toUtf8Bytes('1'));
console.log('Name hash (keccak256("DataNode")):', nameHash);
console.log('Version hash (keccak256("1")):', versionHash);

// 3. Chain ID as 32-byte big-endian
const chainIdPadded = '0x' + BigInt(CHAIN_ID).toString(16).padStart(64, '0');
console.log('Chain ID padded (32 bytes):', chainIdPadded);

// 4. Address padded to 32 bytes (12 zero bytes + 20 address bytes)
const addressPadded = '0x' + '00'.repeat(12) + WIND_ADDRESS.slice(2).toLowerCase();
console.log('Address padded (32 bytes):', addressPadded);

// 5. Domain separator = keccak256(typeHash || nameHash || versionHash || chainId || address)
const domainData = concat([domainTypeHash, nameHash, versionHash, chainIdPadded, addressPadded]);
console.log('Domain data to hash (160 bytes):', domainData);
const domainSeparator = keccak256(domainData);
console.log('Domain separator:', domainSeparator);

// Compare with ethers
const domain = {
  name: 'DataNode',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: WIND_ADDRESS,
};
const ethersDomainSep = TypedDataEncoder.hashDomain(domain);
console.log('Ethers domain separator:', ethersDomainSep);
console.log('Domain separator match:', domainSeparator === ethersDomainSep);

console.log('\n=== Struct Hash Computation ===\n');

const timestamp = 1770084386n;
const nonce = 386866n;
const method = 'GET';
const path = '/api/v1/prices/finnhub';

// Struct type hash
const STRUCT_TYPE = 'DataNodeRequest(string method,string path,uint256 timestamp,uint256 nonce)';
const structTypeHash = keccak256(toUtf8Bytes(STRUCT_TYPE));
console.log('Struct type string:', STRUCT_TYPE);
console.log('Struct type hash:', structTypeHash);

// Hash dynamic types (strings)
const methodHash = keccak256(toUtf8Bytes(method));
const pathHash = keccak256(toUtf8Bytes(path));
console.log('Method hash (keccak256("GET")):', methodHash);
console.log('Path hash (keccak256("' + path + '")):', pathHash);

// Timestamp and nonce as 32-byte big-endian
const timestampPadded = '0x' + timestamp.toString(16).padStart(64, '0');
const noncePadded = '0x' + nonce.toString(16).padStart(64, '0');
console.log('Timestamp padded:', timestampPadded);
console.log('Nonce padded:', noncePadded);

// Struct hash = keccak256(typeHash || methodHash || pathHash || timestamp || nonce)
const structData = concat([structTypeHash, methodHash, pathHash, timestampPadded, noncePadded]);
console.log('Struct data to hash (160 bytes):', structData);
const structHash = keccak256(structData);
console.log('Struct hash:', structHash);

// Compare with ethers
const types = {
  DataNodeRequest: [
    { name: 'method', type: 'string' },
    { name: 'path', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};
const value = { method, path, timestamp, nonce };
const ethersStructHash = TypedDataEncoder.hashStruct('DataNodeRequest', types, value);
console.log('Ethers struct hash:', ethersStructHash);
console.log('Struct hash match:', structHash === ethersStructHash);

console.log('\n=== Message Hash ===\n');

// Message = "\x19\x01" || domainSeparator || structHash
const messagePrefix = hexlify(new Uint8Array([0x19, 0x01]));
const fullMessage = concat([messagePrefix, domainSeparator, structHash]);
console.log('Full message (66 bytes):', fullMessage);
const messageHash = keccak256(fullMessage);
console.log('Message hash:', messageHash);

// Compare with ethers
const ethersHash = TypedDataEncoder.hash(domain, types, value);
console.log('Ethers message hash:', ethersHash);
console.log('Message hash match:', messageHash === ethersHash);

console.log('\n=== Signature ===\n');

const wallet = new Wallet(PRIVATE_KEY);
console.log('Wallet address:', wallet.address);

const signature = await wallet.signTypedData(domain, types, value);
console.log('Signature:', signature);

// Parse signature
const r = signature.slice(0, 66);
const s = '0x' + signature.slice(66, 130);
const v = parseInt(signature.slice(130), 16);
console.log('r:', r);
console.log('s:', s);
console.log('v:', v);

// Recover
const recoveredAddress = recoverAddress(messageHash, signature);
console.log('Recovered address:', recoveredAddress);
console.log('Address match:', recoveredAddress.toLowerCase() === wallet.address.toLowerCase());

console.log('\n=== Bytes for comparison ===\n');
console.log('Domain type hash bytes:', Buffer.from(domainTypeHash.slice(2), 'hex').toString('hex'));
console.log('Struct type hash bytes:', Buffer.from(structTypeHash.slice(2), 'hex').toString('hex'));
