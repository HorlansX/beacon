// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Beacon — Agent Registry for Arc
/// @notice A public, permissionless directory of agents and builder projects on Arc.
///         Anyone can register an entry. Only the entry's owner can update or deactivate it.
contract AgentRegistry {
    struct Agent {
        uint256 id;
        address owner;          // wallet that registered this entry, also the agent's onchain identity if it transacts
        string name;
        string description;
        string category;        // e.g. "trading", "payments", "infra", "defi", "tooling"
        string url;              // repo, docs, or live app link
        uint64 registeredAt;
        uint64 updatedAt;
        bool active;
    }

    uint256 private _nextId = 1;
    mapping(uint256 => Agent) private _agents;
    mapping(address => uint256[]) private _agentsByOwner;

    event AgentRegistered(uint256 indexed id, address indexed owner, string name, string category);
    event AgentUpdated(uint256 indexed id);
    event AgentDeactivated(uint256 indexed id);
    event AgentReactivated(uint256 indexed id);

    error NotOwner();
    error InvalidId();
    error EmptyName();

    modifier onlyAgentOwner(uint256 id) {
        if (_agents[id].owner != msg.sender) revert NotOwner();
        _;
    }

    function register(
        string calldata name,
        string calldata description,
        string calldata category,
        string calldata url
    ) external returns (uint256 id) {
        if (bytes(name).length == 0) revert EmptyName();

        id = _nextId++;
        _agents[id] = Agent({
            id: id,
            owner: msg.sender,
            name: name,
            description: description,
            category: category,
            url: url,
            registeredAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            active: true
        });
        _agentsByOwner[msg.sender].push(id);

        emit AgentRegistered(id, msg.sender, name, category);
    }

    function update(
        uint256 id,
        string calldata description,
        string calldata category,
        string calldata url
    ) external onlyAgentOwner(id) {
        Agent storage a = _agents[id];
        a.description = description;
        a.category = category;
        a.url = url;
        a.updatedAt = uint64(block.timestamp);
        emit AgentUpdated(id);
    }

    function deactivate(uint256 id) external onlyAgentOwner(id) {
        _agents[id].active = false;
        _agents[id].updatedAt = uint64(block.timestamp);
        emit AgentDeactivated(id);
    }

    function reactivate(uint256 id) external onlyAgentOwner(id) {
        _agents[id].active = true;
        _agents[id].updatedAt = uint64(block.timestamp);
        emit AgentReactivated(id);
    }

    function getAgent(uint256 id) external view returns (Agent memory) {
        if (id == 0 || id >= _nextId) revert InvalidId();
        return _agents[id];
    }

    function totalAgents() external view returns (uint256) {
        return _nextId - 1;
    }

    /// @notice Returns a page of agents, newest first. Simple pagination for frontend use.
    function getAgents(uint256 offset, uint256 limit) external view returns (Agent[] memory page) {
        uint256 total = _nextId - 1;
        if (offset >= total) return new Agent[](0);

        uint256 remaining = total - offset;
        uint256 count = remaining < limit ? remaining : limit;
        page = new Agent[](count);

        // newest first: id (total - offset) down to (total - offset - count + 1)
        for (uint256 i = 0; i < count; i++) {
            uint256 id = total - offset - i;
            page[i] = _agents[id];
        }
    }

    function getAgentsByOwner(address owner) external view returns (uint256[] memory) {
        return _agentsByOwner[owner];
    }
}
