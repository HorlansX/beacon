const { ethers } = require("ethers");
const { createThirdwebClient, defineChain } = require("thirdweb");
const { facilitator, settlePayment } = require("thirdweb/x402");

/* ---------- Config ---------- */
const RPC_URLS = [
  "https://rpc.testnet.arc.network",
  "https://rpc.testnet.arc.io",
  "https://rpc.blockdaemon.testnet.arc.io",
  "https://rpc.drpc.testnet.arc.io",
  "https://5042002.rpc.thirdweb.com"
];

async function getWorkingProvider() {
  for (const url of RPC_URLS) {
    try {
      const provider = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 });
      await provider.getBlockNumber();
      return provider;
    } catch (e) { console.warn("RPC failed:", url); }
  }
  throw new Error("All RPC endpoints failed");
}
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const BLOCK_EXPLORER_URL = "https://testnet.arcscan.app";

const LOOKBACK_BLOCKS = 2_000_000;
const CHUNK_SIZE = 10_000;
const PRICE_USD = "$0.02";

const SERVER_WALLET_ADDRESS = "0x6E1633ED0539eC24622e9714e27446190578927A";

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  rpc: RPC_URL,
  testnet: true,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  blockExplorers: [{ name: "Arcscan", url: BLOCK_EXPLORER_URL }]
});

const IDENTITY_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)"
];

const REPUTATION_ABI = [
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"
];

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

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-payment, payment-signature");
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const rawInput = (req.query.id || "").toString().trim();
  if (!rawInput || !/^\d+$/.test(rawInput)) {
    res.status(400).json({ ok: false, error: "Provide a numeric agent ID, e.g. /api/agent/123/full" });
    return;
  }

  const secretKey = process.env.THIRDWEB_SECRET_KEY;
  if (!secretKey) {
    res.status(500).json({ ok: false, error: "THIRDWEB_SECRET_KEY is not configured" });
    return;
  }

  // ---------- Payment gate ----------
  try {
    const client = createThirdwebClient({ secretKey });
    const twFacilitator = facilitator({ client, serverWalletAddress: SERVER_WALLET_ADDRESS });

    const paymentData = req.headers["x-payment"] || req.headers["payment-signature"];
    const resourceUrl = `https://beacon-arc.vercel.app/api/agent/${rawInput}/full`;

    const result = await settlePayment({
      resourceUrl,
      method: "GET",
      paymentData,
      payTo: SERVER_WALLET_ADDRESS,
      network: arcTestnet,
      price: PRICE_USD,
      facilitator: twFacilitator
    });

    if (result.status !== 200) {
      if (result.responseHeaders) {
        Object.entries(result.responseHeaders).forEach(([k, v]) => res.setHeader(k, v));
      }
      res.status(result.status).json(result.responseBody);
      return;
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: "Payment verification failed.", debug: err.shortMessage || err.message || String(err) });
    return;
  }

  // ---------- Payment confirmed — do the actual (paid) work ----------
  try {
    const agentId = BigInt(rawInput);
    const provider = new ethers.JsonRpcProvider(RPC_URL, ARC_NETWORK, { batchMaxCount: 1, staticNetwork: ARC_NETWORK });
    const identity = new ethers.Contract(IDENTITY_REGISTRY, IDENTITY_ABI, provider);

    let owner;
    try {
      owner = await identity.ownerOf(agentId);
    } catch (err) {
      res.status(404).json({ ok: false, error: `No agent found with ID ${agentId.toString()}.` });
      return;
    }

    let tokenURI = null;
    try {
      tokenURI = await identity.tokenURI(agentId);
    } catch (err) {}

    const reputation = new ethers.Contract(REPUTATION_REGISTRY, REPUTATION_ABI, provider);
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - LOOKBACK_BLOCKS);
    const repFilter = reputation.filters.NewFeedback(agentId, null);
    const repEvents = await queryLogsChunked(reputation, repFilter, fromBlock, currentBlock, CHUNK_SIZE);

    let metadata = null;
    const fetchUrl = toFetchableUri(tokenURI);
    if (fetchUrl) {
      try {
        const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) metadata = await resp.json();
      } catch (err) {}
    }

    // Calculate aggregate stats for full history
    let aggregateScore = null;
    let tagBreakdown = {};
    if (repEvents.length > 0) {
      const scores = [];
      for (const e of repEvents) {
        const val = e.args.value;
        if (val) {
          const num = Number(val);
          scores.push(num);
          const tag = e.args.tag1 || "feedback";
          if (!tagBreakdown[tag]) tagBreakdown[tag] = { count: 0, total: 0 };
          tagBreakdown[tag].count++;
          tagBreakdown[tag].total += num;
        }
      }
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

    const fullHistory = repEvents.slice().reverse().map(e => ({
      tag: e.args.tag1 || "feedback",
      score: e.args.value?.toString?.() ?? null,
      txHash: e.transactionHash,
      explorerUrl: `${BLOCK_EXPLORER_URL}/tx/${e.transactionHash}`
    }));

    res.status(200).json({
      ok: true,
      agentId: agentId.toString(),
      owner,
      tokenURI,
      metadata,
      reputation: {
        totalEvents: repEvents.length,
        aggregateScore,
        tagBreakdown,
        events: fullHistory
      },
      scannedBlocks: [fromBlock, currentBlock],
      note: `Full history within the last ~${LOOKBACK_BLOCKS.toLocaleString()} blocks (paid tier) — significantly deeper than the free endpoint's ~100,000-block window, though still not a from-genesis guarantee.`
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Something went wrong reading Arc testnet.", debug: err.shortMessage || err.message || String(err) });
  }
};