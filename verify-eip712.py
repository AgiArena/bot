#!/usr/bin/env python3
"""
Verify EIP-712 encoding matches between TypeScript and Rust implementations.
Uses exact same algorithm as alloy-primitives.
"""

from Crypto.Hash import keccak
import struct

def keccak256(data: bytes) -> bytes:
    k = keccak.new(digest_bits=256)
    k.update(data)
    return k.digest()

def encode_u256(value: int) -> bytes:
    """Encode uint256 as 32-byte big-endian"""
    return value.to_bytes(32, 'big')

def encode_address(address: str) -> bytes:
    """Encode address as 32 bytes (12 zero bytes + 20 address bytes)"""
    addr_bytes = bytes.fromhex(address[2:])  # Remove 0x prefix
    return b'\x00' * 12 + addr_bytes

# Domain parameters
DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
NAME = "DataNode"
VERSION = "1"
CHAIN_ID = 111222333
VERIFYING_CONTRACT = "0x5dE1C21682EF8b39aeB0BA9FA6068C650d3f744e"

# Struct parameters
STRUCT_TYPE = "DataNodeRequest(string method,string path,uint256 timestamp,uint256 nonce)"
METHOD = "GET"
PATH = "/api/v1/prices/finnhub"
TIMESTAMP = 1770084386
NONCE = 386866

print("=== Domain Separator Computation ===\n")

# Domain type hash
domain_type_hash = keccak256(DOMAIN_TYPE.encode('utf-8'))
print(f"Domain type string: {DOMAIN_TYPE}")
print(f"Domain type hash: 0x{domain_type_hash.hex()}")

# Name and version hashes
name_hash = keccak256(NAME.encode('utf-8'))
version_hash = keccak256(VERSION.encode('utf-8'))
print(f"Name hash (keccak256('{NAME}')): 0x{name_hash.hex()}")
print(f"Version hash (keccak256('{VERSION}')): 0x{version_hash.hex()}")

# Chain ID and address
chain_id_bytes = encode_u256(CHAIN_ID)
address_bytes = encode_address(VERIFYING_CONTRACT)
print(f"Chain ID padded: 0x{chain_id_bytes.hex()}")
print(f"Address padded: 0x{address_bytes.hex()}")

# Domain separator
domain_data = domain_type_hash + name_hash + version_hash + chain_id_bytes + address_bytes
print(f"\nDomain data ({len(domain_data)} bytes): 0x{domain_data.hex()}")
domain_separator = keccak256(domain_data)
print(f"Domain separator: 0x{domain_separator.hex()}")

print("\n=== Expected (TypeScript) ===")
print("Domain separator: 0xb54e71ed181dc14d1d4268384ffba108241611e40a16197e69b9fb4468c862df")

print("\n=== Struct Hash Computation ===\n")

# Struct type hash
struct_type_hash = keccak256(STRUCT_TYPE.encode('utf-8'))
print(f"Struct type string: {STRUCT_TYPE}")
print(f"Struct type hash: 0x{struct_type_hash.hex()}")

# Method and path hashes
method_hash = keccak256(METHOD.encode('utf-8'))
path_hash = keccak256(PATH.encode('utf-8'))
print(f"Method hash (keccak256('{METHOD}')): 0x{method_hash.hex()}")
print(f"Path hash (keccak256('{PATH}')): 0x{path_hash.hex()}")

# Timestamp and nonce
timestamp_bytes = encode_u256(TIMESTAMP)
nonce_bytes = encode_u256(NONCE)
print(f"Timestamp padded: 0x{timestamp_bytes.hex()}")
print(f"Nonce padded: 0x{nonce_bytes.hex()}")

# Struct hash
struct_data = struct_type_hash + method_hash + path_hash + timestamp_bytes + nonce_bytes
print(f"\nStruct data ({len(struct_data)} bytes): 0x{struct_data.hex()}")
struct_hash = keccak256(struct_data)
print(f"Struct hash: 0x{struct_hash.hex()}")

print("\n=== Expected (TypeScript) ===")
print("Struct hash: 0xf126db3247e509f0c1215cdbbbfa462f367efb5c5bef8bff98534f6c2e82a0ee")

print("\n=== Message Hash Computation ===\n")

# Message = "\x19\x01" || domainSeparator || structHash
message = b'\x19\x01' + domain_separator + struct_hash
print(f"Message ({len(message)} bytes): 0x{message.hex()}")
message_hash = keccak256(message)
print(f"Message hash: 0x{message_hash.hex()}")

print("\n=== Expected (TypeScript) ===")
print("Message hash: 0xaf7fdd88b4ec5903cee293d25f8edde9e97ed9dc9aef5a5261cd1338e10d9a7d")

# Verify all match
ts_domain_sep = "b54e71ed181dc14d1d4268384ffba108241611e40a16197e69b9fb4468c862df"
ts_struct_hash = "f126db3247e509f0c1215cdbbbfa462f367efb5c5bef8bff98534f6c2e82a0ee"
ts_message_hash = "af7fdd88b4ec5903cee293d25f8edde9e97ed9dc9aef5a5261cd1338e10d9a7d"

print("\n=== Verification ===")
print(f"Domain separator match: {domain_separator.hex() == ts_domain_sep}")
print(f"Struct hash match: {struct_hash.hex() == ts_struct_hash}")
print(f"Message hash match: {message_hash.hex() == ts_message_hash}")
