// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Chainlink-compatible price feed whose answer can be set at will.
/// Used to inject a USDC depeg (F-1) on a fork.
contract MockPriceFeed {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    string public description;

    constructor(uint8 _decimals, int256 _answer, string memory _description) {
        decimals = _decimals;
        answer = _answer;
        updatedAt = block.timestamp;
        description = _description;
    }

    function setAnswer(int256 _answer) external {
        answer = _answer;
        updatedAt = block.timestamp;
    }

    /// Age the feed without changing its value (staleness testing).
    function setUpdatedAt(uint256 _updatedAt) external {
        updatedAt = _updatedAt;
    }

    function latestAnswer() external view returns (int256) {
        return answer;
    }

    function version() external pure returns (uint256) {
        return 4;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 _answer, uint256 startedAt, uint256 _updatedAt, uint80 answeredInRound)
    {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// Chainlink L2 Sequencer Uptime Feed mock.
/// answer == 0 -> sequencer UP, answer == 1 -> sequencer DOWN.
/// Used for F-2 to exercise the protocol's sequencer-down guard.
contract MockSequencerUptimeFeed {
    uint8 public constant decimals = 0;
    int256 public answer;      // 0 = up, 1 = down
    uint256 public startedAt;  // when the current status began

    constructor() {
        answer = 0;
        startedAt = block.timestamp;
    }

    function setStatus(int256 _answer, uint256 _startedAt) external {
        answer = _answer;
        startedAt = _startedAt;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 _answer, uint256 _startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (1, answer, startedAt, startedAt, 1);
    }
}
