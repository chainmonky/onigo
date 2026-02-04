//SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

// Useful for debugging. Remove when deploying to a live network.
// import "forge-std/console.sol";
import "openzeppelin-contracts/contracts/access/Ownable.sol";
import "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

// Use openzeppelin to inherit battle-tested implementations (ERC20, ERC721, etc)
// import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * A smart contract that allows changing a state variable of the contract and tracking the changes
 * It also allows the owner to withdraw the Ether in the contract
 * @author BuidlGuidl
 */
contract Onigo is Ownable {
    using SafeERC20 for IERC20;

    struct Market {
        uint8 commissionBps;
        int8 dataPower;        // e.g., -2 (10**-2 = 0.01 multiplier)
        uint16 marketId;
        uint32 dataIncrement;     // e.g., 100 (100 * dataPower per row difference)
        uint32 timeSlotWidth;     // e.g., 60 (1 minute in seconds)
        uint256 marketStartTime;
        uint256 roundLength;
        string marketName;
    }

    struct GridCell {
        uint256 timeSlotStart;
        int256 dataRangeStart;
    }

    struct SettlementData {
        uint16 marketId;
        uint32 roundId;
        GridCell[] winningCells;
        address[] players;
        uint256[] payouts;
    }

    // State Variables
    uint8 public houseCommissionBps = 200; // 2% default
    uint16 public numMarkets;
    address public broker;
    address public usdc;
    uint256 public unclaimedCommissions;
    mapping(uint16 => Market) public markets;
    mapping(address => uint256) public unclaimedPlayerPayouts; // player address => amount
    mapping(uint16 => mapping(uint32 => SettlementData)) internal settlementPerRoundPerMarket; // marketId => (roundId => settlement data)


    // Events: a way to emit log statements from smart contract that can be listened to by external parties
    event MarketCreated(uint16 indexed marketId, string marketName, uint256 marketStartTime, uint256 roundLength);
    event RoundSettled(uint16 indexed marketId, uint256 roundId, address indexed player, uint256 payout);
    event CommissionWithdrawn(address indexed owner, uint256 amount);
    event PlayerPayoutClaimed(address indexed player, uint256 amount);

    error Unauthorized();
    error InvalidMarketId();
    error InvalidRoundId();
    error RoundSettledAlready();
    error InvalidSettlementData();
    error InvalidPlayerBetData();
    error InvalidWinningCells();
    error NoAmountToClaim();

    modifier onlyBroker() {
        if (msg.sender != broker) revert Unauthorized();
        _;
    }
    
    // Constructor: Called once on contract deployment
    // Check packages/foundry/deploy/Deploy.s.sol
    constructor(address _broker, address _usdc) Ownable(msg.sender) {
        broker = _broker;
        usdc = _usdc;
    }

    function createMarket(
        string memory _marketName,
        int8 _dataPower,
        uint32 _dataIncrement,
        uint32 _timeSlotWidth,
        uint256 _roundLength
    ) external onlyOwner {
        numMarkets += 1;
        markets[numMarkets] = Market({
            commissionBps: houseCommissionBps,
            dataPower: _dataPower,
            marketId: numMarkets,
            dataIncrement: _dataIncrement,
            timeSlotWidth: _timeSlotWidth,
            marketStartTime: block.timestamp,
            roundLength: _roundLength,
            marketName: _marketName
        });

        emit MarketCreated(numMarkets, _marketName, block.timestamp, _roundLength);
    }

    function settleRound(
        uint16 marketId, 
        uint32 roundId, 
        GridCell[] calldata _winningCells,
        address[] calldata players,
        uint256[] calldata payouts
    ) external onlyBroker {
        if (marketId == 0 || marketId > numMarkets) revert InvalidMarketId();
        if (roundId == 0) revert InvalidRoundId();
        if (settlementPerRoundPerMarket[marketId][roundId].winningCells.length != 0) revert RoundSettledAlready(); // Round already settled
        if (players.length == 0 || payouts.length == 0) revert InvalidSettlementData();
        if (payouts.length != players.length) revert InvalidPlayerBetData();

        // Implementation for settling the market
        Market storage market = markets[marketId];
        uint256 roundStartTime = market.marketStartTime + (roundId - 1) * market.roundLength;
        uint256 roundEndTime = roundStartTime + market.roundLength;

        for (uint i = 0; i < _winningCells.length;) {
            if (_winningCells[i].timeSlotStart < roundStartTime  ||
                _winningCells[i].timeSlotStart >= roundEndTime) {
                revert InvalidWinningCells();
            }
            unchecked { ++i; }
        }

        settlementPerRoundPerMarket[marketId][roundId] = SettlementData({
            marketId: marketId,
            roundId: roundId,
            winningCells: _winningCells,
            players: players,
            payouts: payouts
        });

        uint256 totalCommissionToBeClaimed;
        uint256 totalPayouts;
        for (uint j = 0; j < players.length;) {
            uint256 commissionFromPlayer = (payouts[j] * market.commissionBps) / 10000;
            unclaimedPlayerPayouts[players[j]] += payouts[j] - commissionFromPlayer;
            totalPayouts += payouts[j];
            totalCommissionToBeClaimed += commissionFromPlayer;
            
            emit RoundSettled(marketId, roundId, players[j], payouts[j]);
            unchecked { ++j; }
        }

        unclaimedCommissions += totalCommissionToBeClaimed;

        

        IERC20(usdc).safeTransferFrom(broker, address(this), totalPayouts);
    }

    function claimPlayerPayout() external {
        uint256 amount = unclaimedPlayerPayouts[msg.sender];
        if (amount == 0) revert NoAmountToClaim();

        unclaimedPlayerPayouts[msg.sender] = 0;
        IERC20(usdc).safeTransfer(msg.sender, amount);
        emit PlayerPayoutClaimed(msg.sender, amount);
    }

    function withdrawCommissions() external onlyOwner {
        uint256 amount = unclaimedCommissions;
        if (amount == 0) revert NoAmountToClaim();
        unclaimedCommissions = 0;
        address ownerAddress = owner();
        IERC20(usdc).safeTransfer(ownerAddress, amount);
        emit CommissionWithdrawn(ownerAddress, amount);
    }

    function setBroker(address _broker) external onlyOwner {
        broker = _broker;
    }
}
