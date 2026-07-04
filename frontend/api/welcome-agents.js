const { ethers } = require("ethers");

/* ---------- Config (mirrors frontend/index.html CONFIG / ERC8004) ---------- */
const RPC_URL = "https://rpc.testnet.arc.network";
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

// How far back to scan each run. Hobby cron runs at most once/day and can
// land anywhere within the hour, so this is generous on purpose. Arc blocks
// are sub-2s, so 26h of blocks is comfortably under most RPC range limits
// once chunked below.
const LOOKBACK_BLOCKS = 50_000;
const CHUNK_SIZE = 2_000; // stay under typical eth_getLogs range limits
const MAX_WELCOMES_PER_RUN = 60; // hard ceiling, in case sends are unusually fast
const TIME_BUDGET_MS = 100_000; // stop sending new tx once this elapsed, leaving margin under maxDuration

const IDENTITY_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const REPUTATION_ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = ethers.ZeroHash; // correct 32-byte zero hash

/* ---------- Helpers ---------- */

// Query logs in parallel chunks so we don't exceed the RPC provider's
// block-range limit, and don't blow the function's time budget doing it
// one chunk at a time.
async function queryLogsChunked(contract, filter, fromBlock, toBlock, chunkSize) {
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    ranges.push([start, end]);
  }
  const results = await Promise.all(
    ranges.map(([start, end]) => contract.queryFilter(filter, start, end))
  );
  return results.flat();
}

module.exports = async function handler(req, res) {
  // Verify this request actually came from Vercel Cron, not a random visitor.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers["authorization"];
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const privateKey = process.env.BEACON_PRIVATE_KEY;
  if (!privateKey) {
    res.status(500).json({ error: "BEACON_PRIVATE_KEY is not configured" });
    return;
  }

  const log = [];
  const startTime = Date.now();
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(privateKey, provider);
    const beaconAddress = wallet.address;

    const identity = new ethers.Contract(IDENTITY_REGISTRY, IDENTITY_ABI, provider);
    const reputationRead = new ethers.Contract(REPUTATION_REGISTRY, REPUTATION_ABI, provider);
    const reputationWrite = new ethers.Contract(REPUTATION_REGISTRY, REPUTATION_ABI, wallet);

    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - LOOKBACK_BLOCKS);

    // 1. Find every agent identity minted in the lookback window, and every
    //    agent Beacon has already welcomed — at the same time.
    const mintFilter = identity.filters.Transfer(ZERO_ADDRESS, null, null);
    const alreadyGivenFilter = reputationRead.filters.NewFeedback(null, beaconAddress);

    const [mints, alreadyGivenEvents] = await Promise.all([
      queryLogsChunked(identity, mintFilter, fromBlock, currentBlock, CHUNK_SIZE),
      queryLogsChunked(reputationRead, alreadyGivenFilter, fromBlock, currentBlock, CHUNK_SIZE),
    ]);

    const alreadyWelcomed = new Set(
      alreadyGivenEvents.map((e) => e.args.agentId.toString())
    );

    // 3. For each newly minted agent, welcome it (unless it's Beacon itself,
    //    or already welcomed). Capped per run to stay within the time budget.
    let sentThisRun = 0;
    for (const mint of mints) {
      const agentId = mint.args.tokenId;
      const owner = mint.args.to;
      const agentIdStr = agentId.toString();

      if (owner.toLowerCase() === beaconAddress.toLowerCase()) {
        log.push({ agentId: agentIdStr, status: "skipped", reason: "this is Beacon's own identity" });
        continue;
      }
      if (alreadyWelcomed.has(agentIdStr)) {
        log.push({ agentId: agentIdStr, status: "skipped", reason: "already welcomed" });
        continue;
      }
      const outOfTime = (Date.now() - startTime) > TIME_BUDGET_MS;
      if (sentThisRun >= MAX_WELCOMES_PER_RUN || outOfTime) {
        log.push({
          agentId: agentIdStr,
          status: "deferred",
          reason: outOfTime ? "time budget reached, will pick up next run" : "per-run cap reached, will pick up next run",
        });
        continue;
      }

      try {
        const tx = await reputationWrite.giveFeedback(
          agentId,
          95, 0,
          "welcome", "",
          "", "",
          ZERO_HASH
        );
        await tx.wait();
        sentThisRun++;
        log.push({ agentId: agentIdStr, status: "welcomed", txHash: tx.hash });
      } catch (err) {
        log.push({ agentId: agentIdStr, status: "error", reason: err.shortMessage || err.message });
      }
    }

    res.status(200).json({
      ok: true,
      scannedBlocks: [fromBlock, currentBlock],
      mintsFound: mints.length,
      results: log,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.shortMessage || err.message, results: log });
  }
};
