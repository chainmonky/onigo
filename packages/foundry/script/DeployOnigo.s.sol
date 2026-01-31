// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./DeployHelpers.s.sol";
import { Onigo } from "../contracts/Onigo.sol";
import { MockERC20 } from "../contracts/mocks/MockERC20.sol";

contract DeployOnigo is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        address broker = deployer;
        address usdc;

        if (block.chainid == 31337) {
            // Local: deploy a mock USDC
            MockERC20 mockUsdc = new MockERC20("USD Coin", "USDC", 6);
            mockUsdc.mint(deployer, 1_000_000 * 1e6);
            usdc = address(mockUsdc);
            deployments.push(Deployment("MockUSDC", usdc));
        } else {
            // TODO: set actual USDC address per chain
            usdc = address(0);
            require(usdc != address(0), "Set USDC address for this chain");
        }

        Onigo onigo = new Onigo(broker, usdc);
        deployments.push(Deployment("Onigo", address(onigo)));
    }
}
