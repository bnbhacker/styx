// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Run as an eth_call creation on the live chain (script/rh-live-check.ps1): its constructor
///      returns (block.number, ArbSys.arbBlockNumber(), block.timestamp, chainid, ok, return length)
///      as seen by the EVM inside a transaction, which is what InversePool relies on.
contract ArbProbe {
    constructor() {
        // same 50k gas cap as InversePool's constructor
        (bool ok, bytes memory ret) =
            address(100).staticcall{gas: 50_000}(abi.encodeWithSignature("arbBlockNumber()"));
        uint256 arb = ok && ret.length == 32 ? abi.decode(ret, (uint256)) : 0;
        bytes memory out = abi.encode(block.number, arb, block.timestamp, block.chainid, ok, ret.length);
        assembly {
            return(add(out, 32), mload(out))
        }
    }
}
