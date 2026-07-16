const { ethers } = require("ethers");

/* ---------- Config (mirrors frontend/index.html CONFIG / ERC8004) ---------- */
const RPC_URL = "https://rpc.testnet.arc.network";
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const BEACON_REGISTRY = "0x3dEE45B67b8A3163fdBa98eE742931aAd6594477";
const BLOCK_EXPLORER_URL = "https://testnet.arcscan.app";

// Same bounded-but-generous scan window used elsewhere in Beacon, kept
// consistent so results here match what the Explorer tab shows.
const LOOKBACK_BLOCKS = 500_000;
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

/* ---------- Helpers ---------- */
async function queryLogsChunked(contract, filter, fromBlock, toBlock, chunkSize) {
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    ranges.push([start, Math.min(start + chunkSize - 1, toBlock)]);
  }
  const results = await Promise.all(
    ranges.map(([start, end]) => contract.queryFilter(filter, start, end))
  );
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

module.exports = async function handler(req, res) {
  // Free and public — no auth, no wallet, no write access. Pure read.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const rawInput = (req.query.id || "").toString().trim();
  if (!rawInput) {
    res.status(400).json({ ok: false, error: "Provide an agent ID or wallet address, e.g. /api/agent/123" });
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const identity = new ethers.Contract(IDENTITY_REGISTRY, IDENTITY_ABI, provider);

    let agentId;
    if (/^\d+$/.test(rawInput)) {
      agentId = BigInt(rawInput);
    } else if (ethers.isAddress(rawInput)) {
      const balance = await identity.balanceOf(rawInput);
      if (balance === 0n) {
        res.status(404).json({ ok: false, error: "This address has never held an ERC-8004 agent identity on Arc (confirmed via balanceOf, not just a recent-window scan)." });
        return;
      }
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - LOOKBACK_BLOCKS);
      const mintFilter = identity.filters.Transfer(ZERO_ADDRESS, rawInput, null);
      const mints = await queryLogsChunked(identity, mintFilter, fromBlock, currentBlock, CHUNK_SIZE);
      if (mints.length === 0) {
        res.status(404).json({ ok: false, error: `This address holds ${balance.toString()} identity(ies), but the mint is outside our ~${LOOKBACK_BLOCKS.toLocaleString()}-block scan window. Look it up by agent ID directly if you know it.` });
        return;
      }
      agentId = mints[mints.length - 1].args.tokenId;
    } else {
      res.status(400).json({ ok: false, error: "That doesn't look like a valid agent ID or wallet address." });
      return;
    }

    let owner, tokenURI;
    try {
      [owner, tokenURI] = await Promise.all([
        identity.ownerOf(agentId),
        identity.tokenURI(agentId)
      ]);
    } catch (err) {
      // Surface the real error rather than masking every failure as
      // "not found" — a genuinely missing token reverts differently than
      // an RPC hiccup or a bad call, and callers deserve to know which.
      res.status(404).json({
        ok: false,
        error: `Could not read agent ${agentId.toString()} from the identity registry.`,
        debug: err.shortMessage || err.reason || err.message || String(err)
      });
      return;
    }

    const reputation = new ethers.Contract(REPUTATION_REGISTRY, REPUTATION_ABI, provider);
    const currentBlock2 = await provider.getBlockNumber();
    const fromBlock2 = Math.max(0, currentBlock2 - LOOKBACK_BLOCKS);
    const repFilter = reputation.filters.NewFeedback(agentId, null);
    const repEvents = await queryLogsChunked(reputation, repFilter, fromBlock2, currentBlock2, CHUNK_SIZE);

    let metadata = null;
    const fetchUrl = toFetchableUri(tokenURI);
    if (fetchUrl) {
      try {
        const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) metadata = await resp.json();
      } catch (err) { /* best-effort only */ }
    }

    // Cross-reference Beacon's own registry.
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
    } catch (err) { /* Beacon cross-reference is best-effort context, not required */ }

    const hasReputation = repEvents.length > 0;
    let lastActivity = null;
    if (hasReputation) {
      try {
        const block = await repEvents[repEvents.length - 1].getBlock();
        lastActivity = { timestamp: block.timestamp, relative: timeAgo(block.timestamp) };
      } catch (err) { /* leave null if block lookup fails */ }
    }

    const reputationEvents = repEvents.slice().reverse().slice(0, 25).map(e => ({
      tag: e.args.tag1 || "feedback",
      score: e.args.value?.toString?.() ?? null,
      txHash: e.transactionHash,
      explorerUrl: `${BLOCK_EXPLORER_URL}/tx/${e.transactionHash}`
    }));

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

    res.status(200).json({
      ok: true,
      agentId: agentId.toString(),
      owner,
      tokenURI,
      metadata,
      registeredOnBeacon: beaconEntry,
      reputation: {
        totalEvents: repEvents.length,
        events: reputationEvents
      },
      trustCard: {
        identity: "registered",
        reputation: hasReputation ? `${repEvents.length} feedback event(s)` : "no feedback yet",
        validation: "not available in this view",
        riskSignal: hasReputation ? "has track record" : "no track record yet",
        lastActivity
      },
      summary,
      explorerUrl: `${BLOCK_EXPLORER_URL}/token/${IDENTITY_REGISTRY}?a=${agentId.toString()}`,
      scannedBlocks: [fromBlock2, currentBlock2]
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.shortMessage || err.message || "Something went wrong reading Arc testnet." });
  }
};
