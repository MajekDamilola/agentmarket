import express from "express";
import cors from "cors";
import { createPublicClient, http, formatUnits, parseAbiItem, parseEventLogs, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import dotenv from "dotenv";
import { promises as fs } from "fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IS_SERVERLESS_RUNTIME = Boolean(
  process.env.VERCEL
  || process.env.AWS_EXECUTION_ENV
  || process.env.LAMBDA_TASK_ROOT
  || process.env.NETLIFY
);

function resolvePulseStorageBaseDir() {
  const configured = String(process.env.PULSE_STORAGE_DIR || "").trim();
  if (configured) {
    return path.resolve(configured);
  }

  if (IS_SERVERLESS_RUNTIME) {
    return path.join(tmpdir(), "agentmarket-pulse");
  }

  const workspaceRoot = path.resolve(__dirname, "..");
  if (/onedrive/i.test(workspaceRoot)) {
    return path.join(tmpdir(), "agentmarket-pulse");
  }

  return path.join(workspaceRoot, "cache");
}

function parseEnvInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolvePulseIndexerSnapshotPath(value) {
  const configured = String(value || "").trim();
  if (!configured) return "";
  return path.isAbsolute(configured) ? configured : path.resolve(__dirname, configured);
}

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
const ARC_EXPLORER_URL = "https://testnet.arcscan.app";
const ARC_EXPLORER_API_URL = `${ARC_EXPLORER_URL}/api`;
const ARC_EXPLORER_API_V2_URL = `${ARC_EXPLORER_URL}/api/v2`;
const DAY_MS = 24 * 60 * 60 * 1000;
const PULSE_RECENT_BLOCK_LIMIT = 6;
const PULSE_SERIES_DAYS = 14;
const PULSE_FEED_LIMIT = 250;
const PULSE_LEADERBOARD_LIMIT = 10;
const PULSE_LANES = new Set(["build", "thread", "art"]);
const PULSE_INDEXER_EVENT_CHUNK_SIZE = 10_000n;
const PULSE_INDEXER_SYNC_INTERVAL_MS = 30_000;
const PULSE_INDEXER_CONFIRMATION_BLOCKS = 2n;
const PULSE_INDEXER_SCHEMA_VERSION = "2";
const PULSE_INTERNAL_INDEXER_ENABLED = String(process.env.PULSE_INTERNAL_INDEXER_ENABLED || "true").trim().toLowerCase() !== "false";
const ARC_ID_UNLOCK_PRICE_USDC = "2.50";
const ARC_ID_UNLOCK_PRICE_BASE_UNITS = 2_500_000n;
const ARC_ID_NFT_MINT_PRICE_USDC = "5.00";
const ARC_ID_NFT_MINT_PRICE_BASE_UNITS = 5_000_000n;
const ARC_ID_NFT_SIGNATURE_TTL_SEC = 15 * 60;
const ARC_ID_NFT_DOMAIN_NAME = "AgentMarket Arc ID";
const ARC_ID_NFT_DOMAIN_VERSION = "1";
const PULSE_STORAGE_BASE_DIR = resolvePulseStorageBaseDir();
const PULSE_JSON_STORE_PATH = path.join(PULSE_STORAGE_BASE_DIR, "pulse-store.json");
const PULSE_DB_PATH = path.join(PULSE_STORAGE_BASE_DIR, "pulse-store.sqlite");
const LEGACY_PULSE_JSON_STORE_PATH = path.resolve(__dirname, "..", "cache", "pulse-store.json");
const PULSE_INDEXER_SNAPSHOT_JSON = String(process.env.PULSE_INDEXER_SNAPSHOT_JSON || process.env.PULSE_INDEXER_JSON || "").trim();
const PULSE_INDEXER_SNAPSHOT_PATH = resolvePulseIndexerSnapshotPath(
  process.env.PULSE_INDEXER_SNAPSHOT_PATH || process.env.PULSE_INDEXER_PATH,
);
const PULSE_INDEXER_SNAPSHOT_URL = String(process.env.PULSE_INDEXER_SNAPSHOT_URL || "").trim();
const PULSE_INDEXER_CACHE_MS = Math.max(0, parseEnvInt(process.env.PULSE_INDEXER_CACHE_MS, 30_000));
const PULSE_INDEXER_JOB_BOARD_START_BLOCK = Math.max(0, parseEnvInt(process.env.PULSE_INDEXER_JOB_BOARD_START_BLOCK, 0));
const ARC_WALLET_ACTIVITY_CACHE_MS = Math.max(0, parseEnvInt(process.env.ARC_WALLET_ACTIVITY_CACHE_MS, 10 * 60 * 1000));
const ARC_WALLET_ACTIVITY_TX_PAGE_SIZE = Math.min(1000, Math.max(100, parseEnvInt(process.env.ARC_WALLET_ACTIVITY_TX_PAGE_SIZE, 500)));
const ARC_WALLET_ACTIVITY_MAX_PAGES = Math.max(1, parseEnvInt(process.env.ARC_WALLET_ACTIVITY_MAX_PAGES, 30));
const ARC_WALLET_ACTIVITY_RECENT_LIMIT = Math.max(3, parseEnvInt(process.env.ARC_WALLET_ACTIVITY_RECENT_LIMIT, 8));
const ARC_WALLET_ACTIVITY_TOP_CONTRACT_LIMIT = Math.max(3, parseEnvInt(process.env.ARC_WALLET_ACTIVITY_TOP_CONTRACT_LIMIT, 6));
const ARC_WALLET_ACTIVITY_DEPLOYMENT_LIMIT = Math.max(3, parseEnvInt(process.env.ARC_WALLET_ACTIVITY_DEPLOYMENT_LIMIT, 6));
const ARC_EXPLORER_FETCH_TIMEOUT_MS = Math.max(3_000, parseEnvInt(process.env.ARC_EXPLORER_FETCH_TIMEOUT_MS, 12_000));

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
const JOB_POSTED_EVENT = parseAbiItem("event JobPosted(uint256 indexed jobId, address indexed client, address indexed agent, string title, string category, uint256 budget, uint8 workerType)");
const JOB_COMPLETED_EVENT = parseAbiItem("event JobCompleted(uint256 indexed jobId, address agent, uint256 agentPayout, uint256 platformFee)");
const JOB_CLAIMED_EVENT = parseAbiItem("event JobClaimed(uint256 indexed jobId, address indexed agent)");
const JOB_REJECTED_EVENT = parseAbiItem("event JobRejected(uint256 indexed jobId, address client, uint256 refund)");
const CAMPAIGN_CREATED_EVENT = parseAbiItem("event CampaignCreated(uint256 indexed campaignId, address indexed creator, string title, uint256 prizePool)");
const CAMPAIGN_EXPIRED_EVENT = parseAbiItem("event CampaignExpired(uint256 indexed campaignId, address creator, uint256 refund)");
const PULSE_INDEXER_EVENT_ABI = [
  JOB_POSTED_EVENT,
  JOB_COMPLETED_EVENT,
  JOB_CLAIMED_EVENT,
  JOB_REJECTED_EVENT,
  CAMPAIGN_CREATED_EVENT,
  CAMPAIGN_EXPIRED_EVENT,
];
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

const KNOWN_PULSE_INDEXER_JOB_BOARD_START_BLOCKS = new Map([
  [DEFAULT_JOB_BOARD_ADDRESS.toLowerCase(), 37_381_028n],
]);

function getPulseIndexerJobBoardStartBlock(latestBlock = 0n) {
  if (PULSE_INDEXER_JOB_BOARD_START_BLOCK > 0) {
    return BigInt(PULSE_INDEXER_JOB_BOARD_START_BLOCK);
  }

  const known = KNOWN_PULSE_INDEXER_JOB_BOARD_START_BLOCKS.get(JOB_BOARD_ADDRESS.toLowerCase());
  if (known) return known;

  if (latestBlock > 100_000n) {
    return latestBlock - 100_000n;
  }

  return 0n;
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

function ensureSqliteTransactionCompat(db) {
  if (db && typeof db.transaction !== "function") {
    Object.defineProperty(db, "transaction", {
      configurable: true,
      enumerable: false,
      writable: true,
      value(callback) {
        return (...args) => {
          db.exec("BEGIN");
          try {
            const result = callback(...args);
            db.exec("COMMIT");
            return result;
          } catch (err) {
            try {
              db.exec("ROLLBACK");
            } catch {}
            throw err;
          }
        };
      },
    });
  }

  return db;
}

let pulseDb = null;
let pulseDbReadyPromise = null;
let pulseIndexerSnapshotCache = null;
let pulseIndexerSnapshotLoadedAt = 0;
let pulseIndexerSnapshotPromise = null;
let pulseContractIndexerSyncPromise = null;
let pulseContractIndexerLastSyncAt = 0;
let pulseContractIndexerLoopTimer = null;
const pulseContractIndexerRuntime = {
  syncing: false,
  bootstrapped: false,
  startedAt: 0,
  completedAt: 0,
  durationMs: 0,
  targetBlock: 0,
  syncedBlock: 0,
  lastError: "",
};

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

function formatIndexedUsdcFromBaseUnits(value) {
  return formatUsdc(formatUnits(BigInt(value || 0n), 6));
}

function sortPulseIndexerLogs(logs = []) {
  return [...logs].sort((a, b) => (
    Number(a.blockNumber || 0n) - Number(b.blockNumber || 0n)
    || Number(a.logIndex || 0) - Number(b.logIndex || 0)
  ));
}

async function getPulseBlockTimestamp(blockNumber, cache = new Map()) {
  const key = String(blockNumber || 0n);
  if (cache.has(key)) return cache.get(key);
  const block = await publicClient.getBlock({ blockNumber: BigInt(blockNumber || 0n) });
  const timestamp = Number(block.timestamp || 0n) * 1000;
  cache.set(key, timestamp);
  return timestamp;
}

function getPulseIndexedContractRows(db) {
  return db.prepare(`
    SELECT *
    FROM pulse_indexed_contract_events
    WHERE contract_address = ?
    ORDER BY block_timestamp ASC, block_number ASC, log_index ASC
  `).all(JOB_BOARD_ADDRESS.toLowerCase());
}

function createPulseIndexedSeries(rows = [], days = PULSE_SERIES_DAYS) {
  const points = [];
  const bucketMap = new Map();
  const now = Date.now();

  for (let index = days - 1; index >= 0; index--) {
    const date = utcDayKey(now - (index * DAY_MS));
    const item = { date, jobs: 0, volumeUsdcRaw: 0 };
    points.push(item);
    bucketMap.set(date, item);
  }

  for (const row of rows) {
    if (!["job_posted", "campaign_created"].includes(String(row.event_key || ""))) continue;
    const bucket = bucketMap.get(utcDayKey(Number(row.block_timestamp || 0)));
    if (!bucket) continue;
    bucket.jobs += 1;
    bucket.volumeUsdcRaw += toUsdcNumber(row.amount_usdc);
  }

  return points.map(point => ({
    date: point.date,
    jobs: point.jobs,
    volumeUsdc: formatUsdc(point.volumeUsdcRaw),
  }));
}

function createPulseIndexedCategoryBreakdown(rows = []) {
  const categories = new Map();

  for (const row of rows) {
    if (String(row.event_key || "") !== "job_posted") continue;
    const category = String(row.category || "").trim() || "Uncategorized";
    if (!categories.has(category)) {
      categories.set(category, { category, jobs: 0, volumeUsdcRaw: 0 });
    }
    const item = categories.get(category);
    item.jobs += 1;
    item.volumeUsdcRaw += toUsdcNumber(row.amount_usdc);
  }

  return [...categories.values()]
    .sort((a, b) => b.volumeUsdcRaw - a.volumeUsdcRaw || a.category.localeCompare(b.category))
    .map(item => ({
      category: item.category,
      jobs: item.jobs,
      volumeUsdc: formatUsdc(item.volumeUsdcRaw),
    }));
}

function buildPulseContractIndexerState(db, baseOverview = {}) {
  const rows = getPulseIndexedContractRows(db);
  const lastSyncedAt = Number(pulseMetaGet(db, "pulse-indexer:last-synced-at") || 0);
  const syncedToBlock = Number(pulseMetaGet(db, "pulse-indexer:last-synced-block") || 0);
  const startBlock = Number(pulseMetaGet(db, "pulse-indexer:start-block") || 0);
  const wallets = new Set();
  let trackedVolumeUsdcRaw = 0;
  let settledVolumeUsdcRaw = 0;
  let totalJobs = 0;
  let completedJobs = 0;
  let campaigns = 0;
  const activityRows = [];

  for (const row of rows) {
    const eventKey = String(row.event_key || "");
    const primaryWallet = String(row.wallet_primary || "").toLowerCase();
    const secondaryWallet = String(row.wallet_secondary || "").toLowerCase();
    const amountUsdc = toUsdcNumber(row.amount_usdc);

    if (primaryWallet && !sameAddress(primaryWallet, ZERO_ADDRESS)) wallets.add(primaryWallet);
    if (secondaryWallet && !sameAddress(secondaryWallet, ZERO_ADDRESS)) wallets.add(secondaryWallet);

    if (eventKey === "job_posted") {
      totalJobs += 1;
      trackedVolumeUsdcRaw += amountUsdc;
      activityRows.push(row);
    } else if (eventKey === "campaign_created") {
      campaigns += 1;
      trackedVolumeUsdcRaw += amountUsdc;
      activityRows.push(row);
    } else if (eventKey === "job_completed") {
      completedJobs += 1;
      settledVolumeUsdcRaw += amountUsdc;
    }
  }

  const weekMs = 7 * DAY_MS;
  const now = Date.now();
  const currentWeekStart = now - weekMs;
  const previousWeekStart = now - (2 * weekMs);
  const thisWeekVolume = activityRows
    .filter(row => Number(row.block_timestamp || 0) >= currentWeekStart)
    .reduce((sum, row) => sum + toUsdcNumber(row.amount_usdc), 0);
  const previousWeekVolume = activityRows
    .filter(row => {
      const timestamp = Number(row.block_timestamp || 0);
      return timestamp >= previousWeekStart && timestamp < currentWeekStart;
    })
    .reduce((sum, row) => sum + toUsdcNumber(row.amount_usdc), 0);

  let growthDirection = "flat";
  if (thisWeekVolume > previousWeekVolume) growthDirection = "up";
  if (thisWeekVolume < previousWeekVolume) growthDirection = "down";

  const overview = {
    trackedEscrowVolumeUsdc: formatUsdc(trackedVolumeUsdcRaw),
    settledVolumeUsdc: formatUsdc(settledVolumeUsdcRaw),
    trackedWallets: wallets.size,
    totalJobs,
    completedJobs,
  };

  if (baseOverview.activeCampaigns !== undefined) overview.activeCampaigns = baseOverview.activeCampaigns;
  if (baseOverview.openJobs !== undefined) overview.openJobs = baseOverview.openJobs;

  return createPulseIndexerState({
    configured: true,
    connected: Boolean(lastSyncedAt > 0 || rows.length > 0),
    syncing: pulseContractIndexerRuntime.syncing,
    bootstrapped: pulseContractIndexerRuntime.bootstrapped || lastSyncedAt > 0,
    sourceLabel: "Arc RPC event indexer",
    scope: "live-contract-indexed",
    generatedAt: lastSyncedAt || Date.now(),
    syncStartedAt: pulseContractIndexerRuntime.startedAt,
    syncCompletedAt: pulseContractIndexerRuntime.completedAt || lastSyncedAt,
    syncDurationMs: pulseContractIndexerRuntime.durationMs,
    syncedBlock: pulseContractIndexerRuntime.syncedBlock || syncedToBlock,
    targetBlock: pulseContractIndexerRuntime.targetBlock,
    overview,
    volume14d: createPulseIndexedSeries(rows),
    categoryBreakdown: createPulseIndexedCategoryBreakdown(rows),
    appRankings: [{
      rank: 1,
      id: "agentmarket",
      name: "AgentMarket",
      category: "AI / Work",
      description: "Live event-indexed view built from the AgentMarket Arc contract.",
      volumeUsdc: formatUsdc(trackedVolumeUsdcRaw),
      weeklyVolumeUsdc: formatUsdc(thisWeekVolume),
      previousWeekVolumeUsdc: formatUsdc(previousWeekVolume),
      growthDirection,
      growthPercent: previousWeekVolume > 0
        ? Number((((thisWeekVolume - previousWeekVolume) / previousWeekVolume) * 100).toFixed(1))
        : null,
      activeWallets: wallets.size,
      jobs: totalJobs,
      campaigns,
      liveContracts: [JOB_BOARD_ADDRESS],
      status: "Live indexed",
    }],
    notes: [
      `Pulse contract indexer is live against ${shortWallet(JOB_BOARD_ADDRESS)} on Arc.`,
      syncedToBlock > 0
        ? `Latest indexed block #${syncedToBlock.toLocaleString("en-US")} with sync time ${formatPulseCalendarLabel(lastSyncedAt || Date.now())}.`
        : "The live contract indexer is connected and waiting for the first indexed block.",
      startBlock > 0
        ? `Indexer backfill starts from block #${startBlock.toLocaleString("en-US")}.`
        : "Indexer start block is using the automatic fallback window.",
    ],
    error: pulseContractIndexerRuntime.lastError || "",
  });
}

async function syncPulseContractIndexer(db) {
  if (!PULSE_INTERNAL_INDEXER_ENABLED) {
    return createPulseIndexerState();
  }

  const syncStartedAt = Date.now();
  pulseContractIndexerRuntime.syncing = true;
  pulseContractIndexerRuntime.startedAt = syncStartedAt;
  pulseContractIndexerRuntime.lastError = "";

  const latestBlock = await publicClient.getBlockNumber();
  const targetBlock = latestBlock > PULSE_INDEXER_CONFIRMATION_BLOCKS
    ? latestBlock - PULSE_INDEXER_CONFIRMATION_BLOCKS
    : latestBlock;
  pulseContractIndexerRuntime.targetBlock = Number(targetBlock);

  const configuredStartBlock = getPulseIndexerJobBoardStartBlock(targetBlock);
  ensurePulseContractIndexerSchema(db, configuredStartBlock);
  const storedLastBlockValue = pulseMetaGet(db, "pulse-indexer:last-synced-block");
  const storedLastBlock = storedLastBlockValue ? BigInt(storedLastBlockValue) : (configuredStartBlock > 0n ? configuredStartBlock - 1n : -1n);

  if (storedLastBlock >= targetBlock) {
    pulseMetaSet(db, "pulse-indexer:last-synced-at", Date.now());
    const state = buildPulseContractIndexerState(db);
    pulseContractIndexerRuntime.syncing = false;
    pulseContractIndexerRuntime.bootstrapped = true;
    pulseContractIndexerRuntime.completedAt = Date.now();
    pulseContractIndexerRuntime.durationMs = pulseContractIndexerRuntime.completedAt - syncStartedAt;
    pulseContractIndexerRuntime.syncedBlock = Number(storedLastBlock);
    return state;
  }

  const insertEvent = db.prepare(`
    INSERT INTO pulse_indexed_contract_events (
      contract_address,
      event_key,
      entity_id,
      wallet_primary,
      wallet_secondary,
      category,
      title,
      amount_usdc,
      tx_hash,
      log_index,
      block_number,
      block_timestamp,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tx_hash, log_index) DO NOTHING
  `);

  const persistEvents = db.transaction((rows) => {
    for (const row of rows) {
      insertEvent.run(
        row.contractAddress,
        row.eventKey,
        row.entityId,
        row.walletPrimary,
        row.walletSecondary,
        row.category,
        row.title,
        row.amountUsdc,
        row.txHash,
        row.logIndex,
        row.blockNumber,
        row.blockTimestamp,
        row.payloadJson,
        row.createdAt,
      );
    }
  });

  const blockTimestampCache = new Map();
  let chunkStart = storedLastBlock + 1n;

  while (chunkStart <= targetBlock) {
    const chunkEnd = chunkStart + PULSE_INDEXER_EVENT_CHUNK_SIZE - 1n > targetBlock
      ? targetBlock
      : chunkStart + PULSE_INDEXER_EVENT_CHUNK_SIZE - 1n;

    const normalizedRows = [];
    const rawLogs = await publicClient.getLogs({
      address: JOB_BOARD_ADDRESS,
      fromBlock: chunkStart,
      toBlock: chunkEnd,
    });
    const logs = sortPulseIndexerLogs(parseEventLogs({
      abi: PULSE_INDEXER_EVENT_ABI,
      logs: rawLogs,
      strict: false,
    }));

    for (const log of logs) {
      const eventName = String(log.eventName || "");
      const blockTimestamp = await getPulseBlockTimestamp(log.blockNumber, blockTimestampCache);
      const txHash = String(log.transactionHash || "");
      const logIndex = Number(log.logIndex || 0);
      const blockNumber = Number(log.blockNumber || 0n);
      const args = log.args || {};

      if (eventName === "JobPosted") {
        normalizedRows.push({
          contractAddress: JOB_BOARD_ADDRESS.toLowerCase(),
          eventKey: "job_posted",
          entityId: String(args.jobId || ""),
          walletPrimary: String(args.client || "").toLowerCase(),
          walletSecondary: String(args.agent || "").toLowerCase(),
          category: String(args.category || ""),
          title: String(args.title || ""),
          amountUsdc: formatIndexedUsdcFromBaseUnits(args.budget || 0n),
          txHash,
          logIndex,
          blockNumber,
          blockTimestamp,
          payloadJson: JSON.stringify({
            workerType: Number(args.workerType || 0),
          }),
          createdAt: blockTimestamp,
        });
      } else if (eventName === "JobClaimed") {
        normalizedRows.push({
          contractAddress: JOB_BOARD_ADDRESS.toLowerCase(),
          eventKey: "job_claimed",
          entityId: String(args.jobId || ""),
          walletPrimary: String(args.agent || "").toLowerCase(),
          walletSecondary: "",
          category: "",
          title: "",
          amountUsdc: "0.00",
          txHash,
          logIndex,
          blockNumber,
          blockTimestamp,
          payloadJson: "{}",
          createdAt: blockTimestamp,
        });
      } else if (eventName === "JobCompleted") {
        normalizedRows.push({
          contractAddress: JOB_BOARD_ADDRESS.toLowerCase(),
          eventKey: "job_completed",
          entityId: String(args.jobId || ""),
          walletPrimary: String(args.agent || "").toLowerCase(),
          walletSecondary: "",
          category: "",
          title: "",
          amountUsdc: formatIndexedUsdcFromBaseUnits(BigInt(args.agentPayout || 0n) + BigInt(args.platformFee || 0n)),
          txHash,
          logIndex,
          blockNumber,
          blockTimestamp,
          payloadJson: JSON.stringify({
            agentPayoutUsdc: formatIndexedUsdcFromBaseUnits(args.agentPayout || 0n),
            platformFeeUsdc: formatIndexedUsdcFromBaseUnits(args.platformFee || 0n),
          }),
          createdAt: blockTimestamp,
        });
      } else if (eventName === "JobRejected") {
        normalizedRows.push({
          contractAddress: JOB_BOARD_ADDRESS.toLowerCase(),
          eventKey: "job_rejected",
          entityId: String(args.jobId || ""),
          walletPrimary: String(args.client || "").toLowerCase(),
          walletSecondary: "",
          category: "",
          title: "",
          amountUsdc: formatIndexedUsdcFromBaseUnits(args.refund || 0n),
          txHash,
          logIndex,
          blockNumber,
          blockTimestamp,
          payloadJson: "{}",
          createdAt: blockTimestamp,
        });
      } else if (eventName === "CampaignCreated") {
        normalizedRows.push({
          contractAddress: JOB_BOARD_ADDRESS.toLowerCase(),
          eventKey: "campaign_created",
          entityId: String(args.campaignId || ""),
          walletPrimary: String(args.creator || "").toLowerCase(),
          walletSecondary: "",
          category: "Campaigns",
          title: String(args.title || ""),
          amountUsdc: formatIndexedUsdcFromBaseUnits(args.prizePool || 0n),
          txHash,
          logIndex,
          blockNumber,
          blockTimestamp,
          payloadJson: "{}",
          createdAt: blockTimestamp,
        });
      } else if (eventName === "CampaignExpired") {
        normalizedRows.push({
          contractAddress: JOB_BOARD_ADDRESS.toLowerCase(),
          eventKey: "campaign_expired",
          entityId: String(args.campaignId || ""),
          walletPrimary: String(args.creator || "").toLowerCase(),
          walletSecondary: "",
          category: "Campaigns",
          title: "",
          amountUsdc: formatIndexedUsdcFromBaseUnits(args.refund || 0n),
          txHash,
          logIndex,
          blockNumber,
          blockTimestamp,
          payloadJson: "{}",
          createdAt: blockTimestamp,
        });
      }
    }

    if (normalizedRows.length) {
      persistEvents(normalizedRows);
    }

    pulseMetaSet(db, "pulse-indexer:last-synced-block", chunkEnd.toString());
    pulseMetaSet(db, "pulse-indexer:last-synced-at", Date.now());
    pulseContractIndexerRuntime.syncedBlock = Number(chunkEnd);
    chunkStart = chunkEnd + 1n;
  }

  const state = buildPulseContractIndexerState(db, {});
  pulseContractIndexerRuntime.syncing = false;
  pulseContractIndexerRuntime.bootstrapped = true;
  pulseContractIndexerRuntime.completedAt = Date.now();
  pulseContractIndexerRuntime.durationMs = pulseContractIndexerRuntime.completedAt - syncStartedAt;
  pulseContractIndexerRuntime.lastError = "";
  return state;
}

async function ensurePulseContractIndexer(db, { force = false } = {}) {
  if (!PULSE_INTERNAL_INDEXER_ENABLED) {
    return createPulseIndexerState();
  }

  if (
    !force
    && !pulseContractIndexerSyncPromise
    && (Date.now() - pulseContractIndexerLastSyncAt) < PULSE_INDEXER_SYNC_INTERVAL_MS
  ) {
    return buildPulseContractIndexerState(db);
  }

  if (!pulseContractIndexerSyncPromise) {
    pulseContractIndexerSyncPromise = (async () => {
      try {
        return await syncPulseContractIndexer(db);
      } catch (err) {
        pulseContractIndexerRuntime.syncing = false;
        pulseContractIndexerRuntime.completedAt = Date.now();
        pulseContractIndexerRuntime.durationMs = pulseContractIndexerRuntime.startedAt
          ? pulseContractIndexerRuntime.completedAt - pulseContractIndexerRuntime.startedAt
          : 0;
        pulseContractIndexerRuntime.lastError = err.message || "Could not sync the live Pulse contract indexer";
        throw err;
      } finally {
        pulseContractIndexerLastSyncAt = Date.now();
      }
    })();
  }

  if (!force && pulseContractIndexerRuntime.bootstrapped) {
    return buildPulseContractIndexerState(db);
  }

  try {
    return await pulseContractIndexerSyncPromise;
  } finally {
    pulseContractIndexerSyncPromise = null;
  }
}

async function runPulseContractIndexerCycle({ force = false, reason = "manual" } = {}) {
  if (!PULSE_INTERNAL_INDEXER_ENABLED) return createPulseIndexerState();

  try {
    const db = await ensurePulseDatabase();
    return await ensurePulseContractIndexer(db, { force });
  } catch (err) {
    pulseContractIndexerRuntime.syncing = false;
    pulseContractIndexerRuntime.completedAt = Date.now();
    pulseContractIndexerRuntime.lastError = err.message || `Pulse indexer ${reason} sync failed`;
    console.warn(`Pulse indexer ${reason} sync failed:`, err.message || err);
    return createPulseIndexerState({
      configured: true,
      connected: pulseContractIndexerRuntime.bootstrapped,
      syncing: false,
      bootstrapped: pulseContractIndexerRuntime.bootstrapped,
      sourceLabel: "Arc RPC event indexer",
      scope: "live-contract-indexed",
      generatedAt: pulseContractIndexerRuntime.completedAt,
      syncStartedAt: pulseContractIndexerRuntime.startedAt,
      syncCompletedAt: pulseContractIndexerRuntime.completedAt,
      syncDurationMs: pulseContractIndexerRuntime.durationMs,
      syncedBlock: pulseContractIndexerRuntime.syncedBlock,
      targetBlock: pulseContractIndexerRuntime.targetBlock,
      error: pulseContractIndexerRuntime.lastError,
    });
  }
}

function startPulseContractIndexerLoop() {
  if (!PULSE_INTERNAL_INDEXER_ENABLED || IS_SERVERLESS_RUNTIME || pulseContractIndexerLoopTimer) return;

  runPulseContractIndexerCycle({ force: true, reason: "startup" }).catch(() => {});
  pulseContractIndexerLoopTimer = setInterval(() => {
    runPulseContractIndexerCycle({ force: true, reason: "background" }).catch(() => {});
  }, PULSE_INDEXER_SYNC_INTERVAL_MS);

  if (typeof pulseContractIndexerLoopTimer?.unref === "function") {
    pulseContractIndexerLoopTimer.unref();
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePulseIndexerText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function parsePulseIndexerNumber(value, fallback = 0) {
  const amount = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(amount) ? amount : fallback;
}

function parsePulseIndexerCount(value, fallback = 0) {
  const amount = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(amount) ? Math.max(0, amount) : fallback;
}

function normalizePulseIndexerTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return 0;
    return value >= 1_000_000_000_000 ? Math.round(value) : Math.round(value * 1000);
  }

  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return normalizePulseIndexerTimestamp(Number(text));

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePulseIndexerDateKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const parsed = normalizePulseIndexerTimestamp(text);
  return parsed ? utcDayKey(parsed) : "";
}

function getPulseIndexerDefaultSourceLabel() {
  if (PULSE_INDEXER_SNAPSHOT_JSON) return "Inline Pulse indexer snapshot";
  if (PULSE_INDEXER_SNAPSHOT_PATH) return `Pulse snapshot file ${path.basename(PULSE_INDEXER_SNAPSHOT_PATH)}`;
  if (PULSE_INDEXER_SNAPSHOT_URL) {
    try {
      return `Pulse snapshot URL ${new URL(PULSE_INDEXER_SNAPSHOT_URL).host}`;
    } catch {
      return "Pulse snapshot URL";
    }
  }
  return "";
}

function createPulseIndexerState(overrides = {}) {
  return {
    configured: false,
    connected: false,
    syncing: false,
    bootstrapped: false,
    sourceLabel: "",
    scope: "",
    generatedAt: 0,
    syncStartedAt: 0,
    syncCompletedAt: 0,
    syncDurationMs: 0,
    syncedBlock: 0,
    targetBlock: 0,
    overview: {},
    volume14d: [],
    categoryBreakdown: [],
    appRankings: [],
    notes: [],
    error: "",
    ...overrides,
  };
}

function normalizePulseIndexerOverview(input = {}) {
  if (!isPlainObject(input)) return {};

  const overview = {};
  const assignUsdc = (key, value) => {
    if (value === undefined || value === null || value === "") return;
    overview[key] = formatUsdc(parsePulseIndexerNumber(value, 0));
  };
  const assignCount = (key, value) => {
    if (value === undefined || value === null || value === "") return;
    overview[key] = parsePulseIndexerCount(value, 0);
  };

  assignUsdc("trackedEscrowVolumeUsdc", input.trackedEscrowVolumeUsdc ?? input.totalVolumeUsdc ?? input.trackedVolumeUsdc);
  assignUsdc("settledVolumeUsdc", input.settledVolumeUsdc ?? input.completedVolumeUsdc);
  assignCount("trackedWallets", input.trackedWallets ?? input.activeWallets ?? input.uniqueWallets);
  assignCount("totalJobs", input.totalJobs ?? input.jobs);
  assignCount("completedJobs", input.completedJobs);
  assignCount("openJobs", input.openJobs);
  assignCount("activeCampaigns", input.activeCampaigns ?? input.campaigns);

  return overview;
}

function normalizePulseIndexerSeries(items = []) {
  if (!Array.isArray(items)) return [];

  return items
    .map(item => {
      if (!isPlainObject(item)) return null;
      const date = normalizePulseIndexerDateKey(item.date ?? item.day ?? item.label ?? item.timestamp);
      if (!date) return null;
      return {
        date,
        jobs: parsePulseIndexerCount(item.jobs ?? item.count ?? item.events, 0),
        volumeUsdc: formatUsdc(parsePulseIndexerNumber(item.volumeUsdc ?? item.volume ?? item.totalUsdc, 0)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function normalizePulseIndexerCategoryBreakdown(items = []) {
  if (!Array.isArray(items)) return [];

  return items
    .map(item => {
      if (!isPlainObject(item)) return null;
      const category = normalizePulseIndexerText(item.category ?? item.name, "");
      if (!category) return null;
      return {
        category,
        jobs: parsePulseIndexerCount(item.jobs ?? item.count ?? item.events, 0),
        volumeUsdc: formatUsdc(parsePulseIndexerNumber(item.volumeUsdc ?? item.volume ?? item.totalUsdc, 0)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (
      parsePulseIndexerNumber(b.volumeUsdc, 0) - parsePulseIndexerNumber(a.volumeUsdc, 0)
      || a.category.localeCompare(b.category)
    ));
}

function normalizePulseIndexerNotes(notes = []) {
  if (!Array.isArray(notes)) return [];
  return notes
    .map(note => normalizePulseIndexerText(note, ""))
    .filter(Boolean)
    .slice(0, 8);
}

function normalizePulseIndexerAppRanking(item, fallbackIndex = 0) {
  if (!isPlainObject(item)) return null;

  const id = normalizePulseIndexerText(item.id, `indexed-${fallbackIndex + 1}`);
  const name = normalizePulseIndexerText(item.name, id);
  const category = normalizePulseIndexerText(item.category, "Arc App");
  const description = normalizePulseIndexerText(item.description, "Indexed Arc activity view.");
  const volumeUsdc = parsePulseIndexerNumber(item.volumeUsdc ?? item.totalVolumeUsdc ?? item.volume, 0);
  const weeklyVolumeUsdc = parsePulseIndexerNumber(item.weeklyVolumeUsdc ?? item.thisWeekVolumeUsdc ?? item.volume7dUsdc, 0);
  const previousWeekVolumeUsdc = parsePulseIndexerNumber(
    item.previousWeekVolumeUsdc ?? item.previousVolumeUsdc ?? item.lastWeekVolumeUsdc,
    0,
  );

  let growthDirection = normalizePulseIndexerText(item.growthDirection, "");
  if (!["up", "down", "flat"].includes(growthDirection)) {
    growthDirection = weeklyVolumeUsdc > previousWeekVolumeUsdc
      ? "up"
      : weeklyVolumeUsdc < previousWeekVolumeUsdc
        ? "down"
        : "flat";
  }

  let growthPercent = null;
  if (item.growthPercent !== undefined && item.growthPercent !== null && item.growthPercent !== "") {
    const parsed = parsePulseIndexerNumber(item.growthPercent, null);
    growthPercent = parsed == null ? null : Number(parsed.toFixed(1));
  } else if (previousWeekVolumeUsdc > 0) {
    growthPercent = Number((((weeklyVolumeUsdc - previousWeekVolumeUsdc) / previousWeekVolumeUsdc) * 100).toFixed(1));
  }

  const liveContracts = Array.isArray(item.liveContracts)
    ? item.liveContracts.map(value => String(value || "").trim()).filter(isHexAddress)
    : [];

  return {
    rank: fallbackIndex + 1,
    id,
    name,
    category,
    description,
    volumeUsdc: formatUsdc(volumeUsdc),
    weeklyVolumeUsdc: formatUsdc(weeklyVolumeUsdc),
    previousWeekVolumeUsdc: formatUsdc(previousWeekVolumeUsdc),
    growthDirection,
    growthPercent,
    activeWallets: parsePulseIndexerCount(item.activeWallets ?? item.wallets ?? item.uniqueWallets, 0),
    jobs: parsePulseIndexerCount(item.jobs ?? item.contractEvents ?? item.events, 0),
    campaigns: parsePulseIndexerCount(item.campaigns, 0),
    liveContracts,
    status: normalizePulseIndexerText(item.status, "Full-network indexed"),
  };
}

function normalizePulseIndexerSnapshot(input = {}) {
  if (!isPlainObject(input)) {
    throw new Error("Pulse indexer snapshot must be a JSON object");
  }

  const sourceLabel = normalizePulseIndexerText(
    input.source ?? input.sourceLabel ?? input.provider,
    getPulseIndexerDefaultSourceLabel(),
  );

  return {
    sourceLabel,
    scope: normalizePulseIndexerText(input.scope, "indexed-overlay"),
    generatedAt: normalizePulseIndexerTimestamp(
      input.generatedAt ?? input.generated_at ?? input.updatedAt ?? input.updated_at,
    ),
    overview: normalizePulseIndexerOverview(input.overview || {}),
    volume14d: normalizePulseIndexerSeries(input.volume14d ?? input.volumeSeries ?? input.series),
    categoryBreakdown: normalizePulseIndexerCategoryBreakdown(
      input.categoryBreakdown ?? input.categories ?? input.categoryMix,
    ),
    appRankings: Array.isArray(input.appRankings ?? input.rankings)
      ? (input.appRankings ?? input.rankings)
        .map((item, index) => normalizePulseIndexerAppRanking(item, index))
        .filter(Boolean)
      : [],
    notes: normalizePulseIndexerNotes(input.notes),
  };
}

async function loadPulseIndexerSnapshot() {
  let rawSnapshot = null;

  if (PULSE_INDEXER_SNAPSHOT_JSON) {
    rawSnapshot = JSON.parse(PULSE_INDEXER_SNAPSHOT_JSON);
  } else if (PULSE_INDEXER_SNAPSHOT_PATH) {
    rawSnapshot = JSON.parse(await fs.readFile(PULSE_INDEXER_SNAPSHOT_PATH, "utf8"));
  } else if (PULSE_INDEXER_SNAPSHOT_URL) {
    const response = await fetch(PULSE_INDEXER_SNAPSHOT_URL);
    if (!response.ok) {
      throw new Error(`Pulse indexer snapshot request failed with status ${response.status}`);
    }
    rawSnapshot = await response.json();
  }

  if (!rawSnapshot) {
    return createPulseIndexerState();
  }

  return createPulseIndexerState({
    configured: true,
    connected: true,
    ...normalizePulseIndexerSnapshot(rawSnapshot),
  });
}

async function getConfiguredPulseIndexerSnapshot() {
  if (!PULSE_INDEXER_SNAPSHOT_JSON && !PULSE_INDEXER_SNAPSHOT_PATH && !PULSE_INDEXER_SNAPSHOT_URL) {
    return null;
  }

  const now = Date.now();
  if (
    pulseIndexerSnapshotCache
    && PULSE_INDEXER_CACHE_MS > 0
    && (now - pulseIndexerSnapshotLoadedAt) < PULSE_INDEXER_CACHE_MS
  ) {
    return pulseIndexerSnapshotCache;
  }

  if (!pulseIndexerSnapshotPromise) {
    pulseIndexerSnapshotPromise = (async () => {
      try {
        pulseIndexerSnapshotCache = await loadPulseIndexerSnapshot();
      } catch (err) {
        pulseIndexerSnapshotCache = createPulseIndexerState({
          configured: true,
          connected: false,
          sourceLabel: getPulseIndexerDefaultSourceLabel(),
          error: err.message || "Could not load the Pulse indexer snapshot",
        });
      }

      pulseIndexerSnapshotLoadedAt = Date.now();
      return pulseIndexerSnapshotCache;
    })();
  }

  try {
    return await pulseIndexerSnapshotPromise;
  } finally {
    pulseIndexerSnapshotPromise = null;
  }
}

async function getPulseIndexerSnapshot(db, baseOverview = {}) {
  const configuredSnapshot = await getConfiguredPulseIndexerSnapshot();
  if (configuredSnapshot) {
    return {
      ...configuredSnapshot,
      overview: buildPulseOverview(baseOverview, configuredSnapshot.overview),
    };
  }

  try {
    const liveIndexer = await ensurePulseContractIndexer(db);
    if (liveIndexer?.configured || liveIndexer?.connected) {
      liveIndexer.overview = buildPulseOverview(baseOverview, liveIndexer.overview);
      return liveIndexer;
    }
  } catch (err) {
    return createPulseIndexerState({
      configured: PULSE_INTERNAL_INDEXER_ENABLED,
      connected: pulseContractIndexerRuntime.bootstrapped,
      syncing: pulseContractIndexerRuntime.syncing,
      bootstrapped: pulseContractIndexerRuntime.bootstrapped,
      sourceLabel: "Arc RPC event indexer",
      scope: "live-contract-indexed",
      generatedAt: pulseContractIndexerRuntime.completedAt,
      syncStartedAt: pulseContractIndexerRuntime.startedAt,
      syncCompletedAt: pulseContractIndexerRuntime.completedAt,
      syncDurationMs: pulseContractIndexerRuntime.durationMs,
      syncedBlock: pulseContractIndexerRuntime.syncedBlock,
      targetBlock: pulseContractIndexerRuntime.targetBlock,
      error: err.message || "Could not sync the live Pulse contract indexer",
    });
  }

  return createPulseIndexerState();
}

function buildPulseOverview(baseOverview, indexedOverview = {}) {
  const merged = { ...baseOverview };
  for (const key of [
    "trackedEscrowVolumeUsdc",
    "settledVolumeUsdc",
    "trackedWallets",
    "totalJobs",
    "completedJobs",
    "openJobs",
    "activeCampaigns",
  ]) {
    if (indexedOverview[key] !== undefined) {
      merged[key] = indexedOverview[key];
    }
  }
  return merged;
}

function getPulseRankingKey(item = {}, fallbackIndex = 0) {
  const id = normalizePulseIndexerText(item.id, "");
  const name = normalizePulseIndexerText(item.name, "");
  return (id || name || `ranking-${fallbackIndex + 1}`).toLowerCase();
}

function buildPulseAppRankings(trackedRankings = [], indexedRankings = []) {
  if (!Array.isArray(indexedRankings) || !indexedRankings.length) {
    return trackedRankings.map((item, index) => ({ ...item, rank: index + 1 }));
  }

  const merged = new Map();
  for (const [index, item] of indexedRankings.entries()) {
    merged.set(getPulseRankingKey(item, index), item);
  }
  for (const [index, item] of trackedRankings.entries()) {
    const key = getPulseRankingKey(item, index);
    if (!merged.has(key)) merged.set(key, item);
  }

  return [...merged.values()]
    .sort((a, b) => (
      parsePulseIndexerNumber(b.volumeUsdc, 0) - parsePulseIndexerNumber(a.volumeUsdc, 0)
      || parsePulseIndexerNumber(b.weeklyVolumeUsdc, 0) - parsePulseIndexerNumber(a.weeklyVolumeUsdc, 0)
      || Number(b.activeWallets || 0) - Number(a.activeWallets || 0)
      || String(a.name || "").localeCompare(String(b.name || ""))
    ))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function buildPulseOverviewNotes(indexerState) {
  const notes = [
    "Live Arc blocks still come directly from the Arc RPC endpoint.",
    "Community feed, votes, and streaks persist in the SQLite-backed Pulse store.",
  ];

  if (indexerState?.configured && indexerState?.syncing && !indexerState?.connected) {
    notes.push("Pulse is warming the live contract indexer in the background. A fresh cache can take longer on its first historical backfill.");
    notes.push("Pulse is serving the tracked AgentMarket contract view until the indexed pass finishes.");
    return notes;
  }

  if (indexerState?.connected) {
    const freshness = indexerState.generatedAt
      ? ` Sync timestamp ${formatPulseCalendarLabel(indexerState.generatedAt)}.`
      : "";
    notes.push(`Volume, categories, and app rankings now widen through ${indexerState.sourceLabel || "the active Pulse indexer"}.${freshness}`.trim());
    notes.push("Arc ID wallet scoring now uses indexed AgentMarket wallet activity whenever live contract rows are available.");
    if (indexerState.syncing) {
      notes.push("A background refresh is running now, so indexed totals may keep moving upward until the current sync finishes.");
    }
    for (const note of indexerState.notes || []) notes.push(note);
    return notes;
  }

  if (indexerState?.configured && indexerState.error) {
    notes.push(`Pulse indexer hookup is configured, but the indexed source could not be loaded: ${indexerState.error}`);
    notes.push("Pulse is falling back to the tracked AgentMarket contract view until the live indexed source is reachable again.");
    return notes;
  }

  notes.push("Volume, categories, and rankings are currently tracked from the AgentMarket contracts only.");
  notes.push("Set PULSE_INDEXER_SNAPSHOT_PATH, PULSE_INDEXER_SNAPSHOT_URL, or PULSE_INDEXER_SNAPSHOT_JSON to override the built-in live contract indexer with a hosted indexed source.");
  return notes;
}

function ensurePulseContractIndexerSchema(db, configuredStartBlock) {
  const currentVersion = pulseMetaGet(db, "pulse-indexer:schema-version");
  if (currentVersion === PULSE_INDEXER_SCHEMA_VERSION) return;

  db.exec("DELETE FROM pulse_indexed_contract_events;");
  pulseMetaSet(db, "pulse-indexer:schema-version", PULSE_INDEXER_SCHEMA_VERSION);
  pulseMetaSet(db, "pulse-indexer:start-block", configuredStartBlock.toString());
  pulseMetaSet(
    db,
    "pulse-indexer:last-synced-block",
    (configuredStartBlock > 0n ? configuredStartBlock - 1n : -1n).toString(),
  );
  pulseMetaSet(db, "pulse-indexer:last-synced-at", "0");
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
  const legacyPaths = [...new Set([LEGACY_PULSE_JSON_STORE_PATH, PULSE_JSON_STORE_PATH])];
  for (const candidatePath of legacyPaths) {
    try {
      const raw = await fs.readFile(candidatePath, "utf8");
      const parsed = JSON.parse(raw);
      legacyStore = {
        feedPosts: Array.isArray(parsed?.feedPosts) ? parsed.feedPosts : [],
        profiles: parsed?.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {},
      };
      break;
    } catch (err) {
      if (err?.code !== "ENOENT") {
        console.warn(`Could not read legacy ArcPulse JSON store at ${candidatePath}:`, err.message);
      }
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
      let db;
      try {
        await fs.mkdir(path.dirname(PULSE_DB_PATH), { recursive: true });
        db = ensureSqliteTransactionCompat(new DatabaseSync(PULSE_DB_PATH));
      } catch (err) {
        console.warn(`Could not open Pulse database at ${PULSE_DB_PATH}; falling back to in-memory storage:`, err.message);
        db = ensureSqliteTransactionCompat(new DatabaseSync(":memory:"));
      }
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

        CREATE TABLE IF NOT EXISTS pulse_arc_wallet_activity_cache (
          wallet TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL DEFAULT '{}',
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pulse_indexed_contract_events (
          contract_address TEXT NOT NULL,
          event_key TEXT NOT NULL,
          entity_id TEXT NOT NULL DEFAULT '',
          wallet_primary TEXT NOT NULL DEFAULT '',
          wallet_secondary TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          amount_usdc TEXT NOT NULL DEFAULT '0.00',
          tx_hash TEXT NOT NULL,
          log_index INTEGER NOT NULL,
          block_number INTEGER NOT NULL,
          block_timestamp INTEGER NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          PRIMARY KEY (tx_hash, log_index)
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
        CREATE INDEX IF NOT EXISTS idx_pulse_arc_wallet_activity_cache_updated_at ON pulse_arc_wallet_activity_cache(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pulse_indexed_contract_events_block ON pulse_indexed_contract_events(block_number DESC);
        CREATE INDEX IF NOT EXISTS idx_pulse_indexed_contract_events_event_key ON pulse_indexed_contract_events(event_key, block_timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_pulse_indexed_contract_events_wallet_primary ON pulse_indexed_contract_events(wallet_primary);
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
    jobsCompleted: 0,
    jobsSettled: 0,
    campaignsCreated: 0,
    postsShared: 0,
    postUpvotesEarned: 0,
    trackedVolumeUsdc: 0,
    settledVolumeUsdc: 0,
    memberSince: 0,
    sourceScope: "",
    sourceLabel: "",
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
  const settledVolumeUsdcRaw = Number((Number(entry.settledVolumeUsdc || 0)).toFixed(2));
  const totalTrackedActions = Number(entry.jobsAsClient || 0)
    + Number(entry.jobsAsWorker || 0)
    + Number(entry.campaignsCreated || 0)
    + Number(entry.postsShared || 0)
    + Number(entry.totalCheckIns || 0);
  const lifecycleActions = Number(entry.jobsCompleted || 0) + Number(entry.jobsSettled || 0);

  const activityScore = Math.round(
    (totalTrackedActions * 14)
    + (lifecycleActions * 18)
    + trackedVolumeUsdcRaw
    + settledVolumeUsdcRaw
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
    jobsCompleted: Number(entry.jobsCompleted || 0),
    jobsSettled: Number(entry.jobsSettled || 0),
    campaignsCreated: Number(entry.campaignsCreated || 0),
    postsShared: Number(entry.postsShared || 0),
    postUpvotesEarned: Number(entry.postUpvotesEarned || 0),
    trackedVolumeUsdc: formatUsdc(trackedVolumeUsdcRaw),
    trackedVolumeUsdcRaw,
    settledVolumeUsdc: formatUsdc(settledVolumeUsdcRaw),
    settledVolumeUsdcRaw,
    memberSince: Number(entry.memberSince || 0),
    memberSinceLabel: formatPulseCalendarLabel(entry.memberSince),
    totalTrackedActions,
    lifecycleActions,
    mostUsedLane: resolvePulseLaneLabel(entry.laneCounts, totalTrackedActions > 0 ? "build" : ""),
    mostUsedApp: totalTrackedActions > 0
      ? (entry.sourceScope === "live-contract-indexed" ? "AgentMarket indexed" : "AgentMarket")
      : "Awaiting first signal",
    sourceScope: String(entry.sourceScope || ""),
    sourceLabel: String(entry.sourceLabel || ""),
    activityScore,
  };
}

function describePulseArcIdBadge(summary, topPercent) {
  if (!summary.totalTrackedActions && !summary.points) return "Network Arrival";
  if (topPercent <= 10 || summary.activityScore >= 260) return "Arc Vanguard";
  if (summary.jobsCompleted > 0 && summary.jobsSettled > 0) return "Market Closer";
  if (topPercent <= 30 || summary.activityScore >= 140) return "Pulse Builder";
  if (summary.postsShared > 0 || summary.totalCheckIns > 0) return "Signal Starter";
  return "Fresh Builder";
}

function applyIndexedPulseWalletAnalytics(db, analytics) {
  const rows = getPulseIndexedContractRows(db);
  if (!rows.length) {
    return {
      usedIndexedContractRows: false,
      sourceScope: "tracked-beta",
      sourceLabel: "",
    };
  }

  const jobPostsById = new Map();
  for (const row of rows) {
    if (String(row.event_key || "") === "job_posted") {
      jobPostsById.set(String(row.entity_id || ""), row);
    }
  }

  for (const row of rows) {
    const eventKey = String(row.event_key || "");
    const eventTimestamp = Number(row.block_timestamp || row.created_at || 0);
    const amountUsdc = toUsdcNumber(row.amount_usdc);

    if (eventKey === "job_posted") {
      const clientEntry = ensurePulseWalletActivity(analytics, row.wallet_primary);
      if (clientEntry) {
        clientEntry.jobsAsClient += 1;
        clientEntry.trackedVolumeUsdc += amountUsdc;
        clientEntry.sourceScope = "live-contract-indexed";
        clientEntry.sourceLabel = "Arc RPC event indexer";
        notePulseWalletTimestamp(clientEntry, eventTimestamp);
      }

      if (row.wallet_secondary && !sameAddress(row.wallet_secondary, ZERO_ADDRESS)) {
        const workerEntry = ensurePulseWalletActivity(analytics, row.wallet_secondary);
        if (workerEntry) {
          workerEntry.jobsAsWorker += 1;
          workerEntry.trackedVolumeUsdc += amountUsdc;
          workerEntry.sourceScope = "live-contract-indexed";
          workerEntry.sourceLabel = "Arc RPC event indexer";
          notePulseWalletTimestamp(workerEntry, eventTimestamp);
        }
      }

      continue;
    }

    if (eventKey === "job_claimed") {
      const workerEntry = ensurePulseWalletActivity(analytics, row.wallet_primary);
      if (!workerEntry) continue;
      const postedRow = jobPostsById.get(String(row.entity_id || ""));
      if (postedRow?.wallet_secondary && !sameAddress(postedRow.wallet_secondary, ZERO_ADDRESS)) continue;
      workerEntry.jobsAsWorker += 1;
      workerEntry.trackedVolumeUsdc += toUsdcNumber(postedRow?.amount_usdc || 0);
      workerEntry.sourceScope = "live-contract-indexed";
      workerEntry.sourceLabel = "Arc RPC event indexer";
      notePulseWalletTimestamp(workerEntry, eventTimestamp);
      continue;
    }

    if (eventKey === "job_completed") {
      const workerEntry = ensurePulseWalletActivity(analytics, row.wallet_primary);
      if (workerEntry) {
        workerEntry.jobsCompleted += 1;
        workerEntry.settledVolumeUsdc += amountUsdc;
        workerEntry.sourceScope = "live-contract-indexed";
        workerEntry.sourceLabel = "Arc RPC event indexer";
        notePulseWalletTimestamp(workerEntry, eventTimestamp);
      }

      const postedRow = jobPostsById.get(String(row.entity_id || ""));
      const clientEntry = ensurePulseWalletActivity(analytics, postedRow?.wallet_primary || "");
      if (clientEntry) {
        clientEntry.jobsSettled += 1;
        clientEntry.settledVolumeUsdc += amountUsdc;
        clientEntry.sourceScope = "live-contract-indexed";
        clientEntry.sourceLabel = "Arc RPC event indexer";
        notePulseWalletTimestamp(clientEntry, eventTimestamp);
      }

      continue;
    }

    if (eventKey === "campaign_created") {
      const creatorEntry = ensurePulseWalletActivity(analytics, row.wallet_primary);
      if (!creatorEntry) continue;
      creatorEntry.campaignsCreated += 1;
      creatorEntry.trackedVolumeUsdc += amountUsdc;
      creatorEntry.sourceScope = "live-contract-indexed";
      creatorEntry.sourceLabel = "Arc RPC event indexer";
      notePulseWalletTimestamp(creatorEntry, eventTimestamp);
    }
  }

  return {
    usedIndexedContractRows: true,
    sourceScope: "live-contract-indexed",
    sourceLabel: "Arc RPC event indexer",
  };
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

  const indexedState = applyIndexedPulseWalletAnalytics(db, analytics);
  if (!indexedState.usedIndexedContractRows) {
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

      if (Number(job.status) === 3 && job.agent && !sameAddress(job.agent, ZERO_ADDRESS)) {
        const workerEntry = ensurePulseWalletActivity(analytics, job.agent);
        if (workerEntry) {
          workerEntry.jobsCompleted += 1;
          workerEntry.settledVolumeUsdc += budget;
        }
      }

      if (Number(job.status) === 3 && job.client && !sameAddress(job.client, ZERO_ADDRESS)) {
        const clientEntry = ensurePulseWalletActivity(analytics, job.client);
        if (clientEntry) {
          clientEntry.jobsSettled += 1;
          clientEntry.settledVolumeUsdc += budget;
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
  }

  return {
    analytics,
    usedIndexedContractRows: indexedState.usedIndexedContractRows,
    sourceScope: indexedState.sourceScope,
    sourceLabel: indexedState.sourceLabel,
  };
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

function createArcWalletActivityPayload(wallet, overrides = {}) {
  const canonicalWallet = String(wallet || "").toLowerCase();
  return {
    wallet: canonicalWallet,
    sourceLabel: "Arcscan explorer API",
    updatedAt: 0,
    stale: false,
    truncated: false,
    error: "",
    summary: {
      totalSentTransactions: 0,
      totalWalletTouches: 0,
      contractsDeployed: 0,
      uniqueContractsInteracted: 0,
      activeDays: 0,
      successfulTransactions: 0,
      failedTransactions: 0,
      totalFeesPaidUsdc: "0.00",
      currentBalanceUsdc: "0.00",
      firstActivityAt: 0,
      lastActivityAt: 0,
    },
    details: {
      recentTransactions: [],
      topContracts: [],
      deployments: [],
    },
    ...overrides,
  };
}

function getPulseArcWalletActivityCacheRecord(db, wallet) {
  return db.prepare("SELECT * FROM pulse_arc_wallet_activity_cache WHERE wallet = ?").get(String(wallet || "").toLowerCase()) || null;
}

function getPulseArcWalletActivityCache(db, wallet) {
  const record = getPulseArcWalletActivityCacheRecord(db, wallet);
  if (!record?.payload_json) return null;

  try {
    const payload = JSON.parse(String(record.payload_json || "{}"));
    return createArcWalletActivityPayload(wallet, {
      ...payload,
      updatedAt: Number(record.updated_at || payload?.updatedAt || 0),
    });
  } catch {
    return null;
  }
}

function savePulseArcWalletActivityCache(db, wallet, payload = {}) {
  const canonicalWallet = String(wallet || "").toLowerCase();
  const updatedAt = Number(payload.updatedAt || Date.now());
  const serialized = JSON.stringify({
    ...payload,
    wallet: canonicalWallet,
    updatedAt,
  });

  db.prepare(`
    INSERT INTO pulse_arc_wallet_activity_cache (wallet, payload_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(canonicalWallet, serialized, updatedAt);

  return createArcWalletActivityPayload(canonicalWallet, {
    ...payload,
    updatedAt,
  });
}

function normalizeArcExplorerTimestamp(value) {
  const seconds = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function formatArcExplorerUsdcBaseUnits(value, decimals = 18) {
  try {
    return formatUsdc(formatUnits(BigInt(value || 0n), decimals));
  } catch {
    return "0.00";
  }
}

function isArcExplorerTransactionSuccessful(row = {}) {
  const status = String(row.txreceipt_status || "").trim();
  const isError = String(row.isError || "").trim();
  if (status) return status === "1";
  return isError !== "1";
}

const KNOWN_ARC_METHOD_LABELS = new Map([
  ["0x095ea7b3", "Approve"],
  ["0xa9059cbb", "Transfer"],
  ["0x23b872dd", "Transfer From"],
]);

function humanizeArcMethodLabel(value = "") {
  const raw = String(value || "").trim().replace(/\(.*/, "").replace(/[_-]+/g, " ");
  if (!raw) return "";
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getArcWalletMethodLabel(row = {}, recentMethodMap = null) {
  const recent = recentMethodMap?.get(String(row.hash || "").toLowerCase());
  if (recent) return recent;

  const known = KNOWN_ARC_METHOD_LABELS.get(String(row.methodId || "").toLowerCase());
  if (known) return known;

  const humanized = humanizeArcMethodLabel(row.functionName || "");
  if (humanized) return humanized;

  const methodId = String(row.methodId || "").trim();
  return methodId ? `Method ${methodId.slice(0, 10)}` : "Wallet action";
}

async function fetchArcExplorerJson(url, fallbackMessage) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(ARC_EXPLORER_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`${fallbackMessage} (${response.status})`);
      }

      const data = await response.json();
      return data;
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  throw new Error(lastError?.message || fallbackMessage);
}

async function fetchArcExplorerRecentTransactions(wallet) {
  const url = `${ARC_EXPLORER_API_V2_URL}/addresses/${encodeURIComponent(wallet)}/transactions`;
  const data = await fetchArcExplorerJson(url, "Could not load recent Arc wallet activity");
  return Array.isArray(data?.items) ? data.items : [];
}

async function fetchArcExplorerTransactionHistory(wallet) {
  const rows = [];
  let truncated = false;

  for (let page = 1; page <= ARC_WALLET_ACTIVITY_MAX_PAGES; page += 1) {
    const url = new URL(ARC_EXPLORER_API_URL);
    url.searchParams.set("module", "account");
    url.searchParams.set("action", "txlist");
    url.searchParams.set("address", wallet);
    url.searchParams.set("page", String(page));
    url.searchParams.set("offset", String(ARC_WALLET_ACTIVITY_TX_PAGE_SIZE));
    url.searchParams.set("sort", "desc");

    const data = await fetchArcExplorerJson(url, "Could not load Arc wallet transactions");
    if (Array.isArray(data?.result)) {
      rows.push(...data.result);
      if (data.result.length < ARC_WALLET_ACTIVITY_TX_PAGE_SIZE) break;
      if (page === ARC_WALLET_ACTIVITY_MAX_PAGES) truncated = true;
      continue;
    }

    const resultText = String(data?.result || "").trim();
    if (!resultText || /no transactions found/i.test(resultText)) break;
    throw new Error(resultText || data?.message || "Could not load Arc wallet transactions");
  }

  return { rows, truncated };
}

function buildArcWalletActivity(wallet, txRows = [], recentRows = [], balanceBaseUnits = 0n, truncated = false, sentTransactionCount = 0) {
  const canonicalWallet = String(wallet || "").toLowerCase();
  const normalizedRows = Array.isArray(txRows) ? txRows : [];
  const recentMethodMap = new Map(
    (Array.isArray(recentRows) ? recentRows : []).map(item => [
      String(item?.hash || "").toLowerCase(),
      humanizeArcMethodLabel(item?.method || ""),
    ]),
  );

  const sentRows = normalizedRows.filter(row => sameAddress(row.from, canonicalWallet));
  const activeDays = new Set();
  const contractUsage = new Map();
  let firstActivityAt = 0;
  let lastActivityAt = 0;
  let successfulTransactions = 0;
  let failedTransactions = 0;
  let totalFeesBaseUnits = 0n;

  for (const row of sentRows) {
    const timestamp = normalizeArcExplorerTimestamp(row.timeStamp);
    if (timestamp > 0) {
      activeDays.add(utcDayKey(timestamp));
      if (!firstActivityAt || timestamp < firstActivityAt) firstActivityAt = timestamp;
      if (!lastActivityAt || timestamp > lastActivityAt) lastActivityAt = timestamp;
    }

    if (isArcExplorerTransactionSuccessful(row)) successfulTransactions += 1;
    else failedTransactions += 1;

    try {
      totalFeesBaseUnits += BigInt(row.gasPrice || 0) * BigInt(row.gasUsed || 0);
    } catch {}

    const target = String(row.to || "").toLowerCase();
    if (isHexAddress(target) && !sameAddress(target, ZERO_ADDRESS)) {
      const current = contractUsage.get(target) || { address: target, transactions: 0, lastActivityAt: 0 };
      current.transactions += 1;
      if (timestamp > current.lastActivityAt) current.lastActivityAt = timestamp;
      contractUsage.set(target, current);
    }
  }

  const deployments = sentRows
    .filter(row => isHexAddress(row.contractAddress))
    .map(row => ({
      address: String(row.contractAddress || "").toLowerCase(),
      label: shortWallet(String(row.contractAddress || "").toLowerCase()),
      txHash: String(row.hash || ""),
      txUrl: row.hash ? `${ARC_EXPLORER_URL}/tx/${row.hash}` : "",
      addressUrl: row.contractAddress ? `${ARC_EXPLORER_URL}/address/${row.contractAddress}` : "",
      timestamp: normalizeArcExplorerTimestamp(row.timeStamp),
    }))
    .slice(0, ARC_WALLET_ACTIVITY_DEPLOYMENT_LIMIT);

  const topContracts = [...contractUsage.values()]
    .sort((a, b) => b.transactions - a.transactions || b.lastActivityAt - a.lastActivityAt || a.address.localeCompare(b.address))
    .slice(0, ARC_WALLET_ACTIVITY_TOP_CONTRACT_LIMIT)
    .map(item => ({
      address: item.address,
      label: shortWallet(item.address),
      txCount: item.transactions,
      lastActivityAt: item.lastActivityAt,
      addressUrl: `${ARC_EXPLORER_URL}/address/${item.address}`,
    }));

  const recentTransactions = sentRows.slice(0, ARC_WALLET_ACTIVITY_RECENT_LIMIT).map(row => {
    const createdContract = isHexAddress(row.contractAddress) ? String(row.contractAddress).toLowerCase() : "";
    const targetAddress = isHexAddress(row.to) ? String(row.to).toLowerCase() : "";
    let feeUsdc = "0.00";
    try {
      feeUsdc = formatArcExplorerUsdcBaseUnits(BigInt(row.gasPrice || 0) * BigInt(row.gasUsed || 0));
    } catch {}

    return {
      hash: String(row.hash || ""),
      txUrl: row.hash ? `${ARC_EXPLORER_URL}/tx/${row.hash}` : "",
      timestamp: normalizeArcExplorerTimestamp(row.timeStamp),
      methodLabel: getArcWalletMethodLabel(row, recentMethodMap),
      success: isArcExplorerTransactionSuccessful(row),
      feeUsdc,
      targetAddress,
      targetLabel: createdContract ? "Contract deployment" : (targetAddress ? shortWallet(targetAddress) : "Unknown target"),
      targetUrl: targetAddress ? `${ARC_EXPLORER_URL}/address/${targetAddress}` : "",
      createdContract,
      createdContractLabel: createdContract ? shortWallet(createdContract) : "",
      createdContractUrl: createdContract ? `${ARC_EXPLORER_URL}/address/${createdContract}` : "",
    };
  });

  return createArcWalletActivityPayload(canonicalWallet, {
    updatedAt: Date.now(),
    truncated,
    summary: {
      totalSentTransactions: Math.max(sentRows.length, Number(sentTransactionCount || 0)),
      totalWalletTouches: normalizedRows.length,
      contractsDeployed: deployments.length
        + Math.max(0, sentRows.filter(row => isHexAddress(row.contractAddress)).length - deployments.length),
      uniqueContractsInteracted: contractUsage.size,
      activeDays: activeDays.size,
      successfulTransactions,
      failedTransactions,
      totalFeesPaidUsdc: formatArcExplorerUsdcBaseUnits(totalFeesBaseUnits),
      currentBalanceUsdc: formatArcExplorerUsdcBaseUnits(balanceBaseUnits),
      firstActivityAt,
      lastActivityAt,
    },
    details: {
      recentTransactions,
      topContracts,
      deployments,
    },
  });
}

async function fetchFreshArcWalletActivity(db, wallet) {
  const canonicalWallet = String(wallet || "").toLowerCase();
  const [history, recentRows, balanceBaseUnits, sentTransactionCount] = await Promise.all([
    fetchArcExplorerTransactionHistory(canonicalWallet),
    fetchArcExplorerRecentTransactions(canonicalWallet).catch(() => []),
    publicClient.getBalance({ address: canonicalWallet }),
    publicClient.getTransactionCount({ address: canonicalWallet }),
  ]);

  const payload = buildArcWalletActivity(
    canonicalWallet,
    history.rows,
    recentRows,
    balanceBaseUnits,
    history.truncated,
    Number(sentTransactionCount || 0),
  );

  return savePulseArcWalletActivityCache(db, canonicalWallet, payload);
}

async function getArcWalletActivity(db, wallet) {
  const canonicalWallet = String(wallet || "").toLowerCase();
  const cached = getPulseArcWalletActivityCache(db, canonicalWallet);
  const now = Date.now();

  if (cached && ARC_WALLET_ACTIVITY_CACHE_MS > 0 && (now - Number(cached.updatedAt || 0)) < ARC_WALLET_ACTIVITY_CACHE_MS) {
    return cached;
  }

  try {
    return await fetchFreshArcWalletActivity(db, canonicalWallet);
  } catch (err) {
    if (cached) {
      return createArcWalletActivityPayload(canonicalWallet, {
        ...cached,
        stale: true,
        error: err.message || "Could not refresh Arc wallet activity",
      });
    }

    let currentBalanceUsdc = "0.00";
    try {
      const balance = await publicClient.getBalance({ address: canonicalWallet });
      currentBalanceUsdc = formatArcExplorerUsdcBaseUnits(balance);
    } catch {}

    return createArcWalletActivityPayload(canonicalWallet, {
      stale: true,
      error: err.message || "Could not load Arc wallet activity",
      summary: {
        totalSentTransactions: 0,
        totalWalletTouches: 0,
        contractsDeployed: 0,
        uniqueContractsInteracted: 0,
        activeDays: 0,
        successfulTransactions: 0,
        failedTransactions: 0,
        totalFeesPaidUsdc: "0.00",
        currentBalanceUsdc,
        firstActivityAt: 0,
        lastActivityAt: 0,
      },
    });
  }
}

async function buildPulseArcIdProfile(db, wallet, jobs = [], campaigns = []) {
  const canonicalWallet = String(wallet || "").toLowerCase();
  const walletAnalytics = buildPulseWalletAnalytics(db, jobs, campaigns);
  const analyticsMap = walletAnalytics.analytics;
  const entry = analyticsMap.get(canonicalWallet) || createPulseWalletActivity(canonicalWallet);
  if (walletAnalytics.sourceScope) entry.sourceScope = walletAnalytics.sourceScope;
  if (walletAnalytics.sourceLabel) entry.sourceLabel = walletAnalytics.sourceLabel;
  const summary = formatPulseWalletActivity(entry);
  const unlockRecord = getPulseArcIdUnlockRecord(db, canonicalWallet);
  const unlockConfig = getArcIdUnlockConfig();
  const nftConfig = getArcIdNftConfig();
  const nftMintRecord = getPulseArcIdNftMintRecord(db, canonicalWallet);
  const onchainNftState = await getArcIdNftOnchainState(canonicalWallet);
  const unlockMode = unlockRecord?.tx_hash ? "paid-usdc" : (unlockRecord ? "beta-free" : "locked");
  const arcWalletActivity = await getArcWalletActivity(db, canonicalWallet);
  const activityDetailsUnlocked = unlockMode === "paid-usdc";
  const indexedArcId = Boolean(walletAnalytics.usedIndexedContractRows);
  const arcIdScope = indexedArcId ? "indexed-live" : "tracked-beta";
  const arcIdSourceLabel = walletAnalytics.sourceLabel || (indexedArcId ? "Arc RPC event indexer" : "Tracked contract reads");

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
    scope: arcIdScope,
    sourceLabel: arcIdSourceLabel,
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
      txUrl: unlockRecord?.tx_hash ? `${ARC_EXPLORER_URL}/tx/${unlockRecord.tx_hash}` : "",
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
      txUrl: nftTxHash ? `${ARC_EXPLORER_URL}/tx/${nftTxHash}` : "",
      mintedAt: nftMintedAt,
      contractUrl: nftConfig.contractAddress ? `${ARC_EXPLORER_URL}/address/${nftConfig.contractAddress}` : "",
      error: onchainNftState?.error || "",
    },
    arcActivity: {
      ...arcWalletActivity,
      detailsUnlocked: activityDetailsUnlocked,
      details: activityDetailsUnlocked ? arcWalletActivity.details : null,
    },
    identityRegistryUrl: `${ARC_EXPLORER_URL}/address/${IDENTITY_REGISTRY}`,
    reputationRegistryUrl: `${ARC_EXPLORER_URL}/address/${REPUTATION_REGISTRY}`,
    badge,
    rank: {
      position: rankPosition,
      total: totalRanked,
      topPercent,
      label: totalRanked > 1
        ? `Top ${topPercent}% ${indexedArcId ? "indexed builder" : "builder"}`
        : (indexedArcId ? "Indexed founding builder" : "Founding builder"),
    },
    teaser: {
      points: summary.points,
      trackedActions: summary.totalTrackedActions,
      trackedVolumeUsdc: summary.trackedVolumeUsdc,
      settledVolumeUsdc: summary.settledVolumeUsdc,
      currentStreak: summary.currentStreak,
    },
    profile: summary,
    notes: [
      indexedArcId
        ? `Arc ID now ranks this wallet from indexed AgentMarket activity through ${arcIdSourceLabel}.`
        : "Arc ID beta is based on tracked AgentMarket and ArcPulse activity right now.",
      unlockConfig.enabled
        ? `A ${ARC_ID_UNLOCK_PRICE_USDC} USDC transfer on Arc now unlocks and verifies this card, plus the deeper Arc wallet activity details.`
        : "Configure an Arc ID unlock recipient on the server to turn the paid unlock live.",
      nftConfig.enabled
        ? `Season 1 Arc ID NFT minting is live at ${ARC_ID_NFT_MINT_PRICE_USDC} USDC after a paid unlock.`
        : "Deploy and configure the Arc ID NFT contract to turn the collectible mint live.",
      indexedArcId
        ? "Wallet ranking now blends indexed jobs, claims, completions, settlement volume, Pulse streaks, and community activity."
        : "Arc ID still uses tracked AgentMarket and Pulse activity until indexed wallet-level stats are attached.",
      arcWalletActivity.error
        ? `Arc wallet activity is currently serving a limited view: ${arcWalletActivity.error}`
        : `Arc wallet activity summary is powered by ${arcWalletActivity.sourceLabel}.`,
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

  const trackedOverview = {
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
  };

  const pulseIndexer = await getPulseIndexerSnapshot(pulseDb, trackedOverview);

  return {
    generatedAt: Date.now(),
    mode: pulseIndexer.connected ? "hybrid-indexed" : pulseIndexer.syncing ? "hybrid-warming" : "hybrid-beta",
    indexer: {
      configured: pulseIndexer.configured,
      connected: pulseIndexer.connected,
      syncing: pulseIndexer.syncing,
      bootstrapped: pulseIndexer.bootstrapped,
      sourceLabel: pulseIndexer.sourceLabel,
      scope: pulseIndexer.scope,
      generatedAt: pulseIndexer.generatedAt,
      syncStartedAt: pulseIndexer.syncStartedAt,
      syncCompletedAt: pulseIndexer.syncCompletedAt,
      syncDurationMs: pulseIndexer.syncDurationMs,
      syncedBlock: pulseIndexer.syncedBlock,
      targetBlock: pulseIndexer.targetBlock,
      error: pulseIndexer.error,
    },
    overview: pulseIndexer.overview,
    recentBlocks,
    volume14d: pulseIndexer.volume14d.length ? pulseIndexer.volume14d : buildPulseSeries(jobs),
    categoryBreakdown: pulseIndexer.categoryBreakdown.length
      ? pulseIndexer.categoryBreakdown
      : buildCategoryBreakdown(activeJobs),
    appRankings: buildPulseAppRankings(buildTrackedAppRankings(jobs, campaigns), pulseIndexer.appRankings),
    notes: buildPulseOverviewNotes(pulseIndexer),
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
const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === __filename);

if (isDirectRun) {
  app.listen(PORT, () => {
    console.log(`AgentMarket API running on port ${PORT}`);
    console.log(`Network: Arc Testnet`);
    console.log(`Contract: ${JOB_BOARD_ADDRESS}`);
    startPulseContractIndexerLoop();
  });
}

export default app;
