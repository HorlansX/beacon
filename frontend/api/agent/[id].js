const { ethers } = require("ethers");

// Reverted to Arc's own public RPC — proven reliable with batchMaxCount: 1.
// thirdweb's RPC Edge needs a client ID appended when used outside their
// SDK (https://<chain>.rpc.thirdweb.com/<clientId>), and this file was
// missing that, so it's safer to stick with the endpoint we've already
// fully verified.
const RPC_URL = "https://rpc.testnet.arc.network";
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const BEACON_REGISTRY = "0x3dEE45B67b8A3163fdBa98eE742931aAd6594477";
const BLOCK_EXPLORER_URL = "https://testnet.arcscan.app";
const LOOKBACK_BLOCKS = 50_000;
const CHUNK_SIZE = 10_000;

const IDENTITY_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
];

const REPUTATION_ABI = [
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"
];

const BEACON_REGISTRY_ABI = [
  "function totalAgents() view returns (uint256)",
  "function getAgents(uint256 offset, uint256 limit) view returns (tuple(uint256 id,address owner,string name,string description,string category,string url,uint64 registeredAt,uint64 updatedAt,bool active)[])"
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Firing all chunks fully in parallel appears to overwhelm Arc's public
// RPC under load, triggering ethers' automatic retry logic repeatedly
// (observed: ~90 actual HTTP calls for what should be ~15 logical ones).
// Processing a limited number at a time trades a little latency for much
// more reliable completion.
async function queryLogsChunked(contract, filter, fromBlock, toBlock, chunkSize, concurrency = 2) {
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    ranges.push([start, Math.min(start + chunkSize - 1, toBlock)]);
  }
  const results = [];
  for (let i = 0; i < ranges.length; i += concurrency) {
    const batch = ranges.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(([start, end]) => contract.queryFilter(filter, start, end))
    );
    results.push(...batchResults);
    if (i + concurrency < ranges.length) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  return results.flat();
}

function toFetchableUri(uri) {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + uri.slice(7);
  if (uri.startsWith("http")) return uri;
  return null;
}

function timeAgo(unixSeconds) {
  const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-payment, payment-signature");
}

// Best-effort in-memory cache — persists only within a warm serverless
// instance (not guaranteed across cold starts or different instances), but
// directly helps the common case of the same agent being looked up
// repeatedly in a short window, which is exactly when we've observed Arc's
// public RPC start struggling.
const CACHE_TTL_MS = 60_000;
const cache = new Map();

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const rawInput = (req.query.id || "").toString().trim();
  if (!rawInput) {
    res.status(400).json({ ok: false, error: "Provide an agent ID or wallet address, e.g. /api/agent/123" });
    return;
  }

  const cached = cache.get(rawInput);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    res.setHeader("X-Cache", "HIT");
    res.status(200).json(cached.body);
    return;
  }

  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;
  try {
    // staticNetwork avoids ethers re-verifying the chain on every call —
    // one less source of redundant requests against an already-loaded RPC.
    const provider = new ethers.JsonRpcProvider(RPC_URL, 5042002, { batchMaxCount: 1, staticNetwork: true });
    const identity = new ethers.Contract(IDENTITY_REGISTRY, IDENTITY_ABI, provider);

    let agentId;
    let lookupMethod = "id";

    console.log(`[${elapsed()}] starting lookup for "${rawInput}"`);

    if (/^\d+$/.test(rawInput)) {
      agentId = BigInt(rawInput);
      lookupMethod = "id";
    } else if (ethers.isAddress(rawInput)) {
      lookupMethod = "address";
      const balance = await identity.balanceOf(rawInput);
      if (balance === 0n) {
        res.status(404).json({
          ok: false,
          error: "This address has never held an ERC-8004 agent identity on Arc (confirmed via balanceOf).",
          address: rawInput
        });
        return;
      }
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - LOOKBACK_BLOCKS);
      const mintFilter = identity.filters.Transfer(ZERO_ADDRESS, rawInput, null);
      const mints = await queryLogsChunked(identity, mintFilter, fromBlock, currentBlock, CHUNK_SIZE);
      if (mints.length === 0) {
        res.status(404).json({
          ok: false,
          error: `This address holds ${balance.toString()} identity(ies), but the mint is outside our ~${LOOKBACK_BLOCKS.toLocaleString()}-block scan window.`,
          address: rawInput,
          balance: balance.toString()
        });
        return;
      }
      agentId = mints[mints.length - 1].args.tokenId;
    } else {
      res.status(400).json({ ok: false, error: "That doesn't look like a valid agent ID or wallet address." });
      return;
    }

    let owner;
    try {
      owner = await identity.ownerOf(agentId);
      console.log(`[${elapsed()}] ownerOf resolved: ${owner}`);
    } catch (err) {
      res.status(404).json({
        ok: false,
        error: `No agent found with ID ${agentId.toString()}.`,
        debug: err.shortMessage || err.reason || err.message || String(err)
      });
      return;
    }

    let tokenURI = null;
    let tokenUriError = null;
    try {
      tokenURI = await identity.tokenURI(agentId);
      console.log(`[${elapsed()}] tokenURI resolved`);
    } catch (err) {
      tokenUriError = err.shortMessage || err.reason || err.message || String(err);
      console.log(`[${elapsed()}] tokenURI failed: ${tokenUriError}`);
    }

    const reputation = new ethers.Contract(REPUTATION_REGISTRY, REPUTATION_ABI, provider);
    const currentBlock2 = await provider.getBlockNumber();
    const fromBlock2 = Math.max(0, currentBlock2 - LOOKBACK_BLOCKS);
    const repFilter = reputation.filters.NewFeedback(agentId, null);
    const repEvents = await queryLogsChunked(reputation, repFilter, fromBlock2, currentBlock2, CHUNK_SIZE);
    console.log(`[${elapsed()}] reputation scan done — ${repEvents.length} events`);

    let metadata = null;
    const fetchUrl = toFetchableUri(tokenURI);
    if (fetchUrl) {
      try {
        const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) metadata = await resp.json();
      } catch (err) { /* best-effort */ }
      console.log(`[${elapsed()}] metadata fetch attempted`);
    }

    let beaconEntry = null;
    try {
      const beaconRegistry = new ethers.Contract(BEACON_REGISTRY, BEACON_REGISTRY_ABI, provider);
      const total = Number(await beaconRegistry.totalAgents());
      if (total > 0) {
        const entries = await beaconRegistry.getAgents(0, Math.min(total, 200));
        const match = entries.find(e => e.owner.toLowerCase() === owner.toLowerCase());
        if (match) {
          beaconEntry = {
            id: Number(match.id),
            name: match.name,
            description: match.description,
            category: match.category,
            url: match.url,
            active: match.active
          };
        }
      }
    } catch (err) { /* best-effort */ }
    console.log(`[${elapsed()}] beacon cross-reference done`);

    const hasReputation = repEvents.length > 0;
    let lastActivity = null;
    if (hasReputation) {
      try {
        const block = await repEvents[repEvents.length - 1].getBlock();
        lastActivity = { timestamp: block.timestamp, relative: timeAgo(block.timestamp) };
      } catch (err) { /* leave null */ }
      console.log(`[${elapsed()}] lastActivity block lookup done`);
    }

    const reputationEvents = repEvents.slice().reverse().slice(0, 25).map(e => ({
      tag: e.args.tag1 || "feedback",
      score: e.args.value?.toString?.() ?? null,
      txHash: e.transactionHash,
      explorerUrl: `${BLOCK_EXPLORER_URL}/tx/${e.transactionHash}`
    }));

    let aggregateScore = null;
    if (hasReputation) {
      const scores = repEvents.map(e => {
        const val = e.args.value;
        return val ? Number(val) : 0;
      }).filter(s => !isNaN(s));
      if (scores.length > 0) {
        const sum = scores.reduce((a, b) => a + b, 0);
        aggregateScore = {
          total: sum,
          average: (sum / scores.length).toFixed(2),
          count: scores.length,
          min: Math.min(...scores),
          max: Math.max(...scores)
        };
      }
    }

    let summary = `Agent #${agentId.toString()} is owned by ${owner}.`;
    if (metadata?.description) {
      const desc = metadata.description.length > 140 ? metadata.description.slice(0, 140) + "…" : metadata.description;
      summary += ` Its registration file describes it as: "${desc}"`;
    }
    summary += hasReputation
      ? ` It has received ${repEvents.length} onchain reputation signal${repEvents.length === 1 ? "" : "s"} so far.`
      : ` It hasn't received any onchain reputation feedback yet.`;
    if (beaconEntry) {
      summary += ` It's also listed on Beacon as "${beaconEntry.name}", categorized under ${beaconEntry.category || "other"}.`;
    }

    console.log(`[${elapsed()}] all done, sending response`);
    const responseBody = {
      ok: true,
      agentId: agentId.toString(),
      owner,
      tokenURI,
      tokenUriError,
      metadata,
      registeredOnBeacon: beaconEntry,
      reputation: {
        totalEvents: repEvents.length,
        aggregateScore,
        events: reputationEvents
      },
      trustCard: {
        identity: "registered",
        reputation: hasReputation ? `${repEvents.length} feedback event${repEvents.length === 1 ? "" : "s"}` : "no feedback yet",
        validation: "not available in this view",
        riskSignal: hasReputation ? "has track record" : "no track record yet",
        lastActivity
      },
      summary,
      explorerUrl: `${BLOCK_EXPLORER_URL}/token/${IDENTITY_REGISTRY}?a=${agentId.toString()}`,
      scannedBlocks: [fromBlock2, currentBlock2],
      lookupMethod
    };
    cache.set(rawInput, { body: responseBody, at: Date.now() });
    res.setHeader("X-Cache", "MISS");
    res.status(200).json(responseBody);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "Something went wrong reading Arc testnet.",
      debug: err.shortMessage || err.reason || err.message || String(err)
    });
  }
};
