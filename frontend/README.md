# Beacon — Agent Registry for Arc

> A permissionless directory and discovery layer for AI agents on Arc's testnet. Every agent checks in. No gatekeeper.

[![Arc Testnet](https://img.shields.io/badge/network-Arc%20Testnet-16213B)](https://testnet.arcscan.app)
[![ERC-8004](https://img.shields.io/badge/standard-ERC--8004-C68A2E)](https://docs.arc.network/arc/tutorials/register-your-first-ai-agent)

---

## What is Beacon?

Beacon is a **public registry and explorer** for AI agents building on [Arc](https://arc.network) — Circle's stablecoin-native blockchain. It solves a critical problem in the emerging agentic economy:

> **"How do I know which AI agent to trust, pay, or interact with onchain?"**

Beacon answers this by:
- **Identity verification** — checking ERC-8004 identity NFTs on Arc's official registry
- **Reputation tracking** — reading onchain feedback events from Arc's reputation registry
- **Activity monitoring** — showing when agents were last active
- **Cross-referencing** — linking Beacon registrations with Arc's official registries

---

## Live Demo

**Frontend:** [https://beacon-arc.vercel.app](https://beacon-arc.vercel.app)

**API Endpoints:**
- `GET /api/agent/{id}` — Free lookup by agent ID or wallet address
- `GET /api/agent/{id}/full` — Deep history (2M blocks, paid via x402)

---

## Features

### 🔍 Agent Explorer
Look up **any** agent on Arc's ERC-8004 registry — by agent ID or wallet address — whether or not they've registered on Beacon. Reads Arc's chain directly.

### 📊 Trust Cards
Every agent gets a visual trust card showing:
- **Identity** — verified onchain registration status
- **Reputation** — count and aggregate score of feedback events
- **Risk Signal** — "has track record" vs "no track record yet"
- **Last Activity** — time since last onchain interaction

### 📝 Agent Registration
Register your agent in Beacon's directory with one transaction. Requires an ERC-8004 identity NFT first.

### 🆔 Identity Deployment
Mint a real ERC-8004 identity NFT directly from the UI — no scripts, no CLI.

### 💰 Lending & Borrowing
Live demo of Circle's official `arc-defi-lend-borrow` sample — deposit cirBTC collateral, borrow Mock USDC.

### 🔎 Testnet Activity Checker
Check any wallet's real activity on Arc testnet — transaction count, USDC balance, ERC-8004 identities held.

### 🤖 Autonomous Welcome Bot
A daily cron job that autonomously welcomes newly minted agents on Arc's reputation registry.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Vanilla HTML/JS, Ethers.js v6 |
| **Backend** | Vercel Serverless Functions (Node.js) |
| **Chain** | Arc Testnet (Chain ID: 5042002) |
| **Standard** | ERC-8004 (Agent Identity, Reputation, Validation) |
| **Payments** | x402 (thirdweb) for paid API tier |
| **RPC** | `https://rpc.testnet.arc.network` |

---

## Smart Contracts Used

| Contract | Address | Purpose |
|----------|---------|---------|
| **Identity Registry** | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | ERC-8004 agent identity NFTs |
| **Reputation Registry** | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | Onchain feedback/events |
| **Validation Registry** | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | Agent validation requests |
| **Beacon Registry** | `0x3dEE45B67b8A3163fdBa98eE742931aAd6594477` | Beacon's own directory |
| **Lending Pool** | `0x5a9e7433cD4154b6491180fa74d2Cc6a3f78bBCe` | cirBTC/USDC lending demo |

---

## API Reference

### Free Tier — `GET /api/agent/{id}`

Lookup any agent by ID (e.g. `42`) or wallet address (e.g. `0x...`).

**Response:**
```json
{
  "ok": true,
  "agentId": "42",
  "owner": "0x...",
  "tokenURI": "ipfs://...",
  "metadata": { "name": "...", "description": "..." },
  "registeredOnBeacon": { "name": "...", "category": "defi" },
  "reputation": {
    "totalEvents": 5,
    "aggregateScore": { "total": 42, "average": "8.40", "count": 5 },
    "events": [...]
  },
  "trustCard": {
    "identity": "registered",
    "reputation": "5 feedback event(s)",
    "riskSignal": "has track record"
  },
  "summary": "Agent #42 is owned by 0x..."
}
```

### Paid Tier — `GET /api/agent/{id}/full`

Deep history scan across **2,000,000 blocks** (vs 100,000 on free tier). Requires x402 payment.

**Headers:**
```
x-payment: {payment-signature}
```

---

## Local Development

```bash
# Install dependencies
npm install

# Run frontend locally
npm run dev

# Deploy to Vercel
vercel --prod
```

**Environment Variables:**
```env
THIRDWEB_SECRET_KEY=your_secret_key_here
```

---

## Why Arc?

Arc is building the infrastructure for the **agentic economy** — where autonomous AI agents coordinate, contract, and settle value in real time. Beacon contributes to this ecosystem by making agents **discoverable** and **trustable**.

---

## License

MIT — built permissionless, stays permissionless.

---

**Built with 🟠 for the Arc community.**
