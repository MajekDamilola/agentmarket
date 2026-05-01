import express from "express";
import cors from "cors";
import { createPublicClient, http, formatUnits, parseAbiItem, parseEventLogs, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import dotenv from "dotenv";
import { promises as fs } from "fs";
import { DatabaseSync } from "node:sqlite";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// ─── Arc Testnet connection ───────────────────────────────────────
const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http("https://rpc.testnet.arc.network"),
});

// ─── Contract addresses ───────────────────────────────────────────
const DEFAULT_JOB_BOARD_ADDRESS = "0x70586f1A7936190a6b325F98eB3F2e27eF81d628";
const STALE_JOB_BOARD_ADDRESSES = new Set([
  "0x42e4cc4836cdd7355a7ad600b51b054b03322d3f",
  "0xbcd7d1502ead084d7c94a56417b5a8a7cb91d04c",
]);

function resolveJobBoardAddress(value) {
  const address = (value || "").trim();
  if (!address || STALE_JOB_BOARD_ADDRESSES.has(address.toLowerCase())) {
    return DEFAULT_JOB_BOARD_ADDRESS;
  }
  return address;
}

const JOB_BOARD_ADDRESS = resolveJobBoardAddress(process.env.JOB_BOARD_ADDRESS);
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DAY_MS = 24 * 60 * 60 * 1000;
const PULSE_RECENT_BLOCK_LIMIT = 6;
const PULSE_SERIES_DAYS = 14;
const PULSE_FEED_LIMIT = 250;
const PULSE_LEADERBOARD_LIMIT = 10;
const PULSE_JSON_STORE_PATH = path.resolve(__dirname, "..", "cache", "pulse-store.json");
const PULSE_DB_PATH = path.resolve(__dirname, "..", "cache", "pulse-store.sqlite");
const PULSE_LANES = new Set(["build", "thread", "art"]);
const ARC_ID_UNLOCK_PRICE_USDC = "2.50";
const ARC_ID_UNLOCK_PRICE_BASE_UNITS = 2_500_000n;
const ARC_ID_NFT_MINT_PRICE_USDC = "5.00";
const ARC_ID_NFT_MINT_PRICE_BASE_UNITS = 5_000_000n;
const ARC_ID_NFT_SIGNATURE_TTL_SEC = 15 * 60;
const ARC_ID_NFT_DOMAIN_NAME = "AgentMarket Arc ID";
const ARC_ID_NFT_DOMAIN_VERSION = "1";

// ─── ABIs ─────────────────────────────────────────────────────────
const JOB_BOARD_ABI = [
  { name:"getJob", type:"function", stateMutability:"view", inputs:[{name:"jobId",type:"uint256"}], outputs:[{type:"tuple",components:[{name:"id",type:"uint256"},{name:"client",type:"address"},{name:"agent",type:"address"},{name:"title",type:"string"},{name:"description",type:"string"},{name:"taskType",type:"string"},{name:"category",type:"string"},{name:"workerType",type:"uint8"},{name:"budget",type:"uint256"},{name:"deadline",type:"uint256"},{name:"status",type:"uint8"},{name:"deliverableHash",type:"string"},{name:"createdAt",type:"uint256"},{name:"completedAt",type:"uint256"},{name:"pickedAt",type:"uint256"},{name:"milestonesCount",type:"uint256"},{name:"completedMilestones",type:"uint256"}]}] },
  { name:"getAllJobs", type:"function", stateMutability:"view", inputs:[], outputs:[{type:"tuple[]",components:[{name:"id",type:"uint256"},{name:"client",type:"address"},{name:"agent",type:"address"},{name:"title",type:"string"},{name:"description",type:"string"},{name:"taskType",type:"string"},{name:"category",type:"string"},{name:"workerType",type:"uint8"},{name:"budget",type:"uint256"},{name:"deadline",type:"uint256"},{name:"status",type:"uint8"},{name:"deliverableHash",type:"string"},{name:"createdAt",type:"uint256"},{name:"completedAt",type:"uint256"},{name:"pickedAt",type:"uint256"},{name:"milestonesCount",type:"uint256"},{name:"completedMilestones",type:"uint256"}]}] },
  { name:"getClientJobs", type:"function", stateMutability:"view", inputs:[{name:"client",type:"address"}], outputs:[{name:"",type:"uint256[]"}] },
  { name:"getAgentJobs", type:"function", stateMutability:"view", inputs:[{name:"agent",type:"address"}], outputs:[{name:"",type:"uint256[]"}] },
  { name:"getWorkerReviews", type:"function", stateMutability:"view", inputs:[{name:"worker",type:"address"}], outputs:[{type:"tuple[]",components:[{name:"jobId",type:"uint256"},{name:"reviewer",type:"address"},{name:"worker",type:"address"},{name:"rating",type:"uint8"},{name:"comment",type:"string"},{name:"timestamp",type:"uint256"}]}] },
  { name:"jobCount", type:"function", stateMutability:"view", inputs:[], outputs:[{name:"",type:"uint256"}] },
  { name:"platformFeeBps", type:"function", stateMutability:"view", inputs:[], outputs:[{name:"",type:"uint256"}] },
  { name:"getAllCampaigns", type:"function", stateMutability:"view", inputs:[], outputs:[{type:"tuple[]",components:[{name:"id",type:"uint256"},{name:"creator",type:"address"},{name:"title",type:"string"},{name:"description",type:"string"},{name:"prizePool",type:"uint256"},{name:"entryFee",type:"uint256"},{name:"maxParticipants",type:"uint256"},{name:"deadline",type:"uint256"},{name:"expired",type:"bool"},{name:"createdAt",type:"uint256"}]}] },
  { name:"getCampaign", type:"function", stateMutability:"view", inputs:[{name:"campaignId",type:"uint256"}], outputs:[{type:"tuple",components:[{name:"id",type:"uint256"},{name:"creator",type:"address"},{name:"title",type:"string"},{name:"description",type:"string"},{name:"prizePool",type:"uint256"},{name:"entryFee",type:"uint256"},{name:"maxParticipants",type:"uint256"},{name:"deadline",type:"uint256"},{name:"expired",type:"bool"},{name:"createdAt",type:"uint256"}]}] },
  { name:"getCampaignParticipants", type:"function", stateMutability:"view", inputs:[{name:"campaignId",type:"uint256"}], outputs:[{name:"",type:"address[]"}] },
  { name:"getCampaignWinners", type:"function", stateMutability:"view", inputs:[{name:"campaignId",type:"uint256"}], outputs:[{name:"",type:"address[]"}] },
  { name:"getCampaignSubmission", type:"function", stateMutability:"view", inputs:[{name:"campaignId",type:"uint256"},{name:"participant",type:"address"}], outputs:[{name:"",type:"string"}] },
  { name:"getJobMilestones", type:"function", stateMutability:"view", inputs:[{name:"jobId",type:"uint256"}], outputs:[{type:"tuple[]",components:[{name:"percentage",type:"uint256"},{name:"description",type:"string"},{name:"deliverableHash",type:"string"},{name:"submittedAt",type:"uint256"},{name:"approved",type:"bool"}]}] },
];

const IDENTITY_ABI = [
  { name:"tokenURI", type:"function", stateMutability:"view", inputs:[{name:"tokenId",type:"uint256"}], outputs:[{name:"",type:"string"}] },
  { name:"ownerOf", type:"function", stateMutability:"view", inputs:[{name:"tokenId",type:"uint256"}], outputs:[{name:"",type:"address"}] },
];

const ERC20_TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ARC_ID_NFT_MINT_EVENT = parseAbiItem("event ArcIdMinted(address indexed minter, uint256 indexed tokenId, uint256 pricePaid)");
const ARC_ID_NFT_VIEW_ABI = [
  { name: "walletTokenId", type: "function", stateMutability: "view", inputs: [{ name: "wallet", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { name: "tokenURI", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
];

const STATUS_LABELS = ["Open","Funded","Submitted","Completed","Rejected"];
const WORKER_TYPES = ["AI","Human"];
const COMPLETED_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────
function sameAddress(a, b) {
  return a?.toLowerCase() === b?.toLowerCase();
}

function isHexAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

function resolveOptionalAddress(...values) {
  for (const value of values) {
    if (isHexAddress(value) && !sameAddress(value, ZERO_ADDRESS)) {
      return String(value).trim();
    }
  }
  return "";
}

function shortWallet(address) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Anon";
}

function normalizePrivateKeyHex(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error("ARC_ID_NFT_SIGNER_PRIVATE_KEY must be a 32-byte hex private key");
  }
  return normalized;
}

function toUsdcNumber(value) {
  const amount = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(amount) ? amount : 0;
}

function formatUsdc(value) {
  return toUsdcNumber(value).toFixed(2);
}

const ARC_ID_UNLOCK_RECIPIENT = resolveOptionalAddress(
  process.env.ARC_ID_UNLOCK_RECIPIENT,
  process.env.PULSE_ARC_ID_UNLOCK_RECIPIENT,
  process.env.PLATFORM_WALLET,
  process.env.SUMMARY_AGENT_WALLET,
);
const ARC_ID_NFT_ADDRESS = resolveOptionalAddress(
  process.env.ARC_ID_NFT_ADDRESS,
  process.env.PULSE_ARC_ID_NFT_ADDRESS,
);
const ARC_ID_NFT_SIGNER_PRIVATE_KEY = normalizePrivateKeyHex(
  process.env.ARC_ID_NFT_SIGNER_PRIVATE_KEY || process.env.ARC_ID_MINT_SIGNER_PRIVATE_KEY,
);
const arcIdNftSignerAccount = ARC_ID_NFT_SIGNER_PRIVATE_KEY
  ? privateKeyToAccount(ARC_ID_NFT_SIGNER_PRIVATE_KEY)
  : null;

function utcDayKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayKeyDiff(fromDay, toDay) {
  if (!fromDay || !toDay) return null;
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

let pulseDb = null;
let pulseDbReadyPromise = null;

function isArchivedCompletedJob(job, now = Date.now()) {
  return Number(job?.status) === 3 && Number(job?.completedAt) > 0 && (now - Number(job.completedAt)) > COMPLETED_JOB_RETENTION_MS;
}

function isClosedCampaign(campaign, now = Date.now()) {
  const deadline = Number(campaign?.deadline || 0);
  return Boolean(campaign?.expired) || (deadline > 0 && now > deadline);
}

function formatJob(job) {
  const status = Number(job.status);
  const deadline = Number(job.deadline) * 1000;
  const isExpired = deadline > 0 && [0, 1].includes(status) && Date.now() > deadline;
  return {
    id: Number(job.id),
    client: job.client,
    agent: job.agent,
    title: job.title,
    description: job.description,
    category: job.category,
    workerType: Number(job.workerType),
    workerTypeLabel: WORKER_TYPES[Number(job.workerType)],
    taskType: job.taskType,
    budget: formatUnits(job.budget, 6),
    budgetRaw: job.budget.toString(),
    status,
    statusLabel: STATUS_LABELS[status],
    isExpired,
    deliverableHash: job.deliverableHash,
    createdAt: Number(job.createdAt) * 1000,
    completedAt: Number(job.completedAt) * 1000,
    pickedAt: Number(job.pickedAt) * 1000,
    deadline,
    milestonesCount: Number(job.milestonesCount),
    completedMilestones: Number(job.completedMilestones),
    explorerUrl: `https://testnet.arcscan.app/address/${JOB_BOARD_ADDRESS}`,
  };
}

async function getAllFormattedJobs() {
  const jobs = await publicClient.readContract({
    address: JOB_BOARD_ADDRESS,
    abi: JOB_BOARD_ABI,
    functionName: "getAllJobs",
  });
  return jobs.map(formatJob);
}

function formatCampaign(campaign) {
  return {
    id: Number(campaign.id),
    creator: campaign.creator,
    title: campaign.title,
    description: campaign.description,
    prizePool: formatUnits(campaign.prizePool, 6),
    prizePoolRaw: campaign.prizePool.toString(),
    entryFee: formatUnits(campaign.entryFee, 6),
    entryFeeRaw: campaign.entryFee.toString(),
    maxParticipants: Number(campaign.maxParticipants),
    deadline: Number(campaign.deadline) * 1000,
    expired: campaign.expired,
    createdAt: Number(campaign.createdAt) * 1000,
  };
}

async function getAllFormattedCampaigns() {
  const campaigns = await publicClient.readContract({
    address: JOB_BOARD_ADDRESS,
    abi: JOB_BOARD_ABI,
    functionName: "getAllCampaigns",
  });
  return campaigns.map(formatCampaign);
}

async function getJobsByIds(jobIds) {
  const jobs = await Promise.all(
    jobIds.map(id =>
      publicClient.readContract({
        address: JOB_BOARD_ADDRESS,
        abi: JOB_BOARD_ABI,
        functionName: "getJob",
        args: [id],
      })
    )
  );
  return jobs.map(formatJob);
}

// Tries indexed lookup first, falls back to filtering getAllJobs
async function getJobsForAddress(address, idFunctionName, matchesAddress) {
  const normalized = address.toLowerCase();
  try {
    const jobIds = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: idFunctionName,
      args: [normalized],
    });
    if (jobIds.length > 0) return await getJobsByIds(jobIds);
  } catch (err) {
    console.warn(`Falling back to getAllJobs for ${idFunctionName}:`, err.message);
  }
  const allJobs = await getAllFormattedJobs();
  return allJobs.filter(job => matchesAddress(job, normalized));
}

async function getRecentBlocks(limit = PULSE_RECENT_BLOCK_LIMIT) {
  const latestBlockNumber = await publicClient.getBlockNumber();
  const blockNumbers = [];

  for (let offset = 0n; offset < BigInt(limit); offset++) {
    if (latestBlockNumber < offset) break;
    blockNumbers.push(latestBlockNumber - offset);
  }

  const blocks = await Promise.all(
    blockNumbers.map(blockNumber => publicClient.getBlock({ blockNumber }))
  );

  return blocks.map(block => {
    const timestamp = Number(block.timestamp) * 1000;
    return {
      number: Number(block.number),
      hash: block.hash,
      timestamp,
      txCount: Array.isArray(block.transactions) ? block.transactions.length : 0,
      ageSec: Math.max(0, Math.floor((Date.now() - timestamp) / 1000)),
    };
  });
}

function averageBlockTimeSec(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 2) return 0;
  const deltas = [];
  for (let index = 0; index < blocks.length - 1; index++) {
    const delta = (Number(blocks[index].timestamp) - Number(blocks[index + 1].timestamp)) / 1000;
    if (delta > 0) deltas.push(delta);
  }
  if (!deltas.length) return 0;
  const avg = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  return Number(avg.toFixed(2));
}

function buildPulseSeries(jobs, days = PULSE_SERIES_DAYS) {
  const now = Date.now();
  const points = [];
  const bucketMap = new Map();

  for (let index = days - 1; index >= 0; index--) {
    const dayTimestamp = now - (index * DAY_MS);
    const key = utcDayKey(dayTimestamp);
    const point = { date: key, volumeUsdc: 0, jobs: 0 };
    points.push(point);
    bucketMap.set(key, point);
  }

  for (const job of jobs) {
    const key = utcDayKey(job.createdAt);
    const bucket = bucketMap.get(key);
    if (!bucket) continue;
    bucket.volumeUsdc += toUsdcNumber(job.budget);
    bucket.jobs += 1;
  }

  return points.map(point => ({
    date: point.date,
    jobs: point.jobs,
    volumeUsdc: formatUsdc(point.volumeUsdc),
  }));
}

function buildCategoryBreakdown(jobs) {
  const summary = new Map();

  for (const job of jobs) {
    const category = String(job.category || "Uncategorized").trim() || "Uncategorized";
    if (!summary.has(category)) {
      summary.set(category, { category, volumeUsdc: 0, jobs: 0 });
    }
    const row = summary.get(category);
    row.volumeUsdc += toUsdcNumber(job.budget);
    row.jobs += 1;
  }

  return [...summary.values()]
    .sort((a, b) => b.volumeUsdc - a.volumeUsdc)
    .map(row => ({
      category: row.category,
      jobs: row.jobs,
      volumeUsdc: formatUsdc(row.volumeUsdc),
    }));
}

function buildTrackedAppRankings(jobs, campaigns) {
  const now = Date.now();
  const weekMs = 7 * DAY_MS;
  const previousWeekStart = now - (2 * weekMs);
  const currentWeekStart = now - weekMs;

  const allVolume = jobs.reduce((sum, job) => sum + toUsdcNumber(job.budget), 0)
    + campaigns.reduce((sum, campaign) => sum + toUsdcNumber(campaign.prizePool), 0);

  const thisWeekVolume = jobs
    .filter(job => job.createdAt >= currentWeekStart)
    .reduce((sum, job) => sum + toUsdcNumber(job.budget), 0)
    + campaigns
      .filter(campaign => campaign.createdAt >= currentWeekStart)
      .reduce((sum, campaign) => sum + toUsdcNumber(campaign.prizePool), 0);

  const previousWeekVolume = jobs
    .filter(job => job.createdAt >= previousWeekStart && job.createdAt < currentWeekStart)
    .reduce((sum, job) => sum + toUsdcNumber(job.budget), 0)
    + campaigns
      .filter(campaign => campaign.createdAt >= previousWeekStart && campaign.createdAt < currentWeekStart)
      .reduce((sum, campaign) => sum + toUsdcNumber(campaign.prizePool), 0);

  const activeWallets = new Set();
  for (const job of jobs) {
    if (job.client && !sameAddress(job.client, ZERO_ADDRESS)) activeWallets.add(job.client.toLowerCase());
    if (job.agent && !sameAddress(job.agent, ZERO_ADDRESS)) activeWallets.add(job.agent.toLowerCase());
  }
  for (const campaign of campaigns) {
    if (campaign.creator && !sameAddress(campaign.creator, ZERO_ADDRESS)) activeWallets.add(campaign.creator.toLowerCase());
  }

  let growthDirection = "flat";
  if (thisWeekVolume > previousWeekVolume) growthDirection = "up";
  if (thisWeekVolume < previousWeekVolume) growthDirection = "down";

  return [{
    rank: 1,
    id: "agentmarket",
    name: "AgentMarket",
    category: "AI / Work",
    description: "Tracked beta view based on the live AgentMarket Arc contracts.",
    volumeUsdc: formatUsdc(allVolume),
    weeklyVolumeUsdc: formatUsdc(thisWeekVolume),
    previousWeekVolumeUsdc: formatUsdc(previousWeekVolume),
    growthDirection,
    growthPercent: previousWeekVolume > 0
      ? Number((((thisWeekVolume - previousWeekVolume) / previousWeekVolume) * 100).toFixed(1))
      : null,
    activeWallets: activeWallets.size,
    jobs: jobs.length,
    campaigns: campaigns.length,
    liveContracts: [JOB_BOARD_ADDRESS],
    status: "Tracked beta",
  }];
}

function pulseMetaGet(db, key) {
  const row = db.prepare("SELECT value FROM pulse_meta WHERE key = ?").get(key);
  return row ? String(row.value || "") : "";
}

function pulseMetaSet(db, key, value) {
  db.prepare(`
    INSERT INTO pulse_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, String(value ?? ""), Date.now());
}

function normalizePulseProfileRecord(record) {
  if (!record) return null;
  return {
    wallet: String(record.wallet || "").toLowerCase(),
    displayName: record.display_name || record.displayName || "",
    points: Number(record.points || 0),
    currentStreak: Number(record.current_streak ?? record.currentStreak ?? 0),
    longestStreak: Number(record.longest_streak ?? record.longestStreak ?? 0),
    totalCheckIns: Number(record.total_checkins ?? record.totalCheckIns ?? 0),
    lastCheckInDay: record.last_check_in_day ?? record.lastCheckInDay ?? "",
    createdAt: Number(record.created_at ?? record.createdAt ?? 0),
    updatedAt: Number(record.updated_at ?? record.updatedAt ?? 0),
  };
}

function normalizePulsePostRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    lane: record.lane,
    title: record.title,
    body: record.body,
    link: record.link || "",
    wallet: String(record.wallet || "").toLowerCase(),
    authorName: record.author_name || record.authorName || "",
    createdAt: Number(record.created_at ?? record.createdAt ?? Date.now()),
    upvotes: Number(record.upvotes || 0),
    upvotedByViewer: Boolean(record.upvoted_by_viewer ?? record.upvotedByViewer ?? false),
    upvoters: Array.isArray(record.upvoters) ? record.upvoters : [],
  };
}

async function migrateLegacyPulseStore(db) {
  if (pulseMetaGet(db, "storage-version")) return;

  const existingPosts = Number(db.prepare("SELECT COUNT(*) AS count FROM pulse_posts").get()?.count || 0);
  const existingProfiles = Number(db.prepare("SELECT COUNT(*) AS count FROM pulse_profiles").get()?.count || 0);
  if (existingPosts > 0 || existingProfiles > 0) {
    pulseMetaSet(db, "storage-version", "sqlite-v1");
    return;
  }

  let legacyStore = null;
  try {
    const raw = await fs.readFile(PULSE_JSON_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    legacyStore = {
      feedPosts: Array.isArray(parsed?.feedPosts) ? parsed.feedPosts : [],
      profiles: parsed?.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {},
    };
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn("Could not read legacy ArcPulse JSON store:", err.message);
    }
  }

  if (!legacyStore) {
    pulseMetaSet(db, "storage-version", "sqlite-v1");
    return;
  }

  const importLegacyStore = db.transaction((store) => {
    const upsertProfile = db.prepare(`
      INSERT INTO pulse_profiles (
        wallet, display_name, points, current_streak, longest_streak,
        total_checkins, last_check_in_day, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet) DO UPDATE SET
        display_name = excluded.display_name,
        points = excluded.points,
        current_streak = excluded.current_streak,
        longest_streak = excluded.longest_streak,
        total_checkins = excluded.total_checkins,
        last_check_in_day = excluded.last_check_in_day,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);
    const upsertPost = db.prepare(`
      INSERT INTO pulse_posts (id, lane, title, body, link, wallet, author_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        lane = excluded.lane,
        title = excluded.title,
        body = excluded.body,
        link = excluded.link,
        wallet = excluded.wallet,
        author_name = excluded.author_name,
        created_at = excluded.created_at
    `);
    const insertUpvote = db.prepare(`
      INSERT OR IGNORE INTO pulse_post_upvotes (post_id, wallet, created_at)
      VALUES (?, ?, ?)
    `);

    for (const profile of Object.values(store.profiles || {})) {
      const item = normalizePulseProfileRecord(profile);
      if (!item?.wallet) continue;
      upsertProfile.run(
        item.wallet.toLowerCase(),
        item.displayName || "",
        item.points,
        item.currentStreak,
        item.longestStreak,
        item.totalCheckIns,
        item.lastCheckInDay || "",
        item.createdAt || Date.now(),
        item.updatedAt || Date.now(),
      );
    }

    for (const post of store.feedPosts || []) {
      const item = normalizePulsePostRecord(post);
      if (!item?.id || !item?.wallet || !PULSE_LANES.has(item.lane)) continue;
      const createdAt = item.createdAt || Date.now();
      upsertPost.run(
        item.id,
        item.lane,
        item.title || "Untitled post",
        item.body || "",
        item.link || "",
        item.wallet.toLowerCase(),
        item.authorName || shortWallet(item.wallet),
        createdAt,
      );
      for (const upvoter of item.upvoters || []) {
        if (!upvoter) continue;
        insertUpvote.run(item.id, String(upvoter).toLowerCase(), createdAt);
      }
    }
  });

  importLegacyStore(legacyStore);
  pulseMetaSet(db, "storage-version", "sqlite-v1");
}

async function ensurePulseDatabase() {
  if (pulseDb) return pulseDb;
  if (!pulseDbReadyPromise) {
    pulseDbReadyPromise = (async () => {
      await fs.mkdir(path.dirname(PULSE_DB_PATH), { recursive: true });
      const db = new DatabaseSync(PULSE_DB_PATH);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS pulse_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pulse_profiles (
          wallet TEXT PRIMARY KEY,
          display_name TEXT NOT NULL DEFAULT '',
          points INTEGER NOT NULL DEFAULT 0,
          current_streak INTEGER NOT NULL DEFAULT 0,
          longest_streak INTEGER NOT NULL DEFAULT 0,
          total_checkins INTEGER NOT NULL DEFAULT 0,
          last_check_in_day TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pulse_posts (
          id TEXT PRIMARY KEY,
          lane TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          link TEXT NOT NULL DEFAULT '',
          wallet TEXT NOT NULL,
          author_name TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pulse_post_upvotes (
          post_id TEXT NOT NULL,
          wallet TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (post_id, wallet),
          FOREIGN KEY (post_id) REFERENCES pulse_posts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS pulse_arc_id_unlocks (
          wallet TEXT PRIMARY KEY,
          unlocked_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          tx_hash TEXT NOT NULL DEFAULT '',
          payment_amount_usdc TEXT NOT NULL DEFAULT '0.00',
          recipient TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS pulse_arc_id_nft_mints (
          wallet TEXT PRIMARY KEY,
          token_id TEXT NOT NULL DEFAULT '',
          tx_hash TEXT NOT NULL DEFAULT '',
          metadata_uri TEXT NOT NULL DEFAULT '',
          minted_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_pulse_posts_created_at ON pulse_posts(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pulse_posts_lane_created_at ON pulse_posts(lane, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pulse_profiles_points ON pulse_profiles(points DESC, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pulse_profiles_streak ON pulse_profiles(current_streak DESC, longest_streak DESC, points DESC);
        CREATE INDEX IF NOT EXISTS idx_pulse_upvotes_wallet ON pulse_post_upvotes(wallet);
        CREATE INDEX IF NOT EXISTS idx_pulse_arc_id_unlocks_updated_at ON pulse_arc_id_unlocks(updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pulse_arc_id_unlocks_tx_hash ON pulse_arc_id_unlocks(tx_hash) WHERE tx_hash <> '';
        CREATE INDEX IF NOT EXISTS idx_pulse_arc_id_nft_mints_updated_at ON pulse_arc_id_nft_mints(updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pulse_arc_id_nft_mints_tx_hash ON pulse_arc_id_nft_mints(tx_hash) WHERE tx_hash <> '';
      `);
      const unlockColumns = new Set(db.prepare("PRAGMA table_info(pulse_arc_id_unlocks)").all().map(column => String(column.name || "")));
      if (!unlockColumns.has("tx_hash")) {
        db.exec("ALTER TABLE pulse_arc_id_unlocks ADD COLUMN tx_hash TEXT NOT NULL DEFAULT '';");
      }
      if (!unlockColumns.has("payment_amount_usdc")) {
        db.exec("ALTER TABLE pulse_arc_id_unlocks ADD COLUMN payment_amount_usdc TEXT NOT NULL DEFAULT '0.00';");
      }
      if (!unlockColumns.has("recipient")) {
        db.exec("ALTER TABLE pulse_arc_id_unlocks ADD COLUMN recipient TEXT NOT NULL DEFAULT '';");
      }
      const nftMintColumns = new Set(db.prepare("PRAGMA table_info(pulse_arc_id_nft_mints)").all().map(column => String(column.name || "")));
      if (!nftMintColumns.has("token_id")) {
        db.exec("ALTER TABLE pulse_arc_id_nft_mints ADD COLUMN token_id TEXT NOT NULL DEFAULT '';");
      }
      if (!nftMintColumns.has("tx_hash")) {
        db.exec("ALTER TABLE pulse_arc_id_nft_mints ADD COLUMN tx_hash TEXT NOT NULL DEFAULT '';");
      }
      if (!nftMintColumns.has("metadata_uri")) {
        db.exec("ALTER TABLE pulse_arc_id_nft_mints ADD COLUMN metadata_uri TEXT NOT NULL DEFAULT '';");
      }
      if (!nftMintColumns.has("minted_at")) {
        db.exec(`ALTER TABLE pulse_arc_id_nft_mints ADD COLUMN minted_at INTEGER NOT NULL DEFAULT ${Date.now()};`);
      }
      if (!nftMintColumns.has("updated_at")) {
        db.exec(`ALTER TABLE pulse_arc_id_nft_mints ADD COLUMN updated_at INTEGER NOT NULL DEFAULT ${Date.now()};`);
      }
      await migrateLegacyPulseStore(db);
      pulseDb = db;
      return db;
    })();
  }
  return pulseDbReadyPromise;
}

function normalizePulseLane(value) {
  const lane = String(value || "").trim().toLowerCase();
  if (!PULSE_LANES.has(lane)) throw new Error("Lane must be build, thread, or art");
  return lane;
}

function normalizePulseText(value, label, maxLength, { allowEmpty = false, collapseWhitespace = true } = {}) {
  const raw = String(value ?? "");
  const text = collapseWhitespace ? raw.trim().replace(/\s+/g, " ") : raw.trim();
  if (!allowEmpty && !text) throw new Error(`${label} is required`);
  if (text.length > maxLength) throw new Error(`${label} is too long`);
  return text;
}

function normalizePulseUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid");
    return url.toString();
  } catch {
    throw new Error("Link must be a valid http or https URL");
  }
}

function getComputedCurrentStreak(profile, todayKey = utcDayKey(Date.now())) {
  const base = Number(profile?.currentStreak || 0);
  if (!profile?.lastCheckInDay) return 0;
  const diff = dayKeyDiff(profile.lastCheckInDay, todayKey);
  if (diff === null) return base;
  if (diff <= 1) return base;
  return 0;
}

function getPulseProfileRecord(db, wallet) {
  const row = db.prepare("SELECT * FROM pulse_profiles WHERE wallet = ?").get(String(wallet || "").toLowerCase());
  return normalizePulseProfileRecord(row);
}

function ensurePulseProfile(db, wallet, displayName = "") {
  const canonicalWallet = String(wallet || "").toLowerCase();
  const now = Date.now();
  db.prepare(`
    INSERT INTO pulse_profiles (
      wallet, display_name, points, current_streak, longest_streak,
      total_checkins, last_check_in_day, created_at, updated_at
    )
    VALUES (?, ?, 0, 0, 0, 0, '', ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET
      display_name = CASE
        WHEN excluded.display_name <> '' THEN excluded.display_name
        ELSE pulse_profiles.display_name
      END,
      updated_at = CASE
        WHEN excluded.display_name <> '' THEN excluded.updated_at
        ELSE pulse_profiles.updated_at
      END
  `).run(canonicalWallet, displayName || "", now, now);
  return getPulseProfileRecord(db, canonicalWallet);
}

function formatPulseProfile(profile) {
  const todayKey = utcDayKey(Date.now());
  const currentStreak = getComputedCurrentStreak(profile, todayKey);
  return {
    wallet: profile.wallet,
    displayName: profile.displayName || shortWallet(profile.wallet),
    points: Number(profile.points || 0),
    currentStreak,
    longestStreak: Number(profile.longestStreak || 0),
    totalCheckIns: Number(profile.totalCheckIns || 0),
    lastCheckInDay: profile.lastCheckInDay || "",
    canCheckInToday: profile.lastCheckInDay !== todayKey,
    updatedAt: Number(profile.updatedAt || 0),
  };
}

function formatPulsePost(post, viewerWallet = "") {
  const item = normalizePulsePostRecord(post);
  const viewer = viewerWallet ? viewerWallet.toLowerCase() : "";
  const upvoters = Array.isArray(item?.upvoters) ? item.upvoters : [];
  const upvotes = item?.upvotes > 0 ? item.upvotes : upvoters.length;
  const upvotedByViewer = item?.upvotedByViewer || (viewer ? upvoters.includes(viewer) : false);
  return {
    id: item.id,
    lane: item.lane,
    title: item.title,
    body: item.body,
    link: item.link || "",
    authorName: item.authorName || shortWallet(item.wallet),
    wallet: item.wallet,
    createdAt: Number(item.createdAt || Date.now()),
    upvotes,
    upvotedByViewer,
  };
}

function getPulseCommunityResponse(db, laneFilter = "all", viewerWallet = "") {
  const lane = String(laneFilter || "all").trim().toLowerCase();
  if (lane !== "all" && !PULSE_LANES.has(lane)) {
    throw new Error("Lane filter must be all, build, thread, or art");
  }

  const counts = {
    all: Number(db.prepare("SELECT COUNT(*) AS count FROM pulse_posts").get()?.count || 0),
    build: 0,
    thread: 0,
    art: 0,
  };
  const laneCounts = db.prepare(`
    SELECT lane, COUNT(*) AS count
    FROM pulse_posts
    GROUP BY lane
  `).all();
  for (const row of laneCounts) {
    if (counts[row.lane] !== undefined) counts[row.lane] = Number(row.count || 0);
  }

  const items = db.prepare(`
    SELECT
      p.id,
      p.lane,
      p.title,
      p.body,
      p.link,
      p.wallet,
      p.author_name,
      p.created_at,
      COUNT(v.wallet) AS upvotes,
      MAX(CASE WHEN v.wallet = ? THEN 1 ELSE 0 END) AS upvoted_by_viewer
    FROM pulse_posts p
    LEFT JOIN pulse_post_upvotes v ON v.post_id = p.id
    WHERE (? = 'all' OR p.lane = ?)
    GROUP BY p.id
    ORDER BY upvotes DESC, p.created_at DESC
    LIMIT ?
  `).all(viewerWallet ? viewerWallet.toLowerCase() : "", lane, lane, PULSE_FEED_LIMIT).map(post => formatPulsePost(post, viewerWallet));

  return { lane, counts, items };
}

function getPulseLeaderboards(db) {
  const profiles = db.prepare("SELECT * FROM pulse_profiles").all().map(row => formatPulseProfile(normalizePulseProfileRecord(row)));
  const topEarners = [...profiles]
    .filter(profile => profile.points > 0)
    .sort((a, b) => b.points - a.points || b.longestStreak - a.longestStreak || b.updatedAt - a.updatedAt)
    .slice(0, PULSE_LEADERBOARD_LIMIT);
  const longestStreaks = [...profiles]
    .filter(profile => profile.currentStreak > 0 || profile.longestStreak > 0)
    .sort((a, b) => b.currentStreak - a.currentStreak || b.longestStreak - a.longestStreak || b.points - a.points)
    .slice(0, PULSE_LEADERBOARD_LIMIT);

  return { topEarners, longestStreaks };
}

function getPulseStorageCounts(db) {
  return {
    communityPosts: Number(db.prepare("SELECT COUNT(*) AS count FROM pulse_posts").get()?.count || 0),
    pulseProfiles: Number(db.prepare("SELECT COUNT(*) AS count FROM pulse_profiles").get()?.count || 0),
  };
}

function formatPulseCalendarLabel(timestamp) {
  if (!timestamp) return "No activity yet";
  try {
    return new Date(Number(timestamp)).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return "No activity yet";
  }
}

function createPulseWalletActivity(wallet) {
  return {
    wallet: String(wallet || "").toLowerCase(),
    displayName: "",
    points: 0,
    currentStreak: 0,
    longestStreak: 0,
    totalCheckIns: 0,
    jobsAsClient: 0,
    jobsAsWorker: 0,
    campaignsCreated: 0,
    postsShared: 0,
    postUpvotesEarned: 0,
    trackedVolumeUsdc: 0,
    memberSince: 0,
    laneCounts: {
      build: 0,
      thread: 0,
      art: 0,
    },
  };
}

function ensurePulseWalletActivity(map, wallet) {
  const canonicalWallet = String(wallet || "").toLowerCase();
  if (!canonicalWallet || sameAddress(canonicalWallet, ZERO_ADDRESS)) return null;
  if (!map.has(canonicalWallet)) {
    map.set(canonicalWallet, createPulseWalletActivity(canonicalWallet));
  }
  return map.get(canonicalWallet);
}

function notePulseWalletTimestamp(entry, timestamp) {
  const value = Number(timestamp || 0);
  if (!entry || value <= 0) return;
  if (!entry.memberSince || value < entry.memberSince) {
    entry.memberSince = value;
  }
}

function resolvePulseLaneLabel(laneCounts = {}, fallback = "") {
  let winner = "";
  let winnerCount = 0;
  for (const lane of ["build", "thread", "art"]) {
    const count = Number(laneCounts?.[lane] || 0);
    if (count > winnerCount) {
      winner = lane;
      winnerCount = count;
    }
  }

  const lane = winner || fallback;
  if (lane === "thread") return "Thread";
  if (lane === "art") return "Art";
  if (lane === "build") return "Build";
  return "None yet";
}

function formatPulseWalletActivity(entry) {
  const trackedVolumeUsdcRaw = Number((Number(entry.trackedVolumeUsdc || 0)).toFixed(2));
  const totalTrackedActions = Number(entry.jobsAsClient || 0)
    + Number(entry.jobsAsWorker || 0)
    + Number(entry.campaignsCreated || 0)
    + Number(entry.postsShared || 0)
    + Number(entry.totalCheckIns || 0);

  const activityScore = Math.round(
    (totalTrackedActions * 14)
    + trackedVolumeUsdcRaw
    + Number(entry.points || 0)
    + (Number(entry.longestStreak || 0) * 4)
    + (Number(entry.postUpvotesEarned || 0) * 3)
  );

  return {
    wallet: entry.wallet,
    displayName: entry.displayName || shortWallet(entry.wallet),
    points: Number(entry.points || 0),
    currentStreak: Number(entry.currentStreak || 0),
    longestStreak: Number(entry.longestStreak || 0),
    totalCheckIns: Number(entry.totalCheckIns || 0),
    jobsAsClient: Number(entry.jobsAsClient || 0),
    jobsAsWorker: Number(entry.jobsAsWorker || 0),
    campaignsCreated: Number(entry.campaignsCreated || 0),
    postsShared: Number(entry.postsShared || 0),
    postUpvotesEarned: Number(entry.postUpvotesEarned || 0),
    trackedVolumeUsdc: formatUsdc(trackedVolumeUsdcRaw),
    trackedVolumeUsdcRaw,
    memberSince: Number(entry.memberSince || 0),
    memberSinceLabel: formatPulseCalendarLabel(entry.memberSince),
    totalTrackedActions,
    mostUsedLane: resolvePulseLaneLabel(entry.laneCounts, totalTrackedActions > 0 ? "build" : ""),
    mostUsedApp: totalTrackedActions > 0 ? "AgentMarket" : "Awaiting first signal",
    activityScore,
  };
}

function describePulseArcIdBadge(summary, topPercent) {
  if (!summary.totalTrackedActions && !summary.points) return "Network Arrival";
  if (topPercent <= 10 || summary.activityScore >= 220) return "Arc Vanguard";
  if (topPercent <= 30 || summary.activityScore >= 120) return "Pulse Builder";
  if (summary.postsShared > 0 || summary.totalCheckIns > 0) return "Signal Starter";
  return "Fresh Builder";
}

function buildPulseWalletAnalytics(db, jobs = [], campaigns = []) {
  const analytics = new Map();

  for (const row of db.prepare("SELECT * FROM pulse_profiles").all()) {
    const normalized = normalizePulseProfileRecord(row);
    if (!normalized?.wallet) continue;
    const profile = formatPulseProfile(normalized);
    const entry = ensurePulseWalletActivity(analytics, normalized.wallet);
    if (!entry) continue;
    entry.displayName = profile.displayName || entry.displayName;
    entry.points = profile.points;
    entry.currentStreak = profile.currentStreak;
    entry.longestStreak = profile.longestStreak;
    entry.totalCheckIns = profile.totalCheckIns;
    notePulseWalletTimestamp(entry, normalized.createdAt || normalized.updatedAt);
  }

  const authoredPosts = db.prepare(`
    SELECT
      p.wallet,
      p.lane,
      p.created_at,
      COUNT(v.wallet) AS upvotes
    FROM pulse_posts p
    LEFT JOIN pulse_post_upvotes v ON v.post_id = p.id
    GROUP BY p.id
  `).all();

  for (const post of authoredPosts) {
    const entry = ensurePulseWalletActivity(analytics, post.wallet);
    if (!entry) continue;
    entry.postsShared += 1;
    entry.postUpvotesEarned += Number(post.upvotes || 0);
    if (entry.laneCounts[post.lane] !== undefined) {
      entry.laneCounts[post.lane] += 1;
    }
    notePulseWalletTimestamp(entry, post.created_at);
  }

  for (const job of jobs) {
    const budget = toUsdcNumber(job.budget);
    const createdAt = Number(job.createdAt || 0);

    if (job.client && !sameAddress(job.client, ZERO_ADDRESS)) {
      const clientEntry = ensurePulseWalletActivity(analytics, job.client);
      if (clientEntry) {
        clientEntry.jobsAsClient += 1;
        clientEntry.trackedVolumeUsdc += budget;
        notePulseWalletTimestamp(clientEntry, createdAt);
      }
    }

    if (job.agent && !sameAddress(job.agent, ZERO_ADDRESS)) {
      const workerEntry = ensurePulseWalletActivity(analytics, job.agent);
      if (workerEntry) {
        workerEntry.jobsAsWorker += 1;
        workerEntry.trackedVolumeUsdc += budget;
        notePulseWalletTimestamp(workerEntry, createdAt);
      }
    }
  }

  for (const campaign of campaigns) {
    if (!campaign.creator || sameAddress(campaign.creator, ZERO_ADDRESS)) continue;
    const creatorEntry = ensurePulseWalletActivity(analytics, campaign.creator);
    if (!creatorEntry) continue;
    creatorEntry.campaignsCreated += 1;
    creatorEntry.trackedVolumeUsdc += toUsdcNumber(campaign.prizePool);
    notePulseWalletTimestamp(creatorEntry, Number(campaign.createdAt || 0));
  }

  return analytics;
}

function getPulseArcIdUnlockRecord(db, wallet) {
  return db.prepare("SELECT * FROM pulse_arc_id_unlocks WHERE wallet = ?").get(String(wallet || "").toLowerCase()) || null;
}

function normalizeTxHash(value) {
  const hash = String(value || "").trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error("Invalid transaction hash");
  return hash;
}

function getArcIdUnlockConfig() {
  return {
    enabled: Boolean(ARC_ID_UNLOCK_RECIPIENT),
    priceUsdc: ARC_ID_UNLOCK_PRICE_USDC,
    recipient: ARC_ID_UNLOCK_RECIPIENT,
    recipientLabel: ARC_ID_UNLOCK_RECIPIENT ? shortWallet(ARC_ID_UNLOCK_RECIPIENT) : "Configure unlock wallet",
  };
}

function getArcIdNftConfig() {
  return {
    enabled: Boolean(ARC_ID_NFT_ADDRESS),
    ready: Boolean(ARC_ID_NFT_ADDRESS && arcIdNftSignerAccount),
    contractAddress: ARC_ID_NFT_ADDRESS,
    contractLabel: ARC_ID_NFT_ADDRESS ? shortWallet(ARC_ID_NFT_ADDRESS) : "Deploy Arc ID NFT",
    mintPriceUsdc: ARC_ID_NFT_MINT_PRICE_USDC,
    signerAddress: arcIdNftSignerAccount?.address || "",
    signerLabel: arcIdNftSignerAccount?.address ? shortWallet(arcIdNftSignerAccount.address) : "Configure signer",
  };
}

async function verifyArcIdUnlockPayment(wallet, txHash) {
  if (!ARC_ID_UNLOCK_RECIPIENT) {
    throw new Error("Arc ID unlock recipient is not configured on the server");
  }

  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  } catch (err) {
    throw new Error("Could not find this Arc payment transaction yet");
  }

  if (!receipt || receipt.status !== "success") {
    throw new Error("This Arc payment transaction has not succeeded");
  }

  const transfers = parseEventLogs({
    abi: [ERC20_TRANSFER_EVENT],
    eventName: "Transfer",
    logs: receipt.logs,
    strict: false,
  }).filter(log => sameAddress(log.address, USDC_ADDRESS));

  const matchingTransfer = transfers.find(log => (
    sameAddress(log.args?.from, wallet)
    && sameAddress(log.args?.to, ARC_ID_UNLOCK_RECIPIENT)
    && BigInt(log.args?.value || 0n) >= ARC_ID_UNLOCK_PRICE_BASE_UNITS
  ));

  if (!matchingTransfer) {
    throw new Error(`Payment must be a ${ARC_ID_UNLOCK_PRICE_USDC} USDC transfer from your wallet to the Arc ID unlock recipient on Arc`);
  }

  return {
    txHash,
    paidAmountBaseUnits: BigInt(matchingTransfer.args?.value || 0n),
    paidAmountUsdc: formatUsdc(formatUnits(BigInt(matchingTransfer.args?.value || 0n), 6)),
    recipient: ARC_ID_UNLOCK_RECIPIENT,
    blockNumber: Number(receipt.blockNumber || 0n),
  };
}

function getPulseArcIdNftMintRecord(db, wallet) {
  return db.prepare("SELECT * FROM pulse_arc_id_nft_mints WHERE wallet = ?").get(String(wallet || "").toLowerCase()) || null;
}

function normalizePulseMetadataUri(value) {
  const uri = String(value || "").trim();
  if (!uri) throw new Error("Arc ID NFT metadata is required");
  if (uri.length > 16000) throw new Error("Arc ID NFT metadata is too large");
  if (
    !uri.startsWith("data:application/json")
    && !uri.startsWith("ipfs://")
    && !uri.startsWith("https://")
    && !uri.startsWith("http://")
  ) {
    throw new Error("Arc ID NFT metadata must be a data URI, ipfs URI, or https URL");
  }
  return uri;
}

function getArcIdNftMintTypedData(wallet, metadataUri, expiresAt) {
  return {
    domain: {
      name: ARC_ID_NFT_DOMAIN_NAME,
      version: ARC_ID_NFT_DOMAIN_VERSION,
      chainId: arcTestnet.id,
      verifyingContract: ARC_ID_NFT_ADDRESS,
    },
    types: {
      MintAuthorization: [
        { name: "minter", type: "address" },
        { name: "metadataHash", type: "bytes32" },
        { name: "expiresAt", type: "uint256" },
      ],
    },
    primaryType: "MintAuthorization",
    message: {
      minter: wallet,
      metadataHash: keccak256(toBytes(metadataUri)),
      expiresAt: BigInt(expiresAt),
    },
  };
}

async function getArcIdNftOnchainState(wallet) {
  if (!ARC_ID_NFT_ADDRESS) {
    return {
      configured: false,
      minted: false,
      tokenId: "",
      metadataUri: "",
      contractAddress: "",
      error: "",
    };
  }

  try {
    const walletTokenId = await publicClient.readContract({
      address: ARC_ID_NFT_ADDRESS,
      abi: ARC_ID_NFT_VIEW_ABI,
      functionName: "walletTokenId",
      args: [wallet],
    });
    if (!walletTokenId || BigInt(walletTokenId) <= 0n) {
      return {
        configured: true,
        minted: false,
        tokenId: "",
        metadataUri: "",
        contractAddress: ARC_ID_NFT_ADDRESS,
        error: "",
      };
    }

    const tokenId = BigInt(walletTokenId);
    const [owner, metadataUri] = await Promise.all([
      publicClient.readContract({
        address: ARC_ID_NFT_ADDRESS,
        abi: ARC_ID_NFT_VIEW_ABI,
        functionName: "ownerOf",
        args: [tokenId],
      }),
      publicClient.readContract({
        address: ARC_ID_NFT_ADDRESS,
        abi: ARC_ID_NFT_VIEW_ABI,
        functionName: "tokenURI",
        args: [tokenId],
      }),
    ]);

    return {
      configured: true,
      minted: sameAddress(owner, wallet),
      tokenId: tokenId.toString(),
      metadataUri: String(metadataUri || ""),
      contractAddress: ARC_ID_NFT_ADDRESS,
      error: "",
    };
  } catch (err) {
    return {
      configured: true,
      minted: false,
      tokenId: "",
      metadataUri: "",
      contractAddress: ARC_ID_NFT_ADDRESS,
      error: err.message || "Could not read Arc ID NFT state",
    };
  }
}

async function prepareArcIdNftMintAuthorization(db, wallet, metadataUri) {
  if (!ARC_ID_NFT_ADDRESS) {
    throw new Error("Arc ID NFT contract is not configured on the server");
  }
  if (!arcIdNftSignerAccount) {
    throw new Error("Arc ID NFT signer is not configured on the server");
  }

  const canonicalWallet = String(wallet || "").toLowerCase();
  const unlockRecord = getPulseArcIdUnlockRecord(db, canonicalWallet);
  if (!unlockRecord?.tx_hash) {
    throw new Error("A paid Arc ID unlock is required before minting the NFT");
  }

  const existingRecord = getPulseArcIdNftMintRecord(db, canonicalWallet);
  if (existingRecord?.token_id) {
    throw new Error("Arc ID NFT already recorded for this wallet");
  }

  const onchainState = await getArcIdNftOnchainState(canonicalWallet);
  if (onchainState.minted) {
    throw new Error("Arc ID NFT already minted for this wallet");
  }
  if (onchainState.error) {
    throw new Error(onchainState.error);
  }

  const normalizedMetadataUri = normalizePulseMetadataUri(metadataUri);
  const expiresAt = Math.floor(Date.now() / 1000) + ARC_ID_NFT_SIGNATURE_TTL_SEC;
  const typedData = getArcIdNftMintTypedData(canonicalWallet, normalizedMetadataUri, expiresAt);
  const signature = await arcIdNftSignerAccount.signTypedData(typedData);

  return {
    wallet: canonicalWallet,
    metadataUri: normalizedMetadataUri,
    expiresAt,
    signature,
    contractAddress: ARC_ID_NFT_ADDRESS,
    mintPriceUsdc: ARC_ID_NFT_MINT_PRICE_USDC,
  };
}

async function verifyArcIdNftMint(wallet, txHash) {
  if (!ARC_ID_NFT_ADDRESS) {
    throw new Error("Arc ID NFT contract is not configured on the server");
  }

  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  } catch (err) {
    throw new Error("Could not find this Arc ID NFT mint transaction yet");
  }

  if (!receipt || receipt.status !== "success") {
    throw new Error("This Arc ID NFT mint transaction has not succeeded");
  }

  const mintEvents = parseEventLogs({
    abi: [ARC_ID_NFT_MINT_EVENT],
    eventName: "ArcIdMinted",
    logs: receipt.logs,
    strict: false,
  }).filter(log => sameAddress(log.address, ARC_ID_NFT_ADDRESS));

  const mintLog = mintEvents.find(log => (
    sameAddress(log.args?.minter, wallet)
    && BigInt(log.args?.pricePaid || 0n) >= ARC_ID_NFT_MINT_PRICE_BASE_UNITS
  ));

  if (!mintLog) {
    throw new Error(`Mint transaction must emit an Arc ID NFT mint event for your wallet and at least ${ARC_ID_NFT_MINT_PRICE_USDC} USDC`);
  }

  const tokenId = BigInt(mintLog.args?.tokenId || 0n);
  if (tokenId <= 0n) {
    throw new Error("Arc ID NFT mint transaction did not return a valid token id");
  }

  const [walletTokenId, owner, metadataUri] = await Promise.all([
    publicClient.readContract({
      address: ARC_ID_NFT_ADDRESS,
      abi: ARC_ID_NFT_VIEW_ABI,
      functionName: "walletTokenId",
      args: [wallet],
    }),
    publicClient.readContract({
      address: ARC_ID_NFT_ADDRESS,
      abi: ARC_ID_NFT_VIEW_ABI,
      functionName: "ownerOf",
      args: [tokenId],
    }),
    publicClient.readContract({
      address: ARC_ID_NFT_ADDRESS,
      abi: ARC_ID_NFT_VIEW_ABI,
      functionName: "tokenURI",
      args: [tokenId],
    }),
  ]);

  if (BigInt(walletTokenId || 0n) !== tokenId || !sameAddress(owner, wallet)) {
    throw new Error("Arc ID NFT mint verification did not match the current wallet owner");
  }

  let mintedAt = Date.now();
  try {
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    mintedAt = Number(block.timestamp || 0n) > 0 ? Number(block.timestamp) * 1000 : mintedAt;
  } catch {}

  return {
    wallet,
    tokenId: tokenId.toString(),
    txHash,
    metadataUri: String(metadataUri || ""),
    mintedAt,
    paidAmountUsdc: formatUsdc(formatUnits(BigInt(mintLog.args?.pricePaid || 0n), 6)),
  };
}

function savePulseArcIdNftMint(db, wallet, verifiedMint = {}) {
  const persistMint = db.transaction((targetWallet, mint) => {
    const canonicalWallet = String(targetWallet || "").toLowerCase();
    const existingTxOwner = db.prepare("SELECT wallet FROM pulse_arc_id_nft_mints WHERE tx_hash = ? AND wallet <> ?").get(mint.txHash, canonicalWallet);
    if (existingTxOwner) {
      throw new Error("This Arc ID NFT mint receipt is already linked to another wallet");
    }

    const existing = getPulseArcIdNftMintRecord(db, canonicalWallet);
    const now = Date.now();
    db.prepare(`
      INSERT INTO pulse_arc_id_nft_mints (wallet, token_id, tx_hash, metadata_uri, minted_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet) DO UPDATE SET
        token_id = excluded.token_id,
        tx_hash = excluded.tx_hash,
        metadata_uri = excluded.metadata_uri,
        minted_at = excluded.minted_at,
        updated_at = excluded.updated_at
    `).run(
      canonicalWallet,
      String(mint.tokenId || ""),
      mint.txHash,
      String(mint.metadataUri || ""),
      Number(existing?.minted_at || mint.mintedAt || now),
      now,
    );

    return getPulseArcIdNftMintRecord(db, canonicalWallet);
  });

  return persistMint(wallet, verifiedMint);
}

async function buildPulseArcIdProfile(db, wallet, jobs = [], campaigns = []) {
  const canonicalWallet = String(wallet || "").toLowerCase();
  const analyticsMap = buildPulseWalletAnalytics(db, jobs, campaigns);
  const entry = analyticsMap.get(canonicalWallet) || createPulseWalletActivity(canonicalWallet);
  const summary = formatPulseWalletActivity(entry);
  const unlockRecord = getPulseArcIdUnlockRecord(db, canonicalWallet);
  const unlockConfig = getArcIdUnlockConfig();
  const nftConfig = getArcIdNftConfig();
  const nftMintRecord = getPulseArcIdNftMintRecord(db, canonicalWallet);
  const onchainNftState = await getArcIdNftOnchainState(canonicalWallet);
  const unlockMode = unlockRecord?.tx_hash ? "paid-usdc" : (unlockRecord ? "beta-free" : "locked");

  const rankedWallets = [...analyticsMap.values()]
    .map(formatPulseWalletActivity)
    .filter(item => item.totalTrackedActions > 0 || item.points > 0 || item.trackedVolumeUsdcRaw > 0 || item.memberSince > 0);

  if (!rankedWallets.some(item => sameAddress(item.wallet, canonicalWallet))) {
    rankedWallets.push(summary);
  }

  rankedWallets.sort((a, b) => (
    b.activityScore - a.activityScore
    || b.trackedVolumeUsdcRaw - a.trackedVolumeUsdcRaw
    || b.points - a.points
    || a.memberSince - b.memberSince
    || a.wallet.localeCompare(b.wallet)
  ));

  const rankPosition = Math.max(1, rankedWallets.findIndex(item => sameAddress(item.wallet, canonicalWallet)) + 1);
  const totalRanked = Math.max(1, rankedWallets.length);
  const topPercent = totalRanked <= 1 ? 1 : Math.max(1, Math.round((rankPosition / totalRanked) * 100));
  const badge = describePulseArcIdBadge(summary, topPercent);
  const nftMinted = Boolean(onchainNftState?.minted || nftMintRecord?.token_id);
  const nftTokenId = onchainNftState?.tokenId || String(nftMintRecord?.token_id || "");
  const nftMetadataUri = onchainNftState?.metadataUri || String(nftMintRecord?.metadata_uri || "");
  const nftTxHash = String(nftMintRecord?.tx_hash || "");
  const nftMintedAt = Number(nftMintRecord?.minted_at || 0);
  const nftEligible = unlockMode === "paid-usdc";
  const nftCanMint = Boolean(nftEligible && nftConfig.ready && !nftMinted);

  return {
    scope: "tracked-beta",
    wallet: canonicalWallet,
    walletLabel: shortWallet(canonicalWallet),
    unlocked: Boolean(unlockRecord),
    unlockedAt: Number(unlockRecord?.unlocked_at || 0),
    unlockMode,
    paidUnlocked: unlockMode === "paid-usdc",
    accessUnlocked: Boolean(unlockRecord),
    payment: {
      ...unlockConfig,
      txHash: unlockRecord?.tx_hash || "",
      txUrl: unlockRecord?.tx_hash ? `https://testnet.arcscan.app/tx/${unlockRecord.tx_hash}` : "",
      paidAmountUsdc: unlockRecord?.payment_amount_usdc || "",
      recipient: unlockRecord?.recipient || unlockConfig.recipient,
      recipientLabel: (unlockRecord?.recipient || unlockConfig.recipient) ? shortWallet(unlockRecord?.recipient || unlockConfig.recipient) : unlockConfig.recipientLabel,
      needsPayment: unlockMode !== "paid-usdc",
    },
    nft: {
      ...nftConfig,
      eligible: nftEligible,
      canMint: nftCanMint,
      minted: nftMinted,
      tokenId: nftTokenId,
      metadataUri: nftMetadataUri,
      txHash: nftTxHash,
      txUrl: nftTxHash ? `https://testnet.arcscan.app/tx/${nftTxHash}` : "",
      mintedAt: nftMintedAt,
      contractUrl: nftConfig.contractAddress ? `https://testnet.arcscan.app/address/${nftConfig.contractAddress}` : "",
      error: onchainNftState?.error || "",
    },
    identityRegistryUrl: `https://testnet.arcscan.app/address/${IDENTITY_REGISTRY}`,
    reputationRegistryUrl: `https://testnet.arcscan.app/address/${REPUTATION_REGISTRY}`,
    badge,
    rank: {
      position: rankPosition,
      total: totalRanked,
      topPercent,
      label: totalRanked > 1 ? `Top ${topPercent}% builder` : "Founding builder",
    },
    teaser: {
      points: summary.points,
      trackedActions: summary.totalTrackedActions,
      trackedVolumeUsdc: summary.trackedVolumeUsdc,
      currentStreak: summary.currentStreak,
    },
    profile: summary,
    notes: [
      "Arc ID beta is based on tracked AgentMarket and ArcPulse activity right now.",
      unlockConfig.enabled
        ? `A ${ARC_ID_UNLOCK_PRICE_USDC} USDC transfer on Arc now unlocks and verifies this card.`
        : "Configure an Arc ID unlock recipient on the server to turn the paid unlock live.",
      nftConfig.enabled
        ? `Season 1 Arc ID NFT minting is live at ${ARC_ID_NFT_MINT_PRICE_USDC} USDC after a paid unlock.`
        : "Deploy and configure the Arc ID NFT contract to turn the collectible mint live.",
      "Full-network Arc identity stats should switch on once an indexer is attached.",
    ],
  };
}

function savePaidPulseArcIdUnlock(db, wallet, displayName = "", payment = {}) {
  const persistUnlock = db.transaction((targetWallet, label, verifiedPayment) => {
    const profile = ensurePulseProfile(db, targetWallet, label);
    const canonicalWallet = profile.wallet;
    const existing = getPulseArcIdUnlockRecord(db, canonicalWallet);
    const existingTxOwner = db.prepare("SELECT wallet FROM pulse_arc_id_unlocks WHERE tx_hash = ? AND wallet <> ?").get(verifiedPayment.txHash, canonicalWallet);
    if (existingTxOwner) {
      throw new Error("This Arc payment receipt is already linked to another wallet");
    }

    const now = Date.now();
    const unlockedAt = Number(existing?.unlocked_at || now);
    db.prepare(`
      INSERT INTO pulse_arc_id_unlocks (wallet, unlocked_at, updated_at, tx_hash, payment_amount_usdc, recipient)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet) DO UPDATE SET
        unlocked_at = excluded.unlocked_at,
        updated_at = excluded.updated_at,
        tx_hash = excluded.tx_hash,
        payment_amount_usdc = excluded.payment_amount_usdc,
        recipient = excluded.recipient
    `).run(
      canonicalWallet,
      unlockedAt,
      now,
      verifiedPayment.txHash,
      verifiedPayment.paidAmountUsdc,
      verifiedPayment.recipient,
    );

    return getPulseArcIdUnlockRecord(db, canonicalWallet);
  });

  return persistUnlock(wallet, displayName, payment);
}

function getPulsePostById(db, postId, viewerWallet = "") {
  const row = db.prepare(`
    SELECT
      p.id,
      p.lane,
      p.title,
      p.body,
      p.link,
      p.wallet,
      p.author_name,
      p.created_at,
      COUNT(v.wallet) AS upvotes,
      MAX(CASE WHEN v.wallet = ? THEN 1 ELSE 0 END) AS upvoted_by_viewer
    FROM pulse_posts p
    LEFT JOIN pulse_post_upvotes v ON v.post_id = p.id
    WHERE p.id = ?
    GROUP BY p.id
  `).get(viewerWallet ? viewerWallet.toLowerCase() : "", postId);
  return row ? formatPulsePost(row, viewerWallet) : null;
}

function createPulsePost(db, { wallet, lane, authorName, title, body, link }) {
  const createPost = db.transaction((payload) => {
    const now = Date.now();
    const profile = ensurePulseProfile(db, payload.wallet, payload.authorName);
    const canonicalWallet = profile.wallet;
    const authorLabel = profile.displayName || payload.authorName || shortWallet(payload.wallet);
    const post = {
      id: `pulse-${now}-${Math.random().toString(36).slice(2, 8)}`,
      lane: payload.lane,
      title: payload.title,
      body: payload.body,
      link: payload.link,
      wallet: canonicalWallet,
      authorName: authorLabel,
      createdAt: now,
      upvotes: 0,
      upvotedByViewer: false,
    };

    db.prepare(`
      INSERT INTO pulse_posts (id, lane, title, body, link, wallet, author_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      post.id,
      post.lane,
      post.title,
      post.body,
      post.link,
      post.wallet,
      post.authorName,
      post.createdAt,
    );

    db.prepare(`
      UPDATE pulse_profiles
      SET
        display_name = CASE
          WHEN ? <> '' THEN ?
          ELSE display_name
        END,
        updated_at = ?
      WHERE wallet = ?
    `).run(payload.authorName || "", payload.authorName || "", now, canonicalWallet);

    return post;
  });

  return createPost({ wallet, lane, authorName, title, body, link });
}

function togglePulseVote(db, postId, wallet) {
  const changeVote = db.transaction((targetPostId, voterWallet) => {
    const postExists = db.prepare("SELECT id FROM pulse_posts WHERE id = ?").get(targetPostId);
    if (!postExists) throw new Error("Pulse post not found");

    const normalizedWallet = voterWallet.toLowerCase();
    const existingVote = db.prepare(`
      SELECT 1
      FROM pulse_post_upvotes
      WHERE post_id = ? AND wallet = ?
    `).get(targetPostId, normalizedWallet);

    let added = false;
    if (existingVote) {
      db.prepare("DELETE FROM pulse_post_upvotes WHERE post_id = ? AND wallet = ?").run(targetPostId, normalizedWallet);
    } else {
      db.prepare(`
        INSERT INTO pulse_post_upvotes (post_id, wallet, created_at)
        VALUES (?, ?, ?)
      `).run(targetPostId, normalizedWallet, Date.now());
      added = true;
    }

    return {
      added,
      post: getPulsePostById(db, targetPostId, voterWallet),
    };
  });

  return changeVote(postId, wallet);
}

function recordPulseCheckIn(db, wallet, displayName = "") {
  const completeCheckIn = db.transaction((targetWallet, label) => {
    const todayKey = utcDayKey(Date.now());
    const profile = ensurePulseProfile(db, targetWallet, label);
    const canonicalWallet = profile.wallet;

    if (profile.lastCheckInDay === todayKey) {
      return {
        alreadyCheckedIn: true,
        todayKey,
        profile: formatPulseProfile(profile),
      };
    }

    const diff = profile.lastCheckInDay ? dayKeyDiff(profile.lastCheckInDay, todayKey) : null;
    const currentStreak = diff === 1 ? Number(profile.currentStreak || 0) + 1 : 1;
    const longestStreak = Math.max(Number(profile.longestStreak || 0), currentStreak);
    const points = Number(profile.points || 0) + 10;
    const totalCheckIns = Number(profile.totalCheckIns || 0) + 1;
    const updatedAt = Date.now();

    db.prepare(`
      UPDATE pulse_profiles
      SET
        display_name = CASE
          WHEN ? <> '' THEN ?
          ELSE display_name
        END,
        points = ?,
        current_streak = ?,
        longest_streak = ?,
        total_checkins = ?,
        last_check_in_day = ?,
        updated_at = ?
      WHERE wallet = ?
    `).run(
      label || "",
      label || "",
      points,
      currentStreak,
      longestStreak,
      totalCheckIns,
      todayKey,
      updatedAt,
      canonicalWallet,
    );

    return {
      alreadyCheckedIn: false,
      todayKey,
      earnedPoints: 10,
      profile: formatPulseProfile(getPulseProfileRecord(db, canonicalWallet)),
    };
  });

  return completeCheckIn(wallet, displayName);
}

async function getPulseSnapshot() {
  const [jobs, campaigns, recentBlocks, pulseDb] = await Promise.all([
    getAllFormattedJobs(),
    getAllFormattedCampaigns(),
    getRecentBlocks(),
    ensurePulseDatabase(),
  ]);

  const activeJobs = jobs.filter(job => !isArchivedCompletedJob(job));
  const activeCampaigns = campaigns.filter(campaign => !isClosedCampaign(campaign));
  const completedJobs = jobs.filter(job => Number(job.status) === 3);
  const openJobs = jobs.filter(job => Number(job.status) === 0 && !job.isExpired);

  const trackedWallets = new Set();
  for (const job of jobs) {
    if (job.client && !sameAddress(job.client, ZERO_ADDRESS)) trackedWallets.add(job.client.toLowerCase());
    if (job.agent && !sameAddress(job.agent, ZERO_ADDRESS)) trackedWallets.add(job.agent.toLowerCase());
  }
  for (const campaign of campaigns) {
    if (campaign.creator && !sameAddress(campaign.creator, ZERO_ADDRESS)) trackedWallets.add(campaign.creator.toLowerCase());
  }

  const trackedEscrowVolume = jobs.reduce((sum, job) => sum + toUsdcNumber(job.budget), 0)
    + campaigns.reduce((sum, campaign) => sum + toUsdcNumber(campaign.prizePool), 0);
  const settledVolume = completedJobs.reduce((sum, job) => sum + toUsdcNumber(job.budget), 0);
  const recentBlockTxCount = recentBlocks.reduce((sum, block) => sum + Number(block.txCount || 0), 0);
  const pulseCounts = getPulseStorageCounts(pulseDb);

  return {
    generatedAt: Date.now(),
    mode: "hybrid-beta",
    overview: {
      latestBlockNumber: recentBlocks[0]?.number || 0,
      avgBlockTimeSec: averageBlockTimeSec(recentBlocks),
      recentBlockTxCount,
      trackedEscrowVolumeUsdc: formatUsdc(trackedEscrowVolume),
      settledVolumeUsdc: formatUsdc(settledVolume),
      totalJobs: jobs.length,
      completedJobs: completedJobs.length,
      openJobs: openJobs.length,
      activeCampaigns: activeCampaigns.length,
      trackedWallets: trackedWallets.size,
      communityPosts: pulseCounts.communityPosts,
      pulseProfiles: pulseCounts.pulseProfiles,
    },
    recentBlocks,
    volume14d: buildPulseSeries(jobs),
    categoryBreakdown: buildCategoryBreakdown(activeJobs),
    appRankings: buildTrackedAppRankings(jobs, campaigns),
    notes: [
      "Live Arc blocks come directly from the Arc RPC endpoint.",
      "Volume, categories, and rankings are currently tracked from the AgentMarket contracts only.",
      "Community feed, votes, and streaks now persist in a SQLite-backed Pulse store.",
      "Full-network ArcPulse rankings should use an indexer such as Goldsky or Envio.",
    ],
  };
}

// ─── In-memory chat (shared across all users in the same server instance) ───
const CHAT_ROOM_LIMIT = 300;
const chatRooms = new Map();

function normalizeAddress(address) {
  const value = (address || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error("Invalid wallet address");
  return value;
}

function normalizeRoomId(roomId) {
  const value = Number.parseInt(roomId, 10);
  if (!Number.isInteger(value) || value < 0) throw new Error("Invalid chat room");
  return String(value);
}

function chatRoomKey(roomType, roomId) {
  if (!["job", "campaign"].includes(roomType)) throw new Error("Invalid chat type");
  return `${roomType}:${normalizeRoomId(roomId)}`;
}

function getChatMessages(roomType, roomId) {
  return chatRooms.get(chatRoomKey(roomType, roomId)) || [];
}

function saveChatMessage(roomType, roomId, message) {
  const key = chatRoomKey(roomType, roomId);
  const messages = chatRooms.get(key) || [];
  messages.push(message);
  chatRooms.set(key, messages.slice(-CHAT_ROOM_LIMIT));
  return message;
}

async function assertCanPostChatMessage(roomType, roomId, from, isAnnouncement) {
  if (roomType === "job") {
    const job = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
      functionName: "getJob", args: [BigInt(roomId)],
    });
    if (!sameAddress(from, job.client) && !sameAddress(from, job.agent)) {
      throw new Error("Only the poster and worker can message on this job");
    }
    return;
  }
  const campaign = await publicClient.readContract({
    address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
    functionName: "getCampaign", args: [BigInt(roomId)],
  });
  if (isAnnouncement && !sameAddress(from, campaign.creator)) {
    throw new Error("Only the campaign creator can post announcements");
  }
  const participants = await publicClient.readContract({
    address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
    functionName: "getCampaignParticipants", args: [BigInt(roomId)],
  });
  const isParticipant = participants.some(p => sameAddress(p, from));
  if (!isParticipant && !sameAddress(from, campaign.creator)) {
    throw new Error("Only campaign participants can message here");
  }
}

// ─── Routes ───────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", network: "Arc Testnet", contractAddress: JOB_BOARD_ADDRESS });
});

app.get("/api/config", (req, res) => {
  res.json({
    jobBoardAddress: JOB_BOARD_ADDRESS,
    usdcAddress: USDC_ADDRESS,
    explorerUrl: "https://testnet.arcscan.app",
    pulseEnabled: true,
    arcIdUnlock: getArcIdUnlockConfig(),
    arcIdNft: getArcIdNftConfig(),
    unifiedBalanceEnabled: true,
    unifiedBalanceSupportedChains: [
      { id: "Ethereum_Sepolia", name: "Ethereum Sepolia", chainId: 11155111, type: "evm", testnet: true },
      { id: "Base_Sepolia", name: "Base Sepolia", chainId: 84532, type: "evm", testnet: true },
      { id: "Arbitrum_Sepolia", name: "Arbitrum Sepolia", chainId: 421614, type: "evm", testnet: true },
      { id: "Avalanche_Fuji", name: "Avalanche Fuji", chainId: 43113, type: "evm", testnet: true },
      { id: "Polygon_Amoy_Testnet", name: "Polygon Amoy", chainId: 80002, type: "evm", testnet: true },
    ],
    bridgeSupportedChains: [
      { id: "Ethereum_Sepolia", name: "Ethereum Sepolia", chainId: 11155111, type: "evm", testnet: true },
      { id: "Base_Sepolia", name: "Base Sepolia", chainId: 84532, type: "evm", testnet: true },
      { id: "Arbitrum_Sepolia", name: "Arbitrum Sepolia", chainId: 421614, type: "evm", testnet: true },
      { id: "Avalanche_Fuji", name: "Avalanche Fuji", chainId: 43113, type: "evm", testnet: true },
      { id: "Polygon_Amoy_Testnet", name: "Polygon Amoy", chainId: 80002, type: "evm", testnet: true },
      { id: "Arc_Testnet", name: "Arc Testnet", chainId: 5042002, type: "evm", destination: true, testnet: true },
      { id: "Solana_Devnet", name: "Solana Devnet", type: "solana", testnet: true },
    ],
  });
});

app.get("/api/pulse/overview", async (req, res) => {
  try {
    const snapshot = await getPulseSnapshot();
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to load ArcPulse overview" });
  }
});

// ─── Chat ─────────────────────────────────────────────────────────
app.get("/api/pulse/community", async (req, res) => {
  try {
    const pulseDb = await ensurePulseDatabase();
    const viewerWallet = req.query?.viewer ? normalizeAddress(req.query.viewer) : "";
    res.json(getPulseCommunityResponse(pulseDb, req.query?.lane || "all", viewerWallet));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not load the ArcPulse community feed" });
  }
});

app.post("/api/pulse/community", async (req, res) => {
  try {
    const pulseDb = await ensurePulseDatabase();
    const wallet = normalizeAddress(req.body?.wallet);
    const lane = normalizePulseLane(req.body?.lane);
    const authorName = normalizePulseText(req.body?.authorName, "Display name", 40, { allowEmpty: true });
    const title = normalizePulseText(req.body?.title, "Title", 80);
    const body = normalizePulseText(req.body?.body, "Post", 600, { collapseWhitespace: false });
    const link = normalizePulseUrl(req.body?.link);
    const post = createPulsePost(pulseDb, { wallet, lane, authorName, title, body, link });
    res.status(201).json(formatPulsePost(post, wallet));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not publish to the ArcPulse feed" });
  }
});

app.post("/api/pulse/community/:postId/upvote", async (req, res) => {
  try {
    const pulseDb = await ensurePulseDatabase();
    const wallet = normalizeAddress(req.body?.wallet);
    const result = togglePulseVote(pulseDb, req.params.postId, wallet);
    if (!result?.post) return res.status(404).json({ error: "Pulse post not found" });
    res.json(result);
  } catch (err) {
    const message = err.message || "Could not update the ArcPulse vote";
    res.status(message === "Pulse post not found" ? 404 : 400).json({ error: message });
  }
});

app.get("/api/pulse/leaderboards", async (req, res) => {
  try {
    const pulseDb = await ensurePulseDatabase();
    res.json(getPulseLeaderboards(pulseDb));
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load ArcPulse leaderboards" });
  }
});

app.get("/api/pulse/checkin/:address", async (req, res) => {
  try {
    const pulseDb = await ensurePulseDatabase();
    const wallet = normalizeAddress(req.params.address);
    const profile = ensurePulseProfile(pulseDb, wallet);
    res.json({
      todayKey: utcDayKey(Date.now()),
      profile: formatPulseProfile(profile),
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not load ArcPulse check-in status" });
  }
});

app.post("/api/pulse/checkin", async (req, res) => {
  try {
    const pulseDb = await ensurePulseDatabase();
    const wallet = normalizeAddress(req.body?.wallet);
    const displayName = normalizePulseText(req.body?.displayName, "Display name", 40, { allowEmpty: true });
    res.json(recordPulseCheckIn(pulseDb, wallet, displayName));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not complete the ArcPulse check-in" });
  }
});

app.get("/api/pulse/arc-id/:address", async (req, res) => {
  try {
    const pulseDb = await ensurePulseDatabase();
    const wallet = normalizeAddress(req.params.address);
    const [jobs, campaigns] = await Promise.all([
      getAllFormattedJobs(),
      getAllFormattedCampaigns(),
    ]);
    ensurePulseProfile(pulseDb, wallet);
    res.json(await buildPulseArcIdProfile(pulseDb, wallet, jobs, campaigns));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not load the Arc ID profile" });
  }
});

app.post("/api/pulse/arc-id/unlock", async (req, res) => {
  try {
    const pulseDb = await ensurePulseDatabase();
    const wallet = normalizeAddress(req.body?.wallet);
    const displayName = normalizePulseText(req.body?.displayName, "Display name", 40, { allowEmpty: true });
    const txHash = normalizeTxHash(req.body?.txHash);
    const payment = await verifyArcIdUnlockPayment(wallet, txHash);
    savePaidPulseArcIdUnlock(pulseDb, wallet, displayName, payment);
    const [jobs, campaigns] = await Promise.all([
      getAllFormattedJobs(),
      getAllFormattedCampaigns(),
    ]);
    res.json(await buildPulseArcIdProfile(pulseDb, wallet, jobs, campaigns));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not verify Arc ID payment" });
  }
});

app.post("/api/pulse/arc-id/mint/prepare", async (req, res) => {
  try {
    const pulseDb = await ensurePulseDatabase();
    const wallet = normalizeAddress(req.body?.wallet);
    ensurePulseProfile(pulseDb, wallet);
    const authorization = await prepareArcIdNftMintAuthorization(
      pulseDb,
      wallet,
      req.body?.metadataUri,
    );
    res.json(authorization);
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not prepare the Arc ID NFT mint" });
  }
});

app.post("/api/pulse/arc-id/mint/confirm", async (req, res) => {
  try {
    const pulseDb = await ensurePulseDatabase();
    const wallet = normalizeAddress(req.body?.wallet);
    const txHash = normalizeTxHash(req.body?.txHash);
    const verifiedMint = await verifyArcIdNftMint(wallet, txHash);
    savePulseArcIdNftMint(pulseDb, wallet, verifiedMint);
    const [jobs, campaigns] = await Promise.all([
      getAllFormattedJobs(),
      getAllFormattedCampaigns(),
    ]);
    res.json(await buildPulseArcIdProfile(pulseDb, wallet, jobs, campaigns));
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not verify the Arc ID NFT mint" });
  }
});

app.get("/api/chats/:roomType/:roomId/messages", (req, res) => {
  try {
    res.json(getChatMessages(req.params.roomType, req.params.roomId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/chats/:roomType/:roomId/messages", async (req, res) => {
  try {
    const { roomType, roomId } = req.params;
    const from = normalizeAddress(req.body?.from);
    const text = String(req.body?.text || "").trim();
    const isAnnouncement = Boolean(req.body?.isAnnouncement);
    if (!text) return res.status(400).json({ error: "Message cannot be empty" });
    if (text.length > 1000) return res.status(400).json({ error: "Message is too long" });
    await assertCanPostChatMessage(roomType, normalizeRoomId(roomId), from, isAnnouncement);
    const message = saveChatMessage(roomType, roomId, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      from, text, ts: Date.now(), isAnnouncement,
    });
    res.status(201).json(message);
  } catch (err) {
    res.status(err.message?.startsWith("Only ") ? 403 : 400).json({ error: err.message });
  }
});

// ─── Jobs ─────────────────────────────────────────────────────────
app.get("/api/jobs", async (req, res) => {
  try {
    const jobs = await getAllFormattedJobs();
    res.json(jobs.filter(job => !isArchivedCompletedJob(job)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/jobs/open", async (req, res) => {
  try {
    const jobs = await getAllFormattedJobs();
    res.json(jobs.filter(job => job.status === 0 && !job.isExpired));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/jobs/:id", async (req, res) => {
  try {
    const job = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
      functionName: "getJob", args: [BigInt(req.params.id)],
    });
    res.json(formatJob(job));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/client/:address/jobs", async (req, res) => {
  try {
    const jobs = await getJobsForAddress(
      req.params.address,
      "getClientJobs",
      (job, addr) => sameAddress(job.client, addr)
    );
    res.json(jobs.filter(job => !isArchivedCompletedJob(job)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/agent/:address/jobs", async (req, res) => {
  try {
    const jobs = await getJobsForAddress(
      req.params.address,
      "getAgentJobs",
      (job, addr) => sameAddress(job.agent, addr)
    );
    res.json(jobs.filter(job => !isArchivedCompletedJob(job)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/jobs/:id/milestones", async (req, res) => {
  try {
    const milestones = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
      functionName: "getJobMilestones", args: [BigInt(req.params.id)],
    });
    res.json(milestones.map(m => ({
      percentage: Number(m.percentage),
      description: m.description,
      deliverableHash: m.deliverableHash,
      submittedAt: Number(m.submittedAt) * 1000,
      approved: m.approved,
    })));
  } catch (err) { res.status(500).json({ error: "Failed to fetch milestones" }); }
});

app.get("/api/worker/:address/reviews", async (req, res) => {
  try {
    const reviews = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
      functionName: "getWorkerReviews", args: [req.params.address],
    });
    res.json(reviews.map(r => ({
      jobId: Number(r.jobId), reviewer: r.reviewer, worker: r.worker,
      rating: Number(r.rating), comment: r.comment,
      timestamp: Number(r.timestamp) * 1000,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/stats", async (req, res) => {
  try {
    const [jobCount, feeBps, jobs] = await Promise.all([
      publicClient.readContract({ address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI, functionName: "jobCount" }),
      publicClient.readContract({ address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI, functionName: "platformFeeBps" }),
      getAllFormattedJobs(),
    ]);
    const completed = jobs.filter(j => j.status === 3);
    const totalVolume = completed.reduce((sum, j) => sum + parseFloat(j.budget), 0);
    res.json({
      totalJobs: Number(jobCount),
      completedJobs: completed.length,
      totalVolumeUsdc: totalVolume.toFixed(2),
      platformFeePercent: (Number(feeBps) / 100).toFixed(1),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/agent/:agentId/identity", async (req, res) => {
  try {
    const [owner, tokenURI] = await Promise.all([
      publicClient.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "ownerOf", args: [BigInt(req.params.agentId)] }),
      publicClient.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "tokenURI", args: [BigInt(req.params.agentId)] }),
    ]);
    res.json({ agentId: req.params.agentId, ownerAddress: owner, metadataUri: tokenURI, identityRegistryUrl: `https://testnet.arcscan.app/address/${IDENTITY_REGISTRY}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/agents", (req, res) => {
  res.json([
    { id:"native-001", type:"AI", name:"SummaryBot", description:"Summarizes documents, PDFs, and long text into clear bullet points", taskTypes:["summarize","analyze"], walletAddress: process.env.SUMMARY_AGENT_WALLET||"0x0000000000000000000000000000000000000001", reputationScore:98, completedJobs:0, isNative:true, isVerified:true, minBudget:"1.00" },
    { id:"native-002", type:"AI", name:"ReportAgent", description:"Generates structured market and data reports from raw inputs", taskTypes:["report","research"], walletAddress: process.env.REPORT_AGENT_WALLET||"0x0000000000000000000000000000000000000002", reputationScore:95, completedJobs:0, isNative:true, isVerified:true, minBudget:"2.00" },
    { id:"native-003", type:"AI", name:"TranslateAI", description:"Translates content between languages with context awareness", taskTypes:["translate"], walletAddress: process.env.TRANSLATE_AGENT_WALLET||"0x0000000000000000000000000000000000000003", reputationScore:97, completedJobs:0, isNative:true, isVerified:true, minBudget:"1.00" },
  ]);
});

// ─── Campaigns ────────────────────────────────────────────────────
app.get("/api/campaigns", async (req, res) => {
  try {
    const campaigns = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI, functionName: "getAllCampaigns",
    });
    const formattedCampaigns = campaigns.map(c => ({
      id: Number(c.id), creator: c.creator, title: c.title, description: c.description,
      prizePool: formatUnits(c.prizePool, 6), entryFee: formatUnits(c.entryFee, 6),
      maxParticipants: Number(c.maxParticipants), deadline: Number(c.deadline) * 1000,
      expired: c.expired, createdAt: Number(c.createdAt) * 1000,
    }));
    res.json(formattedCampaigns.filter(campaign => !isClosedCampaign(campaign)));
  } catch (err) { res.status(500).json({ error: "Failed to fetch campaigns" }); }
});

app.get("/api/campaigns/:id", async (req, res) => {
  try {
    const c = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
      functionName: "getCampaign", args: [BigInt(req.params.id)],
    });
    res.json({
      id: Number(c.id), creator: c.creator, title: c.title, description: c.description,
      prizePool: formatUnits(c.prizePool, 6), entryFee: formatUnits(c.entryFee, 6),
      maxParticipants: Number(c.maxParticipants), deadline: Number(c.deadline) * 1000,
      expired: c.expired, createdAt: Number(c.createdAt) * 1000,
    });
  } catch (err) { res.status(500).json({ error: "Failed to fetch campaign" }); }
});

app.get("/api/campaigns/:id/entries", async (req, res) => {
  try {
    const participants = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
      functionName: "getCampaignParticipants", args: [BigInt(req.params.id)],
    });
    const entries = await Promise.all(
      participants.map(async (participant) => {
        try {
          const entry = await publicClient.readContract({
            address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
            functionName: "getCampaignSubmission",
            args: [BigInt(req.params.id), participant],
          });
          return { participant, entry };
        } catch { return { participant, entry: "" }; }
      })
    );
    res.json(entries.filter(e => e.entry));
  } catch (err) { res.status(500).json({ error: "Failed to fetch entries" }); }
});

app.post("/api/campaigns/:id/entries", async (req, res) => {
  // Fallback API endpoint for campaign entries (when contract call fails on frontend)
  try {
    const { participant, entry } = req.body;
    if (!participant || !entry) return res.status(400).json({ error: "Missing participant or entry" });
    res.json({ success: true, participant, entry, submittedAt: Date.now() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/campaigns/:id/participants", async (req, res) => {
  try {
    const participants = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
      functionName: "getCampaignParticipants", args: [BigInt(req.params.id)],
    });
    res.json(participants);
  } catch (err) { res.status(500).json({ error: "Failed to fetch participants" }); }
});

app.get("/api/campaigns/:id/winners", async (req, res) => {
  try {
    const winners = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
      functionName: "getCampaignWinners", args: [BigInt(req.params.id)],
    });
    res.json(winners);
  } catch (err) { res.status(500).json({ error: "Failed to fetch winners" }); }
});

app.get("/api/campaigns/:id/submission/:address", async (req, res) => {
  try {
    const submission = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
      functionName: "getCampaignSubmission",
      args: [BigInt(req.params.id), req.params.address],
    });
    res.json({ submission });
  } catch (err) { res.status(500).json({ error: "Failed to fetch submission" }); }
});

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AgentMarket API running on port ${PORT}`);
  console.log(`Network: Arc Testnet`);
  console.log(`Contract: ${JOB_BOARD_ADDRESS}`);
});
