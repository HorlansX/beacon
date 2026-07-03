// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/AgentRegistry.sol";

contract Deploy is Script {
    function run() external returns (AgentRegistry) {
        vm.startBroadcast();
        AgentRegistry registry = new AgentRegistry();
        vm.stopBroadcast();

        console.log("AgentRegistry deployed to:", address(registry));
        return registry;
    }
}
