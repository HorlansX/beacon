# Beacon — Agent Registry for Arc

A permissionless directory where agents and builder projects on Arc register
themselves so others can find, verify, and transact with them.

- `contracts/AgentRegistry.sol` — the registry. Anyone can `register()`; only
  the entry's owner can `update()`, `deactivate()`, or `reactivate()`.
- `script/Deploy.s.sol` — Foundry deploy script.
- `frontend/index.html` — single-file dapp (no build step). Browse, search,
  and register agents. Falls back to demo data until you set a real contract
  address.

## 1. Deploy the contract

Requires [Foundry](https://book.getfoundry.sh/).

```bash
cd beacon
forge install foundry-rs/forge-std --no-commit   # if not already installed
```

Create a `.env`:

```
PRIVATE_KEY=your_testnet_private_key
```

Get testnet USDC (used for gas) from the Circle faucet: https://faucet.circle.com
(select **Arc Testnet**).

Deploy:

```bash
source .env
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY \
  --broadcast
```

Copy the deployed address from the console output.

## 2. Point the frontend at it

Open `frontend/index.html` and set:

```js
const CONFIG = {
  registryAddress: "0xYourDeployedAddress",
  ...
};
```

Then just open `index.html` in a browser (or serve it with any static
server). No bundler needed — it loads ethers.js from a CDN.

## 3. Try it

- **Connect wallet** — prompts MetaMask (or any injected wallet) to add/switch
  to Arc Testnet (chain ID `5042002`) if it isn't already added.
- **Register agent** — signs a real transaction, gas paid in native USDC.
- The grid reads live from the contract via a read-only RPC connection, so
  entries show up for every visitor, not just the wallet that registered them.

## Notes on Arc specifics

- Arc uses USDC as native gas (18 decimals for the native representation; the
  optional ERC-20 interface at `0x3600000000000000000000000000000000000000`
  uses 6 decimals — don't mix the two).
- RPC: `https://rpc.testnet.arc.network` · Explorer: `https://testnet.arcscan.app`
- Always double-check current contract addresses against
  `https://docs.arc.io/arc/references/contract-addresses` before going further,
  since testnet infra can change.

## Extending it

Ideas if you want to take this further:
- Index `AgentRegistered` events with a small backend/indexer instead of
  reading the full list onchain each time, once the registry grows.
- Add a "verify" badge for agents that have made a minimum number of onchain
  transactions (ties registry trust to real activity, not just self-reported info).
- Let agents register a webhook or agent-card URL so other agents can
  programmatically discover how to talk to them (pairs well with Arc's
  agent-to-agent payment story).
