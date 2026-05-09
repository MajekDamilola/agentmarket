import express from "express";
import cors from "cors";
import { createPublicClient, http, formatUnits, parseAbiItem, parseEventLogs, keccak256, toBytes } from "viem";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import dotenv from "dotenv";
import { promises as fs } from "fs";
import { randomUUID } from "node:crypto";
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

function parseEnvBool(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
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
const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ARC_EXPLORER_URL = "https://testnet.arcscan.app";
const ARC_EXPLORER_API_URL = `${ARC_EXPLORER_URL}/api`;
const ARC_EXPLORER_API_V2_URL = `${ARC_EXPLORER_URL}/api/v2`;
const ARC_BLOCKCHAIN_ID = "ARC-TESTNET";
const DAY_MS = 24 * 60 * 60 * 1000;
const PULSE_RECENT_BLOCK_LIMIT = 6;
const PULSE_SERIES_DAYS = 14;
const PULSE_FEED_LIMIT = 250;
const PULSE_LEADERBOARD_LIMIT = 10;
const PULSE_LANES = new Set(["build", "thread", "art"]);
const PULSE_INDEXER_EVENT_CHUNK_SIZE = 10_000n;
const PULSE_INDEXER_SYNC_INTERVAL_MS = 30_000;
const PULSE_INDEXER_CONFIRMATION_BLOCKS = 2n;
const PULSE_INDEXER_SCHEMA_VERSION = "3";
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
const PULSE_INDEXER_EXTRA_CONTRACTS_JSON = String(process.env.PULSE_INDEXER_EXTRA_CONTRACTS_JSON || "").trim();
const CIRCLE_API_KEY = String(process.env.CIRCLE_API_KEY || "").trim();
const CIRCLE_ENTITY_SECRET = String(process.env.CIRCLE_ENTITY_SECRET || "").trim();
const CIRCLE_BASE_URL = String(process.env.CIRCLE_BASE_URL || "").trim();
const SUMMARY_AGENT_ENABLED = parseEnvBool(process.env.SUMMARY_AGENT_ENABLED, true);
const SUMMARY_AGENT_MODEL = String(process.env.SUMMARY_AGENT_MODEL || "gpt-5.2").trim();
const SUMMARY_AGENT_OPENAI_API_KEY = String(
  process.env.OPENAI_API_KEY
  || process.env.SUMMARY_AGENT_OPENAI_API_KEY
  || "",
).trim();
const SUMMARY_AGENT_OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim();
const SUMMARY_AGENT_LOOP_MS = Math.max(10_000, parseEnvInt(process.env.SUMMARY_AGENT_LOOP_MS, 20_000));
const SUMMARY_AGENT_MAX_BUDGET_USDC = Math.max(0.5, Number.parseFloat(String(process.env.SUMMARY_AGENT_MAX_BUDGET_USDC || "10").trim()) || 10);
const SUMMARY_AGENT_MAX_CONCURRENT_JOBS = Math.max(1, parseEnvInt(process.env.SUMMARY_AGENT_MAX_CONCURRENT_JOBS, 2));
const SUMMARY_AGENT_MAX_SOURCE_URLS = Math.max(0, parseEnvInt(process.env.SUMMARY_AGENT_MAX_SOURCE_URLS, 2));
const SUMMARY_AGENT_AUTO_BOOTSTRAP = parseEnvBool(process.env.SUMMARY_AGENT_AUTO_BOOTSTRAP, true);
const SUMMARY_AGENT_AUTO_VALIDATE = parseEnvBool(process.env.SUMMARY_AGENT_AUTO_VALIDATE, true);
const SUMMARY_AGENT_ALLOW_OPEN_CLAIMS = parseEnvBool(process.env.SUMMARY_AGENT_ALLOW_OPEN_CLAIMS, true);
const AGENTMARKET_PUBLIC_API_BASE_URL = String(
  process.env.AGENTMARKET_PUBLIC_API_BASE_URL
  || process.env.PUBLIC_API_BASE_URL
  || "",
).trim();
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

function withTrailingSlashRemoved(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

function resolvePublicApiBaseUrl() {
  if (AGENTMARKET_PUBLIC_API_BASE_URL) return withTrailingSlashRemoved(AGENTMARKET_PUBLIC_API_BASE_URL);
  if (process.env.VERCEL_URL) return `https://${String(process.env.VERCEL_URL).trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return "";
}

function getCircleDeveloperWalletClient() {
  if (!CIRCLE_API_KEY || !CIRCLE_ENTITY_SECRET) return null;
  if (!circleDeveloperWalletClient) {
    const config = {
      apiKey: CIRCLE_API_KEY,
      entitySecret: CIRCLE_ENTITY_SECRET,
    };
    if (CIRCLE_BASE_URL) config.baseUrl = CIRCLE_BASE_URL;
    circleDeveloperWalletClient = initiateDeveloperControlledWalletsClient(config);
  }
  return circleDeveloperWalletClient;
}

function isCircleDeveloperWalletReady() {
  return Boolean(getCircleDeveloperWalletClient());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncateAgentText(text = "", maxLength = 16000) {
  const normalized = String(text || "").replace(/\0/g, "").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 20).trim()}\n\n[Truncated]`;
}

function escapeAgentHtml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtmlToText(value = "") {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUrlsFromText(value = "") {
  const matches = String(value || "").match(/https?:\/\/[^\s)]+/gi) || [];
  return [...new Set(matches.map(item => item.replace(/[.,;!?]+$/, "")))];
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

function slugifyPulseIndexerText(value = "", fallback = "pulse-app") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function parsePulseIndexerStartBlockValue(value, fallback = 0n) {
  if (typeof value === "bigint") return value >= 0n ? value : fallback;
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) return fallback;
  try {
    const parsed = BigInt(text);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function createDefaultPulseIndexerLiveContract(latestBlock = 0n) {
  const hasKnownStartBlock = KNOWN_PULSE_INDEXER_JOB_BOARD_START_BLOCKS.has(JOB_BOARD_ADDRESS.toLowerCase());
  return {
    address: JOB_BOARD_ADDRESS,
    addressLower: JOB_BOARD_ADDRESS.toLowerCase(),
    id: "agentmarket",
    name: "AgentMarket",
    category: "AI / Work",
    description: "Live event-indexed view built from the configured AgentMarket-style Arc contracts.",
    contractLabel: "AgentMarket job board",
    chainLabel: "Arc Testnet",
    startBlock: getPulseIndexerJobBoardStartBlock(latestBlock),
    startBlockLocked: PULSE_INDEXER_JOB_BOARD_START_BLOCK > 0 || hasKnownStartBlock,
  };
}

function normalizePulseIndexerLiveContract(input = {}, fallback = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const address = resolveOptionalAddress(
    input.address,
    input.contractAddress,
    input.contract,
    fallback.address,
  );
  if (!address) return null;

  const name = String(input.name || input.appName || fallback.name || "Arc app").trim() || "Arc app";
  const id = slugifyPulseIndexerText(
    input.id || input.appId || name || fallback.id || address.slice(2, 8),
    fallback.id || "pulse-app",
  );
  const category = String(input.category || fallback.category || "Arc App").trim() || "Arc App";
  const description = String(
    input.description
    || fallback.description
    || `Live event-indexed view built from the configured ${name} Arc contracts.`,
  ).trim();
  const contractLabel = String(
    input.contractLabel
    || input.label
    || fallback.contractLabel
    || `${name} contract`,
  ).trim() || `${name} contract`;
  const chainLabel = String(input.chainLabel || fallback.chainLabel || "Arc Testnet").trim() || "Arc Testnet";
  const fallbackStartBlock = parsePulseIndexerStartBlockValue(fallback.startBlock, 0n);
  const hasExplicitStartBlock = input.startBlock !== undefined && input.startBlock !== null && String(input.startBlock).trim() !== "";
  const startBlock = parsePulseIndexerStartBlockValue(input.startBlock, fallbackStartBlock);

  return {
    address,
    addressLower: address.toLowerCase(),
    id,
    name,
    category,
    description,
    contractLabel,
    chainLabel,
    startBlock,
    startBlockLocked: hasExplicitStartBlock || Boolean(fallback.startBlockLocked),
  };
}

function parsePulseIndexerExtraContracts(latestBlock = 0n) {
  if (!PULSE_INDEXER_EXTRA_CONTRACTS_JSON) return [];

  try {
    const parsed = JSON.parse(PULSE_INDEXER_EXTRA_CONTRACTS_JSON);
    const items = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.contracts) ? parsed.contracts : []);
    return items
      .map(item => normalizePulseIndexerLiveContract(item, { startBlock: 0n }))
      .filter(Boolean);
  } catch (err) {
    console.warn("Could not parse PULSE_INDEXER_EXTRA_CONTRACTS_JSON:", err.message || err);
    return [];
  }
}

function getPulseIndexerLiveContracts(latestBlock = 0n) {
  const merged = new Map();
  const defaults = [createDefaultPulseIndexerLiveContract(latestBlock)];

  for (const item of [...defaults, ...parsePulseIndexerExtraContracts(latestBlock)]) {
    if (!item?.addressLower) continue;
    const existing = merged.get(item.addressLower);
    merged.set(item.addressLower, existing ? {
      ...existing,
      ...item,
      startBlock: parsePulseIndexerStartBlockValue(item.startBlock, existing.startBlock),
      startBlockLocked: Boolean(item.startBlockLocked || existing.startBlockLocked),
    } : item);
  }

  return [...merged.values()];
}

function getPulseIndexerLiveContractMap(latestBlock = 0n) {
  const map = new Map();
  for (const item of getPulseIndexerLiveContracts(latestBlock)) {
    map.set(item.addressLower, item);
  }
  return map;
}

function getPulseIndexerConfiguredStartBlock(latestBlock = 0n, liveContracts = null) {
  const contracts = Array.isArray(liveContracts) && liveContracts.length
    ? liveContracts
    : getPulseIndexerLiveContracts(latestBlock);
  if (!contracts.length) return 0n;

  return contracts.reduce((winner, item) => {
    const startBlock = parsePulseIndexerStartBlockValue(item.startBlock, 0n);
    return winner === null || startBlock < winner ? startBlock : winner;
  }, null) ?? 0n;
}

function getPulseIndexerConfigFingerprint(liveContracts = null) {
  const contracts = Array.isArray(liveContracts) ? liveContracts : getPulseIndexerLiveContracts();
  return JSON.stringify(contracts
    .map(item => ({
      address: item.addressLower,
      id: item.id,
      name: item.name,
      contractLabel: item.contractLabel,
      startBlock: item.startBlockLocked ? parsePulseIndexerStartBlockValue(item.startBlock, 0n).toString() : "",
    }))
    .sort((a, b) => a.address.localeCompare(b.address)));
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
const AGENT_KEYS = {
  summary: "summarybot",
};
const AGENT_WALLET_ROLES = {
  owner: "owner",
  validator: "validator",
};
const AGENT_RUN_STATUSES = {
  pending: "pending",
  claiming: "claiming",
  claimed: "claimed",
  running: "running",
  submitting: "submitting",
  submitted: "submitted",
  completed: "completed",
  failed: "failed",
};
const AGENT_ACTIVE_EXECUTION_STATUSES = new Set([
  AGENT_RUN_STATUSES.pending,
  AGENT_RUN_STATUSES.claiming,
  AGENT_RUN_STATUSES.claimed,
  AGENT_RUN_STATUSES.running,
  AGENT_RUN_STATUSES.submitting,
]);
let circleDeveloperWalletClient = null;
let summaryAgentLoopTimer = null;
let summaryAgentLoopPromise = null;
let summaryAgentLastCycleAt = 0;
const summaryAgentRuntime = {
  bootstrapped: false,
  running: false,
  lastStartedAt: 0,
  lastCompletedAt: 0,
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

function extractOpenAiResponseText(payload = {}) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];
  for (const item of output) {
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function buildSummaryBotMetadata(db) {
  const ownerWallet = getAgentWallet(db, AGENT_KEYS.summary, AGENT_WALLET_ROLES.owner);
  return {
    name: "SummaryBot",
    description: "Autonomous Arc-native summarization and research agent for AgentMarket jobs.",
    image: "",
    agent_type: "summarization",
    capabilities: [
      "job_selection",
      "public_link_reading",
      "document_summarization",
      "structured_report_generation",
      "automated_job_delivery",
    ],
    version: "1.0.0",
    operator: ownerWallet?.walletAddress || "",
    scope: {
      workerTypes: ["AI"],
      categories: ["Research", "Writing", "Analysis", "Operations"],
      maxBudgetUsdc: SUMMARY_AGENT_MAX_BUDGET_USDC,
      sourceTypes: ["inline text", "public urls"],
    },
  };
}

function getSummaryBotMetadataUri() {
  const base = resolvePublicApiBaseUrl();
  return base ? `${base}/api/agents/${AGENT_KEYS.summary}/metadata` : "";
}

function getSummaryBotDeliverableLocator(jobId, runId) {
  const base = resolvePublicApiBaseUrl();
  return base ? `${base}/api/agents/${AGENT_KEYS.summary}/jobs/${Number(jobId)}/deliverable?run=${encodeURIComponent(String(runId || ""))}` : "";
}

function getSummaryBotMissingConfig(db) {
  const missing = [];
  if (!CIRCLE_API_KEY) missing.push("CIRCLE_API_KEY");
  if (!CIRCLE_ENTITY_SECRET) missing.push("CIRCLE_ENTITY_SECRET");
  if (!SUMMARY_AGENT_OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!resolvePublicApiBaseUrl()) missing.push("AGENTMARKET_PUBLIC_API_BASE_URL");
  const ownerWallet = getAgentWallet(db, AGENT_KEYS.summary, AGENT_WALLET_ROLES.owner);
  const validatorWallet = getAgentWallet(db, AGENT_KEYS.summary, AGENT_WALLET_ROLES.validator);
  if (!ownerWallet?.walletId) missing.push("summarybot owner wallet");
  if (!validatorWallet?.walletId) missing.push("summarybot validator wallet");
  return missing;
}

async function waitForCircleDeveloperTransaction(client, transactionId, {
  timeoutMs = 120_000,
  pollMs = 2_500,
} = {}) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const response = await client.getTransaction({ id: transactionId });
    const transaction = response?.data?.transaction || null;
    const state = String(transaction?.state || "").toUpperCase();
    if (state === "COMPLETE") return transaction;
    if (state === "FAILED" || state === "CANCELLED" || state === "DENIED") {
      throw new Error(transaction?.errorReason || transaction?.state || "Circle transaction failed");
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for Circle transaction ${transactionId}`);
}

async function ensureSummaryAgentWallets(db) {
  const client = getCircleDeveloperWalletClient();
  if (!client) throw new Error("Circle developer-controlled wallets are not configured");

  const existingOwner = getAgentWallet(db, AGENT_KEYS.summary, AGENT_WALLET_ROLES.owner);
  const existingValidator = getAgentWallet(db, AGENT_KEYS.summary, AGENT_WALLET_ROLES.validator);
  if (existingOwner?.walletId && existingValidator?.walletId) {
    return {
      ownerWallet: existingOwner,
      validatorWallet: existingValidator,
    };
  }

  const existingWalletSetId = existingOwner?.walletSetId || existingValidator?.walletSetId || "";
  let walletSetId = existingWalletSetId;
  if (!walletSetId) {
    const walletSetResponse = await client.createWalletSet({
      name: "AgentMarket SummaryBot Wallets",
      idempotencyKey: `agentmarket-summarybot-walletset-v1`,
    });
    walletSetId = String(walletSetResponse?.data?.walletSet?.id || "");
  }
  if (!walletSetId) throw new Error("Circle did not return a wallet set id");

  const createResponse = await client.createWallets({
    blockchains: [ARC_BLOCKCHAIN_ID],
    count: 2,
    walletSetId,
    accountType: "SCA",
    metadata: [
      { name: "SummaryBot Owner", refId: `${AGENT_KEYS.summary}-${AGENT_WALLET_ROLES.owner}` },
      { name: "SummaryBot Validator", refId: `${AGENT_KEYS.summary}-${AGENT_WALLET_ROLES.validator}` },
    ],
    idempotencyKey: `agentmarket-summarybot-wallets-v1`,
  });
  const wallets = Array.isArray(createResponse?.data?.wallets) ? createResponse.data.wallets : [];
  const [ownerRaw, validatorRaw] = wallets;
  if (!ownerRaw?.id || !ownerRaw?.address || !validatorRaw?.id || !validatorRaw?.address) {
    throw new Error("Circle did not return both SummaryBot wallets");
  }

  const ownerWallet = saveAgentWallet(db, AGENT_KEYS.summary, AGENT_WALLET_ROLES.owner, {
    walletSetId,
    walletId: ownerRaw.id,
    walletAddress: ownerRaw.address,
    blockchain: ownerRaw.blockchain || ARC_BLOCKCHAIN_ID,
    accountType: ownerRaw.accountType || "SCA",
  });
  const validatorWallet = saveAgentWallet(db, AGENT_KEYS.summary, AGENT_WALLET_ROLES.validator, {
    walletSetId,
    walletId: validatorRaw.id,
    walletAddress: validatorRaw.address,
    blockchain: validatorRaw.blockchain || ARC_BLOCKCHAIN_ID,
    accountType: validatorRaw.accountType || "SCA",
  });

  return { ownerWallet, validatorWallet };
}

async function resolveIdentityTokenIdByOwner(ownerAddress) {
  const latestBlock = await publicClient.getBlockNumber();
  const blockRange = 10_000n;
  const fromBlock = latestBlock > blockRange ? latestBlock - blockRange : 0n;
  const logs = await publicClient.getLogs({
    address: IDENTITY_REGISTRY,
    event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"),
    args: { to: ownerAddress },
    fromBlock,
    toBlock: latestBlock,
  });
  if (!logs.length) return "";
  return String(logs[logs.length - 1]?.args?.tokenId || "");
}

async function ensureSummaryAgentIdentityRegistration(db) {
  const client = getCircleDeveloperWalletClient();
  if (!client) throw new Error("Circle developer-controlled wallets are not configured");

  const registration = getAgentRegistration(db, AGENT_KEYS.summary);
  if (registration?.identityTokenId) return registration;

  const { ownerWallet } = await ensureSummaryAgentWallets(db);
  const metadataUri = getSummaryBotMetadataUri();
  if (!metadataUri) {
    throw new Error("Set AGENTMARKET_PUBLIC_API_BASE_URL so SummaryBot metadata can be registered onchain");
  }

  const identityTx = await client.createContractExecutionTransaction({
    walletId: ownerWallet.walletId,
    contractAddress: IDENTITY_REGISTRY,
    abiFunctionSignature: "register(string)",
    abiParameters: [metadataUri],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: `agentmarket-summarybot-register-v1`,
  });
  const txId = String(identityTx?.data?.id || "");
  const transaction = await waitForCircleDeveloperTransaction(client, txId);
  const tokenId = await resolveIdentityTokenIdByOwner(ownerWallet.walletAddress);
  if (!tokenId) {
    throw new Error("SummaryBot identity registration completed, but no ERC-8004 token id was found");
  }

  return saveAgentRegistration(db, AGENT_KEYS.summary, {
    metadataUri,
    metadata: buildSummaryBotMetadata(db),
    identityTokenId: tokenId,
    identityTxId: txId,
    identityTxHash: String(transaction?.txHash || ""),
    registeredAt: Date.now(),
  });
}

async function ensureSummaryAgentValidation(db) {
  const client = getCircleDeveloperWalletClient();
  if (!client) throw new Error("Circle developer-controlled wallets are not configured");

  const registration = await ensureSummaryAgentIdentityRegistration(db);
  if (registration?.validationStatus === 100) return registration;

  const { ownerWallet, validatorWallet } = await ensureSummaryAgentWallets(db);
  const tokenId = registration?.identityTokenId;
  if (!tokenId) throw new Error("SummaryBot identity token id is required before validation");

  const metadataUri = getSummaryBotMetadataUri();
  const requestHash = registration?.validationRequestHash || keccak256(toBytes(`summarybot_validation_request_${tokenId}`));
  const requestTx = await client.createContractExecutionTransaction({
    walletId: ownerWallet.walletId,
    contractAddress: VALIDATION_REGISTRY,
    abiFunctionSignature: "validationRequest(address,uint256,string,bytes32)",
    abiParameters: [validatorWallet.walletAddress, tokenId, metadataUri, requestHash],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: `agentmarket-summarybot-validation-request-v1`,
  });
  const requestTxId = String(requestTx?.data?.id || "");
  const requestTransaction = await waitForCircleDeveloperTransaction(client, requestTxId);

  const responseTx = await client.createContractExecutionTransaction({
    walletId: validatorWallet.walletId,
    contractAddress: VALIDATION_REGISTRY,
    abiFunctionSignature: "validationResponse(bytes32,uint8,string,bytes32,string)",
    abiParameters: [requestHash, 100, metadataUri, `0x${"0".repeat(64)}`, "platform_verified"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: `agentmarket-summarybot-validation-response-v1`,
  });
  const responseTxId = String(responseTx?.data?.id || "");
  const responseTransaction = await waitForCircleDeveloperTransaction(client, responseTxId);

  return saveAgentRegistration(db, AGENT_KEYS.summary, {
    metadataUri,
    metadata: buildSummaryBotMetadata(db),
    validationRequestHash: requestHash,
    validationRequestTxId: requestTxId,
    validationRequestTxHash: String(requestTransaction?.txHash || ""),
    validationResponseTxId: responseTxId,
    validationResponseTxHash: String(responseTransaction?.txHash || ""),
    validationStatus: 100,
    validationTag: "platform_verified",
    validatedAt: Date.now(),
  });
}

function isSummaryBotSupportedJob(job = {}) {
  if (!SUMMARY_AGENT_ENABLED) return false;
  if (Number(job.workerType) !== 0) return false;
  if (job.isExpired) return false;
  if (![0, 1].includes(Number(job.status))) return false;
  if (toUsdcNumber(job.budget) > SUMMARY_AGENT_MAX_BUDGET_USDC) return false;

  const signals = [
    String(job.title || ""),
    String(job.description || ""),
    String(job.category || ""),
    String(job.taskType || ""),
  ].join(" ").toLowerCase();

  return [
    "summar",
    "summary",
    "analy",
    "research",
    "report",
    "brief",
    "notes",
  ].some(token => signals.includes(token));
}

async function fetchSummarySourceFromUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "AgentMarket SummaryBot/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`Source request failed with status ${response.status}`);
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!(contentType.includes("text/") || contentType.includes("json") || contentType.includes("html"))) {
      throw new Error(`Unsupported source content type ${contentType || "unknown"}`);
    }
    const raw = await response.text();
    const text = contentType.includes("html") ? stripHtmlToText(raw) : raw.trim();
    return truncateAgentText(text, 10_000);
  } finally {
    clearTimeout(timeout);
  }
}

async function buildSummaryBotPromptContext(job) {
  const sourceUrls = extractUrlsFromText(job.description || "").slice(0, SUMMARY_AGENT_MAX_SOURCE_URLS);
  const collectedSources = [];
  for (const url of sourceUrls) {
    try {
      const text = await fetchSummarySourceFromUrl(url);
      if (text) {
        collectedSources.push({ url, text });
      }
    } catch (err) {
      collectedSources.push({ url, error: err.message || "Could not read source" });
    }
  }

  const sections = [
    `Job title: ${job.title || "Untitled job"}`,
    `Category: ${job.category || "Uncategorized"}`,
    `Task type: ${job.taskType || "Not specified"}`,
    `Budget: ${job.budget || "0.00"} USDC`,
    `Client request:\n${truncateAgentText(job.description || "", 12_000)}`,
  ];

  if (collectedSources.length) {
    sections.push(collectedSources.map((source, index) => (
      source.error
        ? `Source ${index + 1}: ${source.url}\nStatus: ${source.error}`
        : `Source ${index + 1}: ${source.url}\n${truncateAgentText(source.text, 8_000)}`
    )).join("\n\n"));
  }

  return {
    sourceUrls,
    collectedSources,
    promptText: sections.join("\n\n"),
  };
}

async function runSummaryBotModel(job, promptContext) {
  if (!SUMMARY_AGENT_OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY to enable SummaryBot execution");
  }

  const response = await fetch(`${withTrailingSlashRemoved(SUMMARY_AGENT_OPENAI_BASE_URL)}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUMMARY_AGENT_OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: SUMMARY_AGENT_MODEL,
      instructions: [
        "You are SummaryBot, an autonomous agent on AgentMarket running jobs on Arc Testnet.",
        "Produce a client-ready deliverable for summarization or lightweight research tasks.",
        "Ground the answer only in the provided job description and fetched public sources.",
        "If sources are incomplete or ambiguous, say so clearly instead of inventing facts.",
        "Output plain text with these sections: Executive Summary, Key Points, Action Items, Caveats.",
      ].join(" "),
      input: promptContext.promptText,
      max_output_tokens: 1200,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI request failed with status ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }

  const payload = await response.json();
  const outputText = extractOpenAiResponseText(payload);
  if (!outputText) throw new Error("SummaryBot model returned an empty response");

  return {
    outputText,
    model: payload?.model || SUMMARY_AGENT_MODEL,
    responseId: String(payload?.id || ""),
  };
}

async function createSummaryBotClaimTransaction(ownerWallet, jobId) {
  const client = getCircleDeveloperWalletClient();
  const response = await client.createContractExecutionTransaction({
    walletId: ownerWallet.walletId,
    contractAddress: JOB_BOARD_ADDRESS,
    abiFunctionSignature: "claimJob(uint256)",
    abiParameters: [Number(jobId)],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: `agentmarket-summarybot-claim-${Number(jobId)}`,
  });
  const txId = String(response?.data?.id || "");
  const transaction = await waitForCircleDeveloperTransaction(client, txId);
  return {
    id: txId,
    hash: String(transaction?.txHash || ""),
  };
}

async function createSummaryBotDeliverableTransaction(ownerWallet, jobId, locator) {
  const client = getCircleDeveloperWalletClient();
  const response = await client.createContractExecutionTransaction({
    walletId: ownerWallet.walletId,
    contractAddress: JOB_BOARD_ADDRESS,
    abiFunctionSignature: "submitDeliverable(uint256,string)",
    abiParameters: [Number(jobId), locator],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: `agentmarket-summarybot-submit-${Number(jobId)}`,
  });
  const txId = String(response?.data?.id || "");
  const transaction = await waitForCircleDeveloperTransaction(client, txId);
  return {
    id: txId,
    hash: String(transaction?.txHash || ""),
  };
}

function computeSummaryBotFeedback(job, run) {
  const completedOnTime = Number(job.completedAt || 0) > 0 && Number(job.deadline || 0) > 0
    ? Number(job.completedAt) <= Number(job.deadline)
    : true;
  const score = completedOnTime ? 95 : 82;
  const tag = completedOnTime ? "job_completed_on_time" : "job_completed_late";
  const comment = completedOnTime
    ? `SummaryBot delivered job #${job.id} and the client approved it before the deadline.`
    : `SummaryBot delivered job #${job.id}; the client approved it after the original deadline.`;
  const evidenceUri = run?.deliverableLocator || "";
  return { score, tag, comment, evidenceUri };
}

async function maybeRecordSummaryBotReputation(db, job) {
  if (Number(job.status) !== 3) return null;
  const run = getAgentRunByJobId(db, AGENT_KEYS.summary, job.id);
  if (!run || run.reputationTxHash) return run;

  const client = getCircleDeveloperWalletClient();
  if (!client) throw new Error("Circle developer-controlled wallets are not configured");
  const validatorWallet = getAgentWallet(db, AGENT_KEYS.summary, AGENT_WALLET_ROLES.validator);
  const registration = getAgentRegistration(db, AGENT_KEYS.summary);
  if (!validatorWallet?.walletId || !registration?.identityTokenId) return run;

  const feedback = computeSummaryBotFeedback(job, run);
  const feedbackHash = keccak256(toBytes(`${feedback.tag}:${job.id}:${run.id}`));
  const response = await client.createContractExecutionTransaction({
    walletId: validatorWallet.walletId,
    contractAddress: REPUTATION_REGISTRY,
    abiFunctionSignature: "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
    abiParameters: [
      registration.identityTokenId,
      String(feedback.score),
      0,
      feedback.tag,
      getSummaryBotMetadataUri(),
      feedback.evidenceUri,
      feedback.comment,
      feedbackHash,
    ],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: `agentmarket-summarybot-feedback-${Number(job.id)}`,
  });
  const txId = String(response?.data?.id || "");
  const transaction = await waitForCircleDeveloperTransaction(client, txId);

  return saveAgentRun(db, {
    id: run.id,
    status: AGENT_RUN_STATUSES.completed,
    completedAt: Number(job.completedAt || Date.now()),
    reputationTxId: txId,
    reputationTxHash: String(transaction?.txHash || ""),
    reputationScore: feedback.score,
    reputationTag: feedback.tag,
  });
}

async function ensureSummaryBotReady(db) {
  if (!SUMMARY_AGENT_ENABLED) {
    throw new Error("SummaryBot is disabled");
  }
  await ensureSummaryAgentWallets(db);
  if (SUMMARY_AGENT_AUTO_BOOTSTRAP) {
    await ensureSummaryAgentIdentityRegistration(db);
    if (SUMMARY_AGENT_AUTO_VALIDATE) {
      await ensureSummaryAgentValidation(db);
    }
  }
}

function isSummaryBotDirectAssignment(job, ownerWallet) {
  return Boolean(
    ownerWallet?.walletAddress
    && sameAddress(job.agent, ownerWallet.walletAddress)
    && Number(job.status) === 1
    && Number(job.workerType) === 0
  );
}

function isSummaryBotOpenClaim(job) {
  return Boolean(
    SUMMARY_AGENT_ALLOW_OPEN_CLAIMS
    && sameAddress(job.agent, ZERO_ADDRESS)
    && Number(job.status) === 0
    && isSummaryBotSupportedJob(job)
  );
}

async function processSummaryBotJob(db, ownerWallet, job) {
  let run = getAgentRunByJobId(db, AGENT_KEYS.summary, job.id);
  if (run && [AGENT_RUN_STATUSES.submitted, AGENT_RUN_STATUSES.completed].includes(run.status)) {
    return run;
  }

  run = saveAgentRun(db, {
    id: run?.id,
    agentKey: AGENT_KEYS.summary,
    jobId: job.id,
    jobTitle: job.title,
    jobCategory: job.category,
    clientWallet: job.client,
    workerWallet: ownerWallet.walletAddress,
    status: run?.status || AGENT_RUN_STATUSES.pending,
    attempts: Number(run?.attempts || 0) + 1,
    startedAt: run?.startedAt || Date.now(),
  });

  let liveJob = job;
  if (isSummaryBotOpenClaim(job)) {
    run = saveAgentRun(db, {
      id: run.id,
      status: AGENT_RUN_STATUSES.claiming,
    });
    const claimTx = await createSummaryBotClaimTransaction(ownerWallet, job.id);
    run = saveAgentRun(db, {
      id: run.id,
      status: AGENT_RUN_STATUSES.claimed,
      claimTxId: claimTx.id,
      claimTxHash: claimTx.hash,
    });
    const refreshedJobs = await getAllFormattedJobs();
    liveJob = refreshedJobs.find(item => Number(item.id) === Number(job.id)) || job;
  }

  run = saveAgentRun(db, {
    id: run.id,
    status: AGENT_RUN_STATUSES.running,
  });

  const promptContext = await buildSummaryBotPromptContext(liveJob);
  const modelResult = await runSummaryBotModel(liveJob, promptContext);
  const deliverableLocator = getSummaryBotDeliverableLocator(liveJob.id, run.id);
  if (!deliverableLocator) {
    throw new Error("Set AGENTMARKET_PUBLIC_API_BASE_URL so SummaryBot can publish deliverable links");
  }

  run = saveAgentRun(db, {
    id: run.id,
    status: AGENT_RUN_STATUSES.submitting,
    deliverableLocator,
    result: {
      jobId: liveJob.id,
      agentKey: AGENT_KEYS.summary,
      agentName: "SummaryBot",
      title: liveJob.title,
      category: liveJob.category,
      generatedAt: Date.now(),
      model: modelResult.model,
      responseId: modelResult.responseId,
      summary: modelResult.outputText,
      sourceUrls: promptContext.sourceUrls,
      collectedSources: promptContext.collectedSources.map(item => ({
        url: item.url,
        error: item.error || "",
      })),
      deliverableLocator,
    },
  });

  const submitTx = await createSummaryBotDeliverableTransaction(ownerWallet, liveJob.id, deliverableLocator);
  return saveAgentRun(db, {
    id: run.id,
    status: AGENT_RUN_STATUSES.submitted,
    submitTxId: submitTx.id,
    submitTxHash: submitTx.hash,
  });
}

function getSummaryBotCatalogEntry(db) {
  const ownerWallet = getAgentWallet(db, AGENT_KEYS.summary, AGENT_WALLET_ROLES.owner);
  const validatorWallet = getAgentWallet(db, AGENT_KEYS.summary, AGENT_WALLET_ROLES.validator);
  const registration = getAgentRegistration(db, AGENT_KEYS.summary);
  const recentRuns = listAgentRuns(db, AGENT_KEYS.summary, { limit: 5 });
  const activeRuns = recentRuns.filter(run => ![AGENT_RUN_STATUSES.completed, AGENT_RUN_STATUSES.failed].includes(run.status));
  return {
    id: "native-001",
    agentKey: AGENT_KEYS.summary,
    type: "AI",
    name: "SummaryBot",
    description: "Autonomous Arc-native summarizer that can claim eligible AI jobs, generate a client-ready brief, submit the deliverable onchain, and wait for payment approval.",
    taskTypes: ["summarize", "analyze", "research"],
    walletAddress: ownerWallet?.walletAddress || "",
    validatorWalletAddress: validatorWallet?.walletAddress || "",
    reputationScore: recentRuns.some(run => run.reputationScore > 0)
      ? Math.round(recentRuns.reduce((sum, run) => sum + Number(run.reputationScore || 0), 0) / Math.max(1, recentRuns.filter(run => run.reputationScore > 0).length))
      : 0,
    completedJobs: recentRuns.filter(run => run.status === AGENT_RUN_STATUSES.completed).length,
    isNative: true,
    isVerified: registration?.validationStatus === 100,
    isLive: SUMMARY_AGENT_ENABLED,
    liveStatus: activeRuns.length ? activeRuns[0].status : (summaryAgentRuntime.lastError ? "degraded" : "idle"),
    minBudget: "1.00",
    maxBudget: formatUsdc(SUMMARY_AGENT_MAX_BUDGET_USDC),
    identityTokenId: registration?.identityTokenId || "",
    metadataUri: registration?.metadataUri || getSummaryBotMetadataUri(),
    metadataUrl: getSummaryBotMetadataUri(),
    validationStatus: registration?.validationStatus ?? -1,
    validationTag: registration?.validationTag || "",
    missingConfig: getSummaryBotMissingConfig(db),
    recentRuns,
  };
}

async function runSummaryAgentCycle({ reason = "background" } = {}) {
  if (!SUMMARY_AGENT_ENABLED) return;
  if (summaryAgentLoopPromise) return summaryAgentLoopPromise;

  summaryAgentLoopPromise = (async () => {
    summaryAgentRuntime.running = true;
    summaryAgentRuntime.lastStartedAt = Date.now();
    try {
      const db = await ensurePulseDatabase();
      await ensureSummaryBotReady(db);
      summaryAgentRuntime.bootstrapped = true;
      const ownerWallet = getAgentWallet(db, AGENT_KEYS.summary, AGENT_WALLET_ROLES.owner);
      if (!ownerWallet?.walletAddress) throw new Error("SummaryBot owner wallet is not ready");

      const [jobs, activeRuns] = await Promise.all([
        getAllFormattedJobs(),
        Promise.resolve(listAgentRuns(db, AGENT_KEYS.summary, { limit: 50 })
          .filter(run => AGENT_ACTIVE_EXECUTION_STATUSES.has(run.status))),
      ]);

      for (const job of jobs.filter(item => sameAddress(item.agent, ownerWallet.walletAddress) && Number(item.status) === 3)) {
        await maybeRecordSummaryBotReputation(db, job);
      }

      const capacity = Math.max(0, SUMMARY_AGENT_MAX_CONCURRENT_JOBS - activeRuns.length);
      if (capacity <= 0) {
        summaryAgentRuntime.lastCompletedAt = Date.now();
        summaryAgentRuntime.lastError = "";
        return;
      }

      const candidates = jobs.filter(job => (
        (isSummaryBotDirectAssignment(job, ownerWallet) || isSummaryBotOpenClaim(job))
        && !getAgentRunByJobId(db, AGENT_KEYS.summary, job.id)
      )).slice(0, capacity);

      for (const job of candidates) {
        try {
          await processSummaryBotJob(db, ownerWallet, job);
        } catch (err) {
          const existingRun = getAgentRunByJobId(db, AGENT_KEYS.summary, job.id);
          saveAgentRun(db, {
            id: existingRun?.id,
            agentKey: AGENT_KEYS.summary,
            jobId: job.id,
            jobTitle: job.title,
            jobCategory: job.category,
            clientWallet: job.client,
            workerWallet: ownerWallet.walletAddress,
            status: AGENT_RUN_STATUSES.failed,
            attempts: Number(existingRun?.attempts || 0) + (existingRun ? 0 : 1),
            error: err.message || "SummaryBot job processing failed",
            startedAt: existingRun?.startedAt || Date.now(),
            completedAt: Date.now(),
          });
        }
      }

      summaryAgentRuntime.lastCompletedAt = Date.now();
      summaryAgentRuntime.lastError = "";
      summaryAgentLastCycleAt = Date.now();
    } catch (err) {
      summaryAgentRuntime.lastError = err.message || `SummaryBot ${reason} cycle failed`;
      summaryAgentRuntime.lastCompletedAt = Date.now();
    } finally {
      summaryAgentRuntime.running = false;
      summaryAgentLoopPromise = null;
    }
  })();

  return summaryAgentLoopPromise;
}

function startSummaryAgentLoop() {
  if (summaryAgentLoopTimer || !SUMMARY_AGENT_ENABLED) return;
  runSummaryAgentCycle({ reason: "startup" }).catch(() => {});
  summaryAgentLoopTimer = setInterval(() => {
    if ((Date.now() - summaryAgentLastCycleAt) < Math.max(5_000, Math.floor(SUMMARY_AGENT_LOOP_MS / 2))) return;
    runSummaryAgentCycle({ reason: "background" }).catch(() => {});
  }, SUMMARY_AGENT_LOOP_MS);
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
    contractsCount: 1,
    contractLabels: ["AgentMarket job board"],
    sourceLabel: "Tracked contract reads",
    sourceScope: "tracked-beta",
    scopeLabel: "Tracked beta",
    chainLabel: "Arc Testnet",
    walletCoverage: activeWallets.size,
    networkSharePercent: 100,
    attributionNote: "Single-contract fallback view from the live AgentMarket Arc contracts.",
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

function getPulseIndexedContractRows(db, liveContracts = null) {
  const contracts = Array.isArray(liveContracts) && liveContracts.length
    ? liveContracts
    : getPulseIndexerLiveContracts();
  const addressSet = new Set(contracts.map(item => String(item.addressLower || item.address || "").toLowerCase()).filter(Boolean));
  if (!addressSet.size) return [];

  return db.prepare(`
    SELECT *
    FROM pulse_indexed_contract_events
    ORDER BY block_timestamp ASC, block_number ASC, log_index ASC
  `).all().filter(row => addressSet.has(String(row.contract_address || "").toLowerCase()));
}

function createPulseIndexedAppStat(contractConfig = {}) {
  return {
    id: String(contractConfig.id || "indexed-app"),
    name: String(contractConfig.name || "Arc app"),
    category: String(contractConfig.category || "Arc App"),
    description: String(contractConfig.description || "Indexed Arc activity view."),
    chainLabel: String(contractConfig.chainLabel || "Arc Testnet"),
    contractLabels: new Set(),
    liveContracts: new Set(),
    activeWallets: new Set(),
    volumeUsdcRaw: 0,
    weeklyVolumeUsdcRaw: 0,
    previousWeekVolumeUsdcRaw: 0,
    jobs: 0,
    campaigns: 0,
    walletCoverage: 0,
    status: "Live indexed",
  };
}

function ensurePulseIndexedAppStat(statsMap, contractConfig = {}) {
  const key = String(contractConfig.id || "indexed-app").toLowerCase();
  if (!statsMap.has(key)) {
    statsMap.set(key, createPulseIndexedAppStat(contractConfig));
  }
  const entry = statsMap.get(key);
  entry.id = String(contractConfig.id || entry.id || "indexed-app");
  entry.name = String(contractConfig.name || entry.name || "Arc app");
  entry.category = String(contractConfig.category || entry.category || "Arc App");
  entry.description = String(contractConfig.description || entry.description || "Indexed Arc activity view.");
  entry.chainLabel = String(contractConfig.chainLabel || entry.chainLabel || "Arc Testnet");
  if (contractConfig.contractLabel) entry.contractLabels.add(String(contractConfig.contractLabel));
  if (contractConfig.address) entry.liveContracts.add(String(contractConfig.address));
  return entry;
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
  const liveContracts = getPulseIndexerLiveContracts();
  const contractConfigByAddress = getPulseIndexerLiveContractMap();
  const rows = getPulseIndexedContractRows(db, liveContracts);
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
  const appStats = new Map();
  const weekMs = 7 * DAY_MS;
  const now = Date.now();
  const currentWeekStart = now - weekMs;
  const previousWeekStart = now - (2 * weekMs);

  for (const contractConfig of liveContracts) {
    ensurePulseIndexedAppStat(appStats, contractConfig);
  }

  for (const row of rows) {
    const eventKey = String(row.event_key || "");
    const primaryWallet = String(row.wallet_primary || "").toLowerCase();
    const secondaryWallet = String(row.wallet_secondary || "").toLowerCase();
    const amountUsdc = toUsdcNumber(row.amount_usdc);
    const contractAddress = String(row.contract_address || "").toLowerCase();
    const contractConfig = contractConfigByAddress.get(contractAddress);
    const appEntry = contractConfig ? ensurePulseIndexedAppStat(appStats, contractConfig) : null;
    const eventTimestamp = Number(row.block_timestamp || 0);

    if (primaryWallet && !sameAddress(primaryWallet, ZERO_ADDRESS)) wallets.add(primaryWallet);
    if (secondaryWallet && !sameAddress(secondaryWallet, ZERO_ADDRESS)) wallets.add(secondaryWallet);
    if (appEntry) {
      if (primaryWallet && !sameAddress(primaryWallet, ZERO_ADDRESS)) appEntry.activeWallets.add(primaryWallet);
      if (secondaryWallet && !sameAddress(secondaryWallet, ZERO_ADDRESS)) appEntry.activeWallets.add(secondaryWallet);
    }

    if (eventKey === "job_posted") {
      totalJobs += 1;
      trackedVolumeUsdcRaw += amountUsdc;
      activityRows.push(row);
      if (appEntry) {
        appEntry.jobs += 1;
        appEntry.volumeUsdcRaw += amountUsdc;
        if (eventTimestamp >= currentWeekStart) {
          appEntry.weeklyVolumeUsdcRaw += amountUsdc;
        } else if (eventTimestamp >= previousWeekStart) {
          appEntry.previousWeekVolumeUsdcRaw += amountUsdc;
        }
      }
    } else if (eventKey === "campaign_created") {
      campaigns += 1;
      trackedVolumeUsdcRaw += amountUsdc;
      activityRows.push(row);
      if (appEntry) {
        appEntry.campaigns += 1;
        appEntry.volumeUsdcRaw += amountUsdc;
        if (eventTimestamp >= currentWeekStart) {
          appEntry.weeklyVolumeUsdcRaw += amountUsdc;
        } else if (eventTimestamp >= previousWeekStart) {
          appEntry.previousWeekVolumeUsdcRaw += amountUsdc;
        }
      }
    } else if (eventKey === "job_completed") {
      completedJobs += 1;
      settledVolumeUsdcRaw += amountUsdc;
    }
  }

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

  const indexedContractCount = liveContracts.length;
  const totalIndexedVolume = [...appStats.values()].reduce((sum, item) => sum + Number(item.volumeUsdcRaw || 0), 0);
  const liveAppRankings = [...appStats.values()]
    .map(item => {
      const rankingGrowthDirection = item.weeklyVolumeUsdcRaw > item.previousWeekVolumeUsdcRaw
        ? "up"
        : item.weeklyVolumeUsdcRaw < item.previousWeekVolumeUsdcRaw
          ? "down"
          : "flat";
      return {
        rank: 0,
        id: item.id,
        name: item.name,
        category: item.category,
        description: item.description,
        volumeUsdc: formatUsdc(item.volumeUsdcRaw),
        weeklyVolumeUsdc: formatUsdc(item.weeklyVolumeUsdcRaw),
        previousWeekVolumeUsdc: formatUsdc(item.previousWeekVolumeUsdcRaw),
        growthDirection: rankingGrowthDirection,
        growthPercent: item.previousWeekVolumeUsdcRaw > 0
          ? Number((((item.weeklyVolumeUsdcRaw - item.previousWeekVolumeUsdcRaw) / item.previousWeekVolumeUsdcRaw) * 100).toFixed(1))
          : null,
        activeWallets: item.activeWallets.size,
        jobs: item.jobs,
        campaigns: item.campaigns,
        liveContracts: [...item.liveContracts],
        contractsCount: item.liveContracts.size || item.contractLabels.size,
        contractLabels: [...item.contractLabels],
        sourceLabel: indexedContractCount > 1 ? "Arc RPC multi-contract indexer" : "Arc RPC event indexer",
        sourceScope: indexedContractCount > 1 ? "live-multi-contract-indexed" : "live-contract-indexed",
        scopeLabel: indexedContractCount > 1 ? "Live multi-contract" : "Live contract",
        chainLabel: item.chainLabel,
        walletCoverage: item.activeWallets.size,
        networkSharePercent: totalIndexedVolume > 0
          ? Number(((item.volumeUsdcRaw / totalIndexedVolume) * 100).toFixed(1))
          : (item.volumeUsdcRaw > 0 ? 100 : null),
        attributionNote: indexedContractCount > 1
          ? `Live Arc RPC slice grouped from ${item.liveContracts.size || 1} configured contract${(item.liveContracts.size || 1) === 1 ? "" : "s"}.`
          : "Live contract events indexed locally from Arc.",
        status: indexedContractCount > 1 ? "Live multi-contract" : "Live indexed",
      };
    })
    .sort((a, b) => (
      parsePulseIndexerNumber(b.volumeUsdc, 0) - parsePulseIndexerNumber(a.volumeUsdc, 0)
      || parsePulseIndexerNumber(b.weeklyVolumeUsdc, 0) - parsePulseIndexerNumber(a.weeklyVolumeUsdc, 0)
      || Number(b.activeWallets || 0) - Number(a.activeWallets || 0)
      || String(a.name || "").localeCompare(String(b.name || ""))
    ))
    .map((item, index) => ({ ...item, rank: index + 1 }));

  const indexedContractLabels = liveContracts
    .map(item => String(item.contractLabel || "").trim())
    .filter(Boolean)
    .slice(0, 6);

  return createPulseIndexerState({
    configured: true,
    connected: Boolean(lastSyncedAt > 0 || rows.length > 0),
    syncing: pulseContractIndexerRuntime.syncing,
    bootstrapped: pulseContractIndexerRuntime.bootstrapped || lastSyncedAt > 0,
    sourceLabel: indexedContractCount > 1 ? "Arc RPC multi-contract indexer" : "Arc RPC event indexer",
    scope: indexedContractCount > 1 ? "live-multi-contract-indexed" : "live-contract-indexed",
    generatedAt: lastSyncedAt || Date.now(),
    syncStartedAt: pulseContractIndexerRuntime.startedAt,
    syncCompletedAt: pulseContractIndexerRuntime.completedAt || lastSyncedAt,
    syncDurationMs: pulseContractIndexerRuntime.durationMs,
    syncedBlock: pulseContractIndexerRuntime.syncedBlock || syncedToBlock,
    targetBlock: pulseContractIndexerRuntime.targetBlock,
    overview,
    volume14d: createPulseIndexedSeries(rows),
    categoryBreakdown: createPulseIndexedCategoryBreakdown(rows),
    appRankings: liveAppRankings.length ? liveAppRankings : [{
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
      contractsCount: 1,
      contractLabels: ["AgentMarket job board"],
      sourceLabel: "Arc RPC event indexer",
      sourceScope: "live-contract-indexed",
      scopeLabel: "Live contract",
      chainLabel: "Arc Testnet",
      walletCoverage: wallets.size,
      networkSharePercent: 100,
      attributionNote: "Live contract events indexed locally from the AgentMarket job board on Arc.",
      status: "Live indexed",
    }],
    notes: [
      indexedContractCount > 1
        ? `Pulse contract indexer is live across ${indexedContractCount} Arc contracts: ${indexedContractLabels.join(", ")}.`
        : `Pulse contract indexer is live against ${shortWallet(JOB_BOARD_ADDRESS)} on Arc.`,
      syncedToBlock > 0
        ? `Latest indexed block #${syncedToBlock.toLocaleString("en-US")} with sync time ${formatPulseCalendarLabel(lastSyncedAt || Date.now())}.`
        : "The live contract indexer is connected and waiting for the first indexed block.",
      startBlock > 0
        ? `Indexer backfill starts from block #${startBlock.toLocaleString("en-US")} for the configured live contract set.`
        : "Indexer start block is using the automatic fallback window for the configured live contract set.",
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

  const liveContracts = getPulseIndexerLiveContracts(targetBlock);
  const liveContractsByAddress = new Map(liveContracts.map(item => [item.addressLower, item]));
  const configuredStartBlock = getPulseIndexerConfiguredStartBlock(targetBlock, liveContracts);
  ensurePulseContractIndexerSchema(db, configuredStartBlock, liveContracts);
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
      address: liveContracts.map(item => item.address),
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
      const contractAddress = String(log.address || "").toLowerCase();
      const contractConfig = liveContractsByAddress.get(contractAddress);
      if (!contractConfig) continue;

      if (eventName === "JobPosted") {
        normalizedRows.push({
          contractAddress,
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
            appId: contractConfig.id,
            appName: contractConfig.name,
            contractLabel: contractConfig.contractLabel,
          }),
          createdAt: blockTimestamp,
        });
      } else if (eventName === "JobClaimed") {
        normalizedRows.push({
          contractAddress,
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
          payloadJson: JSON.stringify({
            appId: contractConfig.id,
            appName: contractConfig.name,
            contractLabel: contractConfig.contractLabel,
          }),
          createdAt: blockTimestamp,
        });
      } else if (eventName === "JobCompleted") {
        normalizedRows.push({
          contractAddress,
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
            appId: contractConfig.id,
            appName: contractConfig.name,
            contractLabel: contractConfig.contractLabel,
          }),
          createdAt: blockTimestamp,
        });
      } else if (eventName === "JobRejected") {
        normalizedRows.push({
          contractAddress,
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
          payloadJson: JSON.stringify({
            appId: contractConfig.id,
            appName: contractConfig.name,
            contractLabel: contractConfig.contractLabel,
          }),
          createdAt: blockTimestamp,
        });
      } else if (eventName === "CampaignCreated") {
        normalizedRows.push({
          contractAddress,
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
          payloadJson: JSON.stringify({
            appId: contractConfig.id,
            appName: contractConfig.name,
            contractLabel: contractConfig.contractLabel,
          }),
          createdAt: blockTimestamp,
        });
      } else if (eventName === "CampaignExpired") {
        normalizedRows.push({
          contractAddress,
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
          payloadJson: JSON.stringify({
            appId: contractConfig.id,
            appName: contractConfig.name,
            contractLabel: contractConfig.contractLabel,
          }),
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
    walletAnalytics: [],
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

function describePulseIndexerScopeLabel(scope = "", fallback = "Indexed overlay") {
  const value = normalizePulseIndexerText(scope, "").toLowerCase();
  if (!value) return fallback;
  if (value.includes("full-network")) return "Hosted network";
  if (value.includes("hosted")) return "Hosted overlay";
  if (value.includes("live-contract")) return "Live contract";
  if (value.includes("tracked")) return "Tracked beta";
  if (value.includes("indexed")) return "Indexed overlay";
  return fallback;
}

function normalizePulseIndexerLabelList(items = []) {
  if (!Array.isArray(items)) return [];
  return items
    .map(item => normalizePulseIndexerText(item, ""))
    .filter(Boolean)
    .slice(0, 6);
}

function normalizePulseIndexerAppRanking(item, fallbackIndex = 0, context = {}) {
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
  const contractLabels = normalizePulseIndexerLabelList(item.contractLabels ?? item.contractNames ?? item.contracts);
  const contractsCount = Math.max(
    liveContracts.length,
    contractLabels.length,
    parsePulseIndexerCount(item.contractCount ?? item.contractsCount ?? item.liveContractCount, 0),
  );
  const sourceScope = normalizePulseWalletAnalyticsSourceScope(item.sourceScope ?? context.sourceScope);
  const sourceLabel = normalizePulseIndexerText(
    item.sourceLabel ?? item.source ?? item.provider,
    context.sourceLabel ?? "",
  );
  const scopeLabel = normalizePulseIndexerText(
    item.scopeLabel ?? item.coverageLabel,
    describePulseIndexerScopeLabel(sourceScope),
  );
  const chainLabel = normalizePulseIndexerText(
    item.chainLabel ?? item.chain ?? item.network,
    "Arc Testnet",
  );
  const walletCoverage = parsePulseIndexerCount(
    item.walletCoverage ?? item.attributedWallets ?? item.walletsCovered ?? item.activeWallets,
    0,
  );
  const networkSharePercent = item.networkSharePercent !== undefined && item.networkSharePercent !== null && item.networkSharePercent !== ""
    ? Number(parsePulseIndexerNumber(item.networkSharePercent, 0).toFixed(1))
    : null;
  const attributionNote = normalizePulseIndexerText(
    item.attributionNote ?? item.attribution ?? item.note,
    "",
  );

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
    contractsCount,
    contractLabels,
    sourceLabel,
    sourceScope,
    scopeLabel,
    chainLabel,
    walletCoverage,
    networkSharePercent,
    attributionNote,
    status: normalizePulseIndexerText(item.status, "Full-network indexed"),
  };
}

function normalizePulseWalletAnalyticsSourceScope(value = "") {
  const scope = normalizePulseIndexerText(value, "").toLowerCase();
  if (!scope) return "hosted-network-indexed";
  return scope.includes("indexed") ? scope : `${scope}-indexed`;
}

function normalizePulseIndexerLaneValue(value = "") {
  const lane = normalizePulseIndexerText(value, "").toLowerCase();
  return PULSE_LANES.has(lane) ? lane : "";
}

function normalizePulseIndexerWalletAnalyticsItem(item, fallbackIndex = 0, context = {}) {
  if (!isPlainObject(item)) return null;

  const wallet = String(item.wallet ?? item.address ?? "").trim().toLowerCase();
  if (!isHexAddress(wallet) || sameAddress(wallet, ZERO_ADDRESS)) return null;

  return {
    wallet,
    displayName: normalizePulseIndexerText(item.displayName ?? item.name ?? item.label, ""),
    jobsAsClient: parsePulseIndexerCount(item.jobsAsClient ?? item.jobsPosted ?? item.clientJobs, 0),
    jobsAsWorker: parsePulseIndexerCount(item.jobsAsWorker ?? item.jobsClaimed ?? item.workerJobs, 0),
    jobsCompleted: parsePulseIndexerCount(item.jobsCompleted ?? item.completions ?? item.completedJobs, 0),
    jobsSettled: parsePulseIndexerCount(item.jobsSettled ?? item.settlements ?? item.settledJobs, 0),
    campaignsCreated: parsePulseIndexerCount(item.campaignsCreated ?? item.campaigns ?? item.campaignCount, 0),
    trackedVolumeUsdc: parsePulseIndexerNumber(item.trackedVolumeUsdc ?? item.volumeUsdc ?? item.totalVolumeUsdc ?? item.volume, 0),
    settledVolumeUsdc: parsePulseIndexerNumber(item.settledVolumeUsdc ?? item.completedVolumeUsdc ?? item.settledVolume ?? item.completedVolume, 0),
    memberSince: normalizePulseIndexerTimestamp(
      item.memberSince ?? item.firstSeenAt ?? item.createdAt ?? item.firstActivityAt ?? item.since,
    ),
    mostUsedAppLabel: normalizePulseIndexerText(
      item.mostUsedApp ?? item.primaryApp ?? item.app ?? item.appName,
      "",
    ),
    primaryLane: normalizePulseIndexerLaneValue(
      item.primaryLane ?? item.lane ?? item.primaryCategory,
    ),
    appFootprint: normalizePulseWalletAppFootprint(
      item.appFootprint ?? item.topApps ?? item.apps,
    ),
    sourceLabel: normalizePulseIndexerText(item.sourceLabel, context.sourceLabel),
    sourceScope: normalizePulseWalletAnalyticsSourceScope(item.sourceScope ?? context.sourceScope),
    rank: parsePulseIndexerCount(item.rank, fallbackIndex + 1),
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
  const scope = normalizePulseIndexerText(input.scope, "indexed-overlay");

  return {
    sourceLabel,
    scope,
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
        .map((item, index) => normalizePulseIndexerAppRanking(item, index, { sourceLabel, sourceScope: scope }))
        .filter(Boolean)
      : [],
    walletAnalytics: Array.isArray(input.walletAnalytics ?? input.walletRankings ?? input.wallets)
      ? (input.walletAnalytics ?? input.walletRankings ?? input.wallets)
        .map((item, index) => normalizePulseIndexerWalletAnalyticsItem(item, index, { sourceLabel, sourceScope: scope }))
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
    if (Array.isArray(indexerState.walletAnalytics) && indexerState.walletAnalytics.length) {
      notes.push(`Hosted wallet analytics are attached for ${indexerState.walletAnalytics.length} wallets, so Arc ID can widen beyond the local AgentMarket contract rows.`);
    }
    notes.push("Arc ID wallet scoring now uses the indexed wallet layer whenever live contract rows or hosted wallet overlays are available.");
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

function ensurePulseContractIndexerSchema(db, configuredStartBlock, liveContracts = null) {
  const currentVersion = pulseMetaGet(db, "pulse-indexer:schema-version");
  const currentFingerprint = pulseMetaGet(db, "pulse-indexer:config-fingerprint");
  const nextFingerprint = getPulseIndexerConfigFingerprint(liveContracts);
  if (currentVersion === PULSE_INDEXER_SCHEMA_VERSION && currentFingerprint === nextFingerprint) return;

  db.exec("DELETE FROM pulse_indexed_contract_events;");
  pulseMetaSet(db, "pulse-indexer:schema-version", PULSE_INDEXER_SCHEMA_VERSION);
  pulseMetaSet(db, "pulse-indexer:config-fingerprint", nextFingerprint);
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

function normalizeAgentWalletRecord(record) {
  if (!record) return null;
  return {
    agentKey: String(record.agent_key || record.agentKey || "").toLowerCase(),
    walletRole: String(record.wallet_role || record.walletRole || "").toLowerCase(),
    walletSetId: String(record.wallet_set_id || record.walletSetId || ""),
    walletId: String(record.wallet_id || record.walletId || ""),
    walletAddress: String(record.wallet_address || record.walletAddress || "").toLowerCase(),
    blockchain: String(record.blockchain || ARC_BLOCKCHAIN_ID),
    accountType: String(record.account_type || record.accountType || "SCA"),
    createdAt: Number(record.created_at || record.createdAt || 0),
    updatedAt: Number(record.updated_at || record.updatedAt || 0),
  };
}

function listAgentWallets(db, agentKey) {
  return db.prepare("SELECT * FROM agent_wallets WHERE agent_key = ? ORDER BY wallet_role ASC")
    .all(String(agentKey || "").toLowerCase())
    .map(normalizeAgentWalletRecord)
    .filter(Boolean);
}

function getAgentWallet(db, agentKey, walletRole) {
  const row = db.prepare("SELECT * FROM agent_wallets WHERE agent_key = ? AND wallet_role = ?")
    .get(String(agentKey || "").toLowerCase(), String(walletRole || "").toLowerCase());
  return normalizeAgentWalletRecord(row);
}

function saveAgentWallet(db, agentKey, walletRole, payload = {}) {
  const now = Date.now();
  const existing = getAgentWallet(db, agentKey, walletRole);
  db.prepare(`
    INSERT INTO agent_wallets (
      agent_key, wallet_role, wallet_set_id, wallet_id, wallet_address,
      blockchain, account_type, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_key, wallet_role) DO UPDATE SET
      wallet_set_id = excluded.wallet_set_id,
      wallet_id = excluded.wallet_id,
      wallet_address = excluded.wallet_address,
      blockchain = excluded.blockchain,
      account_type = excluded.account_type,
      updated_at = excluded.updated_at
  `).run(
    String(agentKey || "").toLowerCase(),
    String(walletRole || "").toLowerCase(),
    String(payload.walletSetId || existing?.walletSetId || ""),
    String(payload.walletId || existing?.walletId || ""),
    String(payload.walletAddress || existing?.walletAddress || "").toLowerCase(),
    String(payload.blockchain || existing?.blockchain || ARC_BLOCKCHAIN_ID),
    String(payload.accountType || existing?.accountType || "SCA"),
    existing?.createdAt || now,
    now,
  );
  return getAgentWallet(db, agentKey, walletRole);
}

function normalizeAgentRegistrationRecord(record) {
  if (!record) return null;
  let metadata = {};
  try {
    metadata = JSON.parse(record.metadata_json || record.metadataJson || "{}");
  } catch {}
  return {
    agentKey: String(record.agent_key || record.agentKey || "").toLowerCase(),
    metadataUri: String(record.metadata_uri || record.metadataUri || ""),
    metadata: isPlainObject(metadata) ? metadata : {},
    identityTokenId: String(record.identity_token_id || record.identityTokenId || ""),
    identityTxId: String(record.identity_tx_id || record.identityTxId || ""),
    identityTxHash: String(record.identity_tx_hash || record.identityTxHash || ""),
    validationRequestHash: String(record.validation_request_hash || record.validationRequestHash || ""),
    validationRequestTxId: String(record.validation_request_tx_id || record.validationRequestTxId || ""),
    validationRequestTxHash: String(record.validation_request_tx_hash || record.validationRequestTxHash || ""),
    validationResponseTxId: String(record.validation_response_tx_id || record.validationResponseTxId || ""),
    validationResponseTxHash: String(record.validation_response_tx_hash || record.validationResponseTxHash || ""),
    validationStatus: Number(record.validation_status ?? record.validationStatus ?? -1),
    validationTag: String(record.validation_tag || record.validationTag || ""),
    registeredAt: Number(record.registered_at || record.registeredAt || 0),
    validatedAt: Number(record.validated_at || record.validatedAt || 0),
    updatedAt: Number(record.updated_at || record.updatedAt || 0),
  };
}

function getAgentRegistration(db, agentKey) {
  const row = db.prepare("SELECT * FROM agent_registrations WHERE agent_key = ?")
    .get(String(agentKey || "").toLowerCase());
  return normalizeAgentRegistrationRecord(row);
}

function saveAgentRegistration(db, agentKey, payload = {}) {
  const now = Date.now();
  const existing = getAgentRegistration(db, agentKey);
  const metadata = isPlainObject(payload.metadata) ? payload.metadata : (existing?.metadata || {});
  db.prepare(`
    INSERT INTO agent_registrations (
      agent_key, metadata_uri, metadata_json, identity_token_id, identity_tx_id, identity_tx_hash,
      validation_request_hash, validation_request_tx_id, validation_request_tx_hash,
      validation_response_tx_id, validation_response_tx_hash, validation_status, validation_tag,
      registered_at, validated_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_key) DO UPDATE SET
      metadata_uri = excluded.metadata_uri,
      metadata_json = excluded.metadata_json,
      identity_token_id = excluded.identity_token_id,
      identity_tx_id = excluded.identity_tx_id,
      identity_tx_hash = excluded.identity_tx_hash,
      validation_request_hash = excluded.validation_request_hash,
      validation_request_tx_id = excluded.validation_request_tx_id,
      validation_request_tx_hash = excluded.validation_request_tx_hash,
      validation_response_tx_id = excluded.validation_response_tx_id,
      validation_response_tx_hash = excluded.validation_response_tx_hash,
      validation_status = excluded.validation_status,
      validation_tag = excluded.validation_tag,
      registered_at = excluded.registered_at,
      validated_at = excluded.validated_at,
      updated_at = excluded.updated_at
  `).run(
    String(agentKey || "").toLowerCase(),
    String(payload.metadataUri ?? existing?.metadataUri ?? ""),
    JSON.stringify(metadata),
    String(payload.identityTokenId ?? existing?.identityTokenId ?? ""),
    String(payload.identityTxId ?? existing?.identityTxId ?? ""),
    String(payload.identityTxHash ?? existing?.identityTxHash ?? ""),
    String(payload.validationRequestHash ?? existing?.validationRequestHash ?? ""),
    String(payload.validationRequestTxId ?? existing?.validationRequestTxId ?? ""),
    String(payload.validationRequestTxHash ?? existing?.validationRequestTxHash ?? ""),
    String(payload.validationResponseTxId ?? existing?.validationResponseTxId ?? ""),
    String(payload.validationResponseTxHash ?? existing?.validationResponseTxHash ?? ""),
    payload.validationStatus ?? existing?.validationStatus ?? -1,
    String(payload.validationTag ?? existing?.validationTag ?? ""),
    Number(payload.registeredAt ?? existing?.registeredAt ?? 0),
    Number(payload.validatedAt ?? existing?.validatedAt ?? 0),
    now,
  );
  return getAgentRegistration(db, agentKey);
}

function normalizeAgentRunRecord(record) {
  if (!record) return null;
  let result = {};
  try {
    result = JSON.parse(record.result_json || record.resultJson || "{}");
  } catch {}
  return {
    id: String(record.id || ""),
    agentKey: String(record.agent_key || record.agentKey || "").toLowerCase(),
    jobId: Number(record.job_id || record.jobId || 0),
    jobTitle: String(record.job_title || record.jobTitle || ""),
    jobCategory: String(record.job_category || record.jobCategory || ""),
    clientWallet: String(record.client_wallet || record.clientWallet || "").toLowerCase(),
    workerWallet: String(record.worker_wallet || record.workerWallet || "").toLowerCase(),
    status: String(record.status || AGENT_RUN_STATUSES.pending),
    attempts: Number(record.attempts || 0),
    claimTxId: String(record.claim_tx_id || record.claimTxId || ""),
    claimTxHash: String(record.claim_tx_hash || record.claimTxHash || ""),
    submitTxId: String(record.submit_tx_id || record.submitTxId || ""),
    submitTxHash: String(record.submit_tx_hash || record.submitTxHash || ""),
    deliverableLocator: String(record.deliverable_locator || record.deliverableLocator || ""),
    result: isPlainObject(result) ? result : {},
    error: String(record.error || ""),
    reputationTxId: String(record.reputation_tx_id || record.reputationTxId || ""),
    reputationTxHash: String(record.reputation_tx_hash || record.reputationTxHash || ""),
    reputationScore: Number(record.reputation_score || 0),
    reputationTag: String(record.reputation_tag || record.reputationTag || ""),
    createdAt: Number(record.created_at || record.createdAt || 0),
    updatedAt: Number(record.updated_at || record.updatedAt || 0),
    startedAt: Number(record.started_at || record.startedAt || 0),
    completedAt: Number(record.completed_at || record.completedAt || 0),
  };
}

function getAgentRunByJobId(db, agentKey, jobId) {
  const row = db.prepare("SELECT * FROM agent_runs WHERE agent_key = ? AND job_id = ?")
    .get(String(agentKey || "").toLowerCase(), Number(jobId || 0));
  return normalizeAgentRunRecord(row);
}

function getAgentRunById(db, runId) {
  const row = db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(String(runId || ""));
  return normalizeAgentRunRecord(row);
}

function listAgentRuns(db, agentKey, { limit = 20 } = {}) {
  return db.prepare("SELECT * FROM agent_runs WHERE agent_key = ? ORDER BY updated_at DESC LIMIT ?")
    .all(String(agentKey || "").toLowerCase(), Math.max(1, Number(limit || 20)))
    .map(normalizeAgentRunRecord)
    .filter(Boolean);
}

function saveAgentRun(db, payload = {}) {
  const existing = payload.id
    ? getAgentRunById(db, payload.id)
    : getAgentRunByJobId(db, payload.agentKey, payload.jobId);
  const id = String(payload.id || existing?.id || randomUUID());
  const now = Date.now();
  const result = isPlainObject(payload.result) ? payload.result : (existing?.result || {});
  db.prepare(`
    INSERT INTO agent_runs (
      id, agent_key, job_id, job_title, job_category, client_wallet, worker_wallet, status, attempts,
      claim_tx_id, claim_tx_hash, submit_tx_id, submit_tx_hash, deliverable_locator, result_json, error,
      reputation_tx_id, reputation_tx_hash, reputation_score, reputation_tag, created_at, updated_at, started_at, completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      agent_key = excluded.agent_key,
      job_id = excluded.job_id,
      job_title = excluded.job_title,
      job_category = excluded.job_category,
      client_wallet = excluded.client_wallet,
      worker_wallet = excluded.worker_wallet,
      status = excluded.status,
      attempts = excluded.attempts,
      claim_tx_id = excluded.claim_tx_id,
      claim_tx_hash = excluded.claim_tx_hash,
      submit_tx_id = excluded.submit_tx_id,
      submit_tx_hash = excluded.submit_tx_hash,
      deliverable_locator = excluded.deliverable_locator,
      result_json = excluded.result_json,
      error = excluded.error,
      reputation_tx_id = excluded.reputation_tx_id,
      reputation_tx_hash = excluded.reputation_tx_hash,
      reputation_score = excluded.reputation_score,
      reputation_tag = excluded.reputation_tag,
      updated_at = excluded.updated_at,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at
  `).run(
    id,
    String(payload.agentKey || existing?.agentKey || "").toLowerCase(),
    Number(payload.jobId || existing?.jobId || 0),
    String(payload.jobTitle ?? existing?.jobTitle ?? ""),
    String(payload.jobCategory ?? existing?.jobCategory ?? ""),
    String(payload.clientWallet ?? existing?.clientWallet ?? "").toLowerCase(),
    String(payload.workerWallet ?? existing?.workerWallet ?? "").toLowerCase(),
    String(payload.status || existing?.status || AGENT_RUN_STATUSES.pending),
    Number(payload.attempts ?? existing?.attempts ?? 0),
    String(payload.claimTxId ?? existing?.claimTxId ?? ""),
    String(payload.claimTxHash ?? existing?.claimTxHash ?? ""),
    String(payload.submitTxId ?? existing?.submitTxId ?? ""),
    String(payload.submitTxHash ?? existing?.submitTxHash ?? ""),
    String(payload.deliverableLocator ?? existing?.deliverableLocator ?? ""),
    JSON.stringify(result),
    String(payload.error ?? existing?.error ?? ""),
    String(payload.reputationTxId ?? existing?.reputationTxId ?? ""),
    String(payload.reputationTxHash ?? existing?.reputationTxHash ?? ""),
    Number(payload.reputationScore ?? existing?.reputationScore ?? 0),
    String(payload.reputationTag ?? existing?.reputationTag ?? ""),
    Number(existing?.createdAt || payload.createdAt || now),
    now,
    Number(payload.startedAt ?? existing?.startedAt ?? 0),
    Number(payload.completedAt ?? existing?.completedAt ?? 0),
  );
  return getAgentRunById(db, id);
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

        CREATE TABLE IF NOT EXISTS agent_wallets (
          agent_key TEXT NOT NULL,
          wallet_role TEXT NOT NULL,
          wallet_set_id TEXT NOT NULL DEFAULT '',
          wallet_id TEXT NOT NULL DEFAULT '',
          wallet_address TEXT NOT NULL DEFAULT '',
          blockchain TEXT NOT NULL DEFAULT 'ARC-TESTNET',
          account_type TEXT NOT NULL DEFAULT 'SCA',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (agent_key, wallet_role)
        );

        CREATE TABLE IF NOT EXISTS agent_registrations (
          agent_key TEXT PRIMARY KEY,
          metadata_uri TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          identity_token_id TEXT NOT NULL DEFAULT '',
          identity_tx_id TEXT NOT NULL DEFAULT '',
          identity_tx_hash TEXT NOT NULL DEFAULT '',
          validation_request_hash TEXT NOT NULL DEFAULT '',
          validation_request_tx_id TEXT NOT NULL DEFAULT '',
          validation_request_tx_hash TEXT NOT NULL DEFAULT '',
          validation_response_tx_id TEXT NOT NULL DEFAULT '',
          validation_response_tx_hash TEXT NOT NULL DEFAULT '',
          validation_status INTEGER NOT NULL DEFAULT -1,
          validation_tag TEXT NOT NULL DEFAULT '',
          registered_at INTEGER NOT NULL DEFAULT 0,
          validated_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_runs (
          id TEXT PRIMARY KEY,
          agent_key TEXT NOT NULL,
          job_id INTEGER NOT NULL UNIQUE,
          job_title TEXT NOT NULL DEFAULT '',
          job_category TEXT NOT NULL DEFAULT '',
          client_wallet TEXT NOT NULL DEFAULT '',
          worker_wallet TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          claim_tx_id TEXT NOT NULL DEFAULT '',
          claim_tx_hash TEXT NOT NULL DEFAULT '',
          submit_tx_id TEXT NOT NULL DEFAULT '',
          submit_tx_hash TEXT NOT NULL DEFAULT '',
          deliverable_locator TEXT NOT NULL DEFAULT '',
          result_json TEXT NOT NULL DEFAULT '{}',
          error TEXT NOT NULL DEFAULT '',
          reputation_tx_id TEXT NOT NULL DEFAULT '',
          reputation_tx_hash TEXT NOT NULL DEFAULT '',
          reputation_score INTEGER NOT NULL DEFAULT 0,
          reputation_tag TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER NOT NULL DEFAULT 0,
          completed_at INTEGER NOT NULL DEFAULT 0
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
        CREATE INDEX IF NOT EXISTS idx_agent_wallets_address ON agent_wallets(wallet_address);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_status ON agent_runs(agent_key, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_updated_at ON agent_runs(updated_at DESC);
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

function createPulseWalletArcActivityState() {
  return {
    totalSentTransactions: 0,
    totalWalletTouches: 0,
    contractsDeployed: 0,
    uniqueContractsInteracted: 0,
    activeDays: 0,
    successfulTransactions: 0,
    failedTransactions: 0,
    totalFeesPaidUsdc: 0,
    currentBalanceUsdc: 0,
    firstActivityAt: 0,
    lastActivityAt: 0,
    updatedAt: 0,
    stale: false,
    sourceLabel: "",
    score: 0,
  };
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
    mostUsedAppLabel: "",
    appUsage: {},
    primaryLane: "",
    arcActivity: createPulseWalletArcActivityState(),
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

function ensurePulseWalletAppUsage(entry, descriptor = {}) {
  if (!entry) return null;
  if (!entry.appUsage || typeof entry.appUsage !== "object" || Array.isArray(entry.appUsage)) {
    entry.appUsage = {};
  }

  const appId = slugifyPulseIndexerText(
    descriptor.id || descriptor.appId || descriptor.name || descriptor.contractLabel || "arc-app",
    "arc-app",
  );
  if (!entry.appUsage[appId]) {
    entry.appUsage[appId] = {
      id: appId,
      name: String(descriptor.name || descriptor.appName || descriptor.label || "Arc app"),
      trackedActions: 0,
      trackedVolumeUsdc: 0,
      contractLabels: [],
    };
  }

  const item = entry.appUsage[appId];
  if (descriptor.name && !item.name) item.name = String(descriptor.name);
  const contractLabel = String(descriptor.contractLabel || descriptor.label || "").trim();
  if (contractLabel && !item.contractLabels.includes(contractLabel)) {
    item.contractLabels.push(contractLabel);
  }
  return item;
}

function notePulseWalletAppAttribution(entry, descriptor = {}, {
  trackedActions = 0,
  trackedVolumeUsdc = 0,
} = {}) {
  const item = ensurePulseWalletAppUsage(entry, descriptor);
  if (!item) return;
  item.trackedActions += Math.max(0, Number(trackedActions || 0));
  item.trackedVolumeUsdc += Math.max(0, Number(trackedVolumeUsdc || 0));
}

function normalizePulseWalletAppFootprint(items = []) {
  if (!Array.isArray(items)) return [];
  return items
    .map(item => {
      if (!isPlainObject(item)) return null;
      const name = normalizePulseIndexerText(item.name ?? item.app ?? item.label, "");
      if (!name) return null;
      return {
        id: slugifyPulseIndexerText(item.id || item.appId || name, "arc-app"),
        name,
        trackedActions: parsePulseIndexerCount(item.trackedActions ?? item.actions ?? item.events, 0),
        trackedVolumeUsdc: parsePulseIndexerNumber(item.trackedVolumeUsdc ?? item.volumeUsdc ?? item.volume, 0),
        contractLabels: normalizePulseIndexerLabelList(item.contractLabels ?? item.contracts),
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function formatPulseWalletAppFootprint(entry) {
  return Object.values(entry?.appUsage || {})
    .map(item => ({
      id: String(item.id || ""),
      name: String(item.name || "Arc app"),
      trackedActions: Math.max(0, Number(item.trackedActions || 0)),
      trackedVolumeUsdc: formatUsdc(item.trackedVolumeUsdc || 0),
      trackedVolumeUsdcRaw: Number((Number(item.trackedVolumeUsdc || 0)).toFixed(2)),
      contractLabels: Array.isArray(item.contractLabels) ? item.contractLabels.slice(0, 4) : [],
    }))
    .sort((a, b) => (
      b.trackedActions - a.trackedActions
      || b.trackedVolumeUsdcRaw - a.trackedVolumeUsdcRaw
      || a.name.localeCompare(b.name)
    ))
    .slice(0, 6);
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

function scorePulseWalletArcActivity(state = {}) {
  const totalSentTransactions = Math.max(0, Number(state.totalSentTransactions || 0));
  const activeDays = Math.max(0, Number(state.activeDays || 0));
  const uniqueContractsInteracted = Math.max(0, Number(state.uniqueContractsInteracted || 0));
  const contractsDeployed = Math.max(0, Number(state.contractsDeployed || 0));
  const successfulTransactions = Math.max(0, Number(state.successfulTransactions || 0));
  const failedTransactions = Math.max(0, Number(state.failedTransactions || 0));
  const totalFeesPaidUsdc = Math.max(0, Number(state.totalFeesPaidUsdc || 0));
  const currentBalanceUsdc = Math.max(0, Number(state.currentBalanceUsdc || 0));
  const totalKnownTransactions = successfulTransactions + failedTransactions;
  const successRate = totalKnownTransactions > 0 ? (successfulTransactions / totalKnownTransactions) : 0;

  return Math.round(
    Math.min(72, Math.sqrt(totalSentTransactions) * 12)
    + Math.min(30, activeDays * 3)
    + Math.min(24, uniqueContractsInteracted * 4)
    + Math.min(20, contractsDeployed * 8)
    + Math.min(14, Math.sqrt(totalFeesPaidUsdc) * 5)
    + Math.min(12, Math.sqrt(currentBalanceUsdc) * 3)
    + (totalKnownTransactions >= 3
      ? (successRate >= 0.95 ? 12 : (successRate >= 0.85 ? 8 : (successRate >= 0.7 ? 4 : 0)))
      : 0)
  );
}

function normalizePulseWalletArcActivity(payload = {}) {
  const summary = payload?.summary && typeof payload.summary === "object" ? payload.summary : payload;
  const arcActivity = createPulseWalletArcActivityState();
  arcActivity.totalSentTransactions = Math.max(0, Number(summary?.totalSentTransactions || 0));
  arcActivity.totalWalletTouches = Math.max(0, Number(summary?.totalWalletTouches || 0));
  arcActivity.contractsDeployed = Math.max(0, Number(summary?.contractsDeployed || 0));
  arcActivity.uniqueContractsInteracted = Math.max(0, Number(summary?.uniqueContractsInteracted || 0));
  arcActivity.activeDays = Math.max(0, Number(summary?.activeDays || 0));
  arcActivity.successfulTransactions = Math.max(0, Number(summary?.successfulTransactions || 0));
  arcActivity.failedTransactions = Math.max(0, Number(summary?.failedTransactions || 0));
  arcActivity.totalFeesPaidUsdc = Math.max(0, toUsdcNumber(summary?.totalFeesPaidUsdc));
  arcActivity.currentBalanceUsdc = Math.max(0, toUsdcNumber(summary?.currentBalanceUsdc));
  arcActivity.firstActivityAt = Math.max(0, Number(summary?.firstActivityAt || 0));
  arcActivity.lastActivityAt = Math.max(0, Number(summary?.lastActivityAt || 0));
  arcActivity.updatedAt = Math.max(0, Number(payload?.updatedAt || 0));
  arcActivity.stale = Boolean(payload?.stale);
  arcActivity.sourceLabel = String(payload?.sourceLabel || "");
  arcActivity.score = scorePulseWalletArcActivity(arcActivity);
  return arcActivity;
}

function applyArcWalletActivityToPulseWalletEntry(entry, payload = {}) {
  if (!entry) return null;
  const arcActivity = normalizePulseWalletArcActivity(payload);
  entry.arcActivity = arcActivity;
  notePulseWalletTimestamp(entry, arcActivity.firstActivityAt || arcActivity.updatedAt);
  return entry;
}

function formatPulseWalletActivity(entry) {
  const trackedVolumeUsdcRaw = Number((Number(entry.trackedVolumeUsdc || 0)).toFixed(2));
  const settledVolumeUsdcRaw = Number((Number(entry.settledVolumeUsdc || 0)).toFixed(2));
  const arcActivity = normalizePulseWalletArcActivity(entry.arcActivity || {});
  const appFootprint = formatPulseWalletAppFootprint(entry);
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
    + arcActivity.score
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
    mostUsedLane: resolvePulseLaneLabel(entry.laneCounts, entry.primaryLane || (totalTrackedActions > 0 ? "build" : "")),
    mostUsedApp: String(
      entry.mostUsedAppLabel
      || appFootprint[0]?.name
      || (totalTrackedActions > 0
        ? (String(entry.sourceScope || "").includes("indexed") ? "Indexed Arc app" : "AgentMarket")
        : (arcActivity.score > 0 ? "Arc wallet activity" : "Awaiting first signal"))
    ),
    appFootprint,
    sourceScope: String(entry.sourceScope || ""),
    sourceLabel: String(entry.sourceLabel || ""),
    arcActivityScore: arcActivity.score,
    arcTotalSentTransactions: arcActivity.totalSentTransactions,
    arcTotalWalletTouches: arcActivity.totalWalletTouches,
    arcContractsDeployed: arcActivity.contractsDeployed,
    arcUniqueContractsInteracted: arcActivity.uniqueContractsInteracted,
    arcActiveDays: arcActivity.activeDays,
    arcSuccessfulTransactions: arcActivity.successfulTransactions,
    arcFailedTransactions: arcActivity.failedTransactions,
    arcTotalFeesPaidUsdc: formatUsdc(arcActivity.totalFeesPaidUsdc),
    arcTotalFeesPaidUsdcRaw: arcActivity.totalFeesPaidUsdc,
    arcCurrentBalanceUsdc: formatUsdc(arcActivity.currentBalanceUsdc),
    arcCurrentBalanceUsdcRaw: arcActivity.currentBalanceUsdc,
    arcFirstActivityAt: arcActivity.firstActivityAt,
    arcLastActivityAt: arcActivity.lastActivityAt,
    arcUpdatedAt: arcActivity.updatedAt,
    arcSourceLabel: arcActivity.sourceLabel,
    arcStale: arcActivity.stale,
    activityScore,
  };
}

function describePulseArcIdBadge(summary, topPercent) {
  if (!summary.totalTrackedActions && !summary.points && !summary.arcActivityScore) return "Network Arrival";
  if (!summary.totalTrackedActions && !summary.points && summary.arcActivityScore >= 90) return "Arc Navigator";
  if (topPercent <= 10 || summary.activityScore >= 320) return "Arc Vanguard";
  if (summary.jobsCompleted > 0 && summary.jobsSettled > 0) return "Market Closer";
  if (summary.arcActivityScore >= 110 && summary.arcTotalSentTransactions >= 12) return "Chain Operator";
  if (topPercent <= 30 || summary.activityScore >= 180) return "Pulse Builder";
  if (summary.postsShared > 0 || summary.totalCheckIns > 0 || summary.arcTotalSentTransactions > 0) return "Signal Starter";
  return "Fresh Builder";
}

function isPulseWalletAnalyticsSkipped(skipWallets, wallet) {
  if (!(skipWallets instanceof Set)) return false;
  const canonicalWallet = String(wallet || "").toLowerCase();
  return Boolean(canonicalWallet && skipWallets.has(canonicalWallet));
}

function applyHostedPulseWalletAnalytics(snapshotState, analytics) {
  const items = Array.isArray(snapshotState?.walletAnalytics) ? snapshotState.walletAnalytics : [];
  if (!items.length) {
    return {
      usedHostedWalletOverlay: false,
      sourceScope: "",
      sourceLabel: "",
      coveredWallets: new Set(),
    };
  }

  const coveredWallets = new Set();
  for (const item of items) {
    const entry = ensurePulseWalletActivity(analytics, item.wallet);
    if (!entry) continue;

    coveredWallets.add(entry.wallet);
    const hasCustomDisplayName = Boolean(entry.displayName && entry.displayName !== shortWallet(entry.wallet));
    if (!hasCustomDisplayName && item.displayName) {
      entry.displayName = item.displayName;
    }

    entry.jobsAsClient = Number(item.jobsAsClient || 0);
    entry.jobsAsWorker = Number(item.jobsAsWorker || 0);
    entry.jobsCompleted = Number(item.jobsCompleted || 0);
    entry.jobsSettled = Number(item.jobsSettled || 0);
    entry.campaignsCreated = Number(item.campaignsCreated || 0);
    entry.trackedVolumeUsdc = Number(item.trackedVolumeUsdc || 0);
    entry.settledVolumeUsdc = Number(item.settledVolumeUsdc || 0);
    entry.sourceScope = String(item.sourceScope || "hosted-network-indexed");
    entry.sourceLabel = String(item.sourceLabel || snapshotState?.sourceLabel || "");
    entry.mostUsedAppLabel = String(item.mostUsedAppLabel || entry.mostUsedAppLabel || "");
    entry.primaryLane = String(item.primaryLane || entry.primaryLane || "");
    for (const app of item.appFootprint || []) {
      notePulseWalletAppAttribution(entry, {
        id: app.id,
        name: app.name,
      }, {
        trackedActions: app.trackedActions,
        trackedVolumeUsdc: app.trackedVolumeUsdc,
      });
      const usage = ensurePulseWalletAppUsage(entry, {
        id: app.id,
        name: app.name,
      });
      if (usage) {
        usage.contractLabels = [...new Set([...(usage.contractLabels || []), ...(app.contractLabels || [])])].slice(0, 4);
      }
    }
    notePulseWalletTimestamp(entry, item.memberSince);
  }

  return {
    usedHostedWalletOverlay: true,
    sourceScope: normalizePulseWalletAnalyticsSourceScope(snapshotState?.scope),
    sourceLabel: String(snapshotState?.sourceLabel || ""),
    coveredWallets,
  };
}

function applyIndexedPulseWalletAnalytics(db, analytics, skipWallets = null) {
  const liveContracts = getPulseIndexerLiveContracts();
  const contractConfigByAddress = getPulseIndexerLiveContractMap();
  const rows = getPulseIndexedContractRows(db, liveContracts);
  const indexedSourceScope = liveContracts.length > 1 ? "live-multi-contract-indexed" : "live-contract-indexed";
  const indexedSourceLabel = liveContracts.length > 1 ? "Arc RPC multi-contract indexer" : "Arc RPC event indexer";
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
    const contractAddress = String(row.contract_address || "").toLowerCase();
    const contractConfig = contractConfigByAddress.get(contractAddress) || {
      id: "agentmarket",
      name: "AgentMarket",
      contractLabel: shortWallet(contractAddress),
    };

    if (eventKey === "job_posted") {
      const clientEntry = isPulseWalletAnalyticsSkipped(skipWallets, row.wallet_primary)
        ? null
        : ensurePulseWalletActivity(analytics, row.wallet_primary);
      if (clientEntry) {
        clientEntry.jobsAsClient += 1;
        clientEntry.trackedVolumeUsdc += amountUsdc;
        clientEntry.sourceScope = indexedSourceScope;
        clientEntry.sourceLabel = indexedSourceLabel;
        notePulseWalletAppAttribution(clientEntry, contractConfig, { trackedActions: 1, trackedVolumeUsdc: amountUsdc });
        notePulseWalletTimestamp(clientEntry, eventTimestamp);
      }

      if (
        row.wallet_secondary
        && !sameAddress(row.wallet_secondary, ZERO_ADDRESS)
        && !isPulseWalletAnalyticsSkipped(skipWallets, row.wallet_secondary)
      ) {
        const workerEntry = ensurePulseWalletActivity(analytics, row.wallet_secondary);
        if (workerEntry) {
          workerEntry.jobsAsWorker += 1;
          workerEntry.trackedVolumeUsdc += amountUsdc;
          workerEntry.sourceScope = indexedSourceScope;
          workerEntry.sourceLabel = indexedSourceLabel;
          notePulseWalletAppAttribution(workerEntry, contractConfig, { trackedActions: 1, trackedVolumeUsdc: amountUsdc });
          notePulseWalletTimestamp(workerEntry, eventTimestamp);
        }
      }

      continue;
    }

    if (eventKey === "job_claimed") {
      if (isPulseWalletAnalyticsSkipped(skipWallets, row.wallet_primary)) continue;
      const workerEntry = ensurePulseWalletActivity(analytics, row.wallet_primary);
      if (!workerEntry) continue;
      const postedRow = jobPostsById.get(String(row.entity_id || ""));
      if (postedRow?.wallet_secondary && !sameAddress(postedRow.wallet_secondary, ZERO_ADDRESS)) continue;
      workerEntry.jobsAsWorker += 1;
      workerEntry.trackedVolumeUsdc += toUsdcNumber(postedRow?.amount_usdc || 0);
      workerEntry.sourceScope = indexedSourceScope;
      workerEntry.sourceLabel = indexedSourceLabel;
      notePulseWalletAppAttribution(workerEntry, contractConfig, {
        trackedActions: 1,
        trackedVolumeUsdc: toUsdcNumber(postedRow?.amount_usdc || 0),
      });
      notePulseWalletTimestamp(workerEntry, eventTimestamp);
      continue;
    }

    if (eventKey === "job_completed") {
      const workerEntry = isPulseWalletAnalyticsSkipped(skipWallets, row.wallet_primary)
        ? null
        : ensurePulseWalletActivity(analytics, row.wallet_primary);
      if (workerEntry) {
        workerEntry.jobsCompleted += 1;
        workerEntry.settledVolumeUsdc += amountUsdc;
        workerEntry.sourceScope = indexedSourceScope;
        workerEntry.sourceLabel = indexedSourceLabel;
        notePulseWalletAppAttribution(workerEntry, contractConfig, { trackedActions: 1, trackedVolumeUsdc: amountUsdc });
        notePulseWalletTimestamp(workerEntry, eventTimestamp);
      }

      const postedRow = jobPostsById.get(String(row.entity_id || ""));
      const clientEntry = isPulseWalletAnalyticsSkipped(skipWallets, postedRow?.wallet_primary || "")
        ? null
        : ensurePulseWalletActivity(analytics, postedRow?.wallet_primary || "");
      if (clientEntry) {
        clientEntry.jobsSettled += 1;
        clientEntry.settledVolumeUsdc += amountUsdc;
        clientEntry.sourceScope = indexedSourceScope;
        clientEntry.sourceLabel = indexedSourceLabel;
        notePulseWalletAppAttribution(clientEntry, contractConfig, { trackedActions: 1, trackedVolumeUsdc: amountUsdc });
        notePulseWalletTimestamp(clientEntry, eventTimestamp);
      }

      continue;
    }

    if (eventKey === "campaign_created") {
      if (isPulseWalletAnalyticsSkipped(skipWallets, row.wallet_primary)) continue;
      const creatorEntry = ensurePulseWalletActivity(analytics, row.wallet_primary);
      if (!creatorEntry) continue;
      creatorEntry.campaignsCreated += 1;
      creatorEntry.trackedVolumeUsdc += amountUsdc;
      creatorEntry.sourceScope = indexedSourceScope;
      creatorEntry.sourceLabel = indexedSourceLabel;
      notePulseWalletAppAttribution(creatorEntry, contractConfig, { trackedActions: 1, trackedVolumeUsdc: amountUsdc });
      notePulseWalletTimestamp(creatorEntry, eventTimestamp);
    }
  }

  return {
    usedIndexedContractRows: true,
    sourceScope: indexedSourceScope,
    sourceLabel: indexedSourceLabel,
  };
}

function buildPulseWalletAnalytics(db, jobs = [], campaigns = [], snapshotState = null) {
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

  const hostedState = applyHostedPulseWalletAnalytics(snapshotState, analytics);
  const skipWallets = hostedState.usedHostedWalletOverlay ? hostedState.coveredWallets : null;
  const indexedState = applyIndexedPulseWalletAnalytics(db, analytics, skipWallets);
  if (!indexedState.usedIndexedContractRows) {
    const trackedDescriptor = createDefaultPulseIndexerLiveContract();
    for (const job of jobs) {
      const budget = toUsdcNumber(job.budget);
      const createdAt = Number(job.createdAt || 0);

      if (
        job.client
        && !sameAddress(job.client, ZERO_ADDRESS)
        && !isPulseWalletAnalyticsSkipped(skipWallets, job.client)
      ) {
        const clientEntry = ensurePulseWalletActivity(analytics, job.client);
        if (clientEntry) {
          clientEntry.jobsAsClient += 1;
          clientEntry.trackedVolumeUsdc += budget;
          notePulseWalletAppAttribution(clientEntry, trackedDescriptor, { trackedActions: 1, trackedVolumeUsdc: budget });
          notePulseWalletTimestamp(clientEntry, createdAt);
        }
      }

      if (
        job.agent
        && !sameAddress(job.agent, ZERO_ADDRESS)
        && !isPulseWalletAnalyticsSkipped(skipWallets, job.agent)
      ) {
        const workerEntry = ensurePulseWalletActivity(analytics, job.agent);
        if (workerEntry) {
          workerEntry.jobsAsWorker += 1;
          workerEntry.trackedVolumeUsdc += budget;
          notePulseWalletAppAttribution(workerEntry, trackedDescriptor, { trackedActions: 1, trackedVolumeUsdc: budget });
          notePulseWalletTimestamp(workerEntry, createdAt);
        }
      }

      if (
        Number(job.status) === 3
        && job.agent
        && !sameAddress(job.agent, ZERO_ADDRESS)
        && !isPulseWalletAnalyticsSkipped(skipWallets, job.agent)
      ) {
        const workerEntry = ensurePulseWalletActivity(analytics, job.agent);
        if (workerEntry) {
          workerEntry.jobsCompleted += 1;
          workerEntry.settledVolumeUsdc += budget;
          notePulseWalletAppAttribution(workerEntry, trackedDescriptor, { trackedActions: 1, trackedVolumeUsdc: budget });
        }
      }

      if (
        Number(job.status) === 3
        && job.client
        && !sameAddress(job.client, ZERO_ADDRESS)
        && !isPulseWalletAnalyticsSkipped(skipWallets, job.client)
      ) {
        const clientEntry = ensurePulseWalletActivity(analytics, job.client);
        if (clientEntry) {
          clientEntry.jobsSettled += 1;
          clientEntry.settledVolumeUsdc += budget;
          notePulseWalletAppAttribution(clientEntry, trackedDescriptor, { trackedActions: 1, trackedVolumeUsdc: budget });
        }
      }
    }

    for (const campaign of campaigns) {
      if (
        !campaign.creator
        || sameAddress(campaign.creator, ZERO_ADDRESS)
        || isPulseWalletAnalyticsSkipped(skipWallets, campaign.creator)
      ) continue;
      const creatorEntry = ensurePulseWalletActivity(analytics, campaign.creator);
      if (!creatorEntry) continue;
      creatorEntry.campaignsCreated += 1;
      creatorEntry.trackedVolumeUsdc += toUsdcNumber(campaign.prizePool);
      notePulseWalletAppAttribution(creatorEntry, trackedDescriptor, {
        trackedActions: 1,
        trackedVolumeUsdc: toUsdcNumber(campaign.prizePool),
      });
      notePulseWalletTimestamp(creatorEntry, Number(campaign.createdAt || 0));
    }
  }

  return {
    analytics,
    usedHostedWalletOverlay: hostedState.usedHostedWalletOverlay,
    usedIndexedContractRows: indexedState.usedIndexedContractRows,
    sourceScope: hostedState.usedHostedWalletOverlay ? hostedState.sourceScope : indexedState.sourceScope,
    sourceLabel: hostedState.usedHostedWalletOverlay ? hostedState.sourceLabel : indexedState.sourceLabel,
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

function getAllPulseArcWalletActivityCaches(db) {
  const rows = db.prepare("SELECT wallet, payload_json, updated_at FROM pulse_arc_wallet_activity_cache").all();
  const caches = new Map();

  for (const row of rows) {
    if (!row?.wallet || !row?.payload_json) continue;
    try {
      const wallet = String(row.wallet || "").toLowerCase();
      const payload = JSON.parse(String(row.payload_json || "{}"));
      caches.set(wallet, createArcWalletActivityPayload(wallet, {
        ...payload,
        updatedAt: Number(row.updated_at || payload?.updatedAt || 0),
      }));
    } catch {}
  }

  return caches;
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
  const configuredSnapshot = await getConfiguredPulseIndexerSnapshot();
  const walletAnalytics = buildPulseWalletAnalytics(
    db,
    jobs,
    campaigns,
    configuredSnapshot?.connected ? configuredSnapshot : null,
  );
  const analyticsMap = walletAnalytics.analytics;
  const cachedArcActivityByWallet = getAllPulseArcWalletActivityCaches(db);
  const arcWalletActivity = await getArcWalletActivity(db, canonicalWallet);
  cachedArcActivityByWallet.set(canonicalWallet, arcWalletActivity);

  for (const [walletKey, payload] of cachedArcActivityByWallet.entries()) {
    const walletEntry = ensurePulseWalletActivity(analyticsMap, walletKey);
    if (!walletEntry) continue;
    applyArcWalletActivityToPulseWalletEntry(walletEntry, payload);
  }

  const entry = ensurePulseWalletActivity(analyticsMap, canonicalWallet) || createPulseWalletActivity(canonicalWallet);
  if (walletAnalytics.sourceScope) entry.sourceScope = walletAnalytics.sourceScope;
  if (walletAnalytics.sourceLabel) entry.sourceLabel = walletAnalytics.sourceLabel;
  const summary = formatPulseWalletActivity(entry);
  const unlockRecord = getPulseArcIdUnlockRecord(db, canonicalWallet);
  const unlockConfig = getArcIdUnlockConfig();
  const nftConfig = getArcIdNftConfig();
  const nftMintRecord = getPulseArcIdNftMintRecord(db, canonicalWallet);
  const onchainNftState = await getArcIdNftOnchainState(canonicalWallet);
  const unlockMode = unlockRecord?.tx_hash ? "paid-usdc" : (unlockRecord ? "beta-free" : "locked");
  const activityDetailsUnlocked = unlockMode === "paid-usdc";
  const indexedArcId = Boolean(walletAnalytics.usedIndexedContractRows || walletAnalytics.usedHostedWalletOverlay);
  const arcIdScope = walletAnalytics.sourceScope || (indexedArcId ? "indexed-live" : "tracked-beta");
  const arcIdSourceLabel = walletAnalytics.sourceLabel || (indexedArcId ? "Arc RPC event indexer" : "Tracked contract reads");

  const rankedWallets = [...analyticsMap.values()]
    .map(formatPulseWalletActivity)
    .filter(item => (
      item.totalTrackedActions > 0
      || item.points > 0
      || item.trackedVolumeUsdcRaw > 0
      || item.memberSince > 0
      || item.arcActivityScore > 0
      || item.arcTotalSentTransactions > 0
    ));

  if (!rankedWallets.some(item => sameAddress(item.wallet, canonicalWallet))) {
    rankedWallets.push(summary);
  }

  rankedWallets.sort((a, b) => (
    b.activityScore - a.activityScore
    || b.arcActivityScore - a.arcActivityScore
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
      score: summary.activityScore,
      arcScore: summary.arcActivityScore,
      label: (!summary.totalTrackedActions && !summary.points && summary.arcActivityScore > 0)
        ? (totalRanked > 1 ? `Top ${topPercent}% Arc wallet` : "Arc wallet pioneer")
        : (totalRanked > 1
          ? `Top ${topPercent}% ${indexedArcId ? "indexed builder" : "builder"}`
          : (indexedArcId ? "Indexed founding builder" : "Founding builder")),
    },
    teaser: {
      activityScore: summary.activityScore,
      arcActivityScore: summary.arcActivityScore,
      arcSentTransactions: summary.arcTotalSentTransactions,
      arcActiveDays: summary.arcActiveDays,
      arcContractsDeployed: summary.arcContractsDeployed,
      points: summary.points,
      trackedActions: summary.totalTrackedActions,
      trackedVolumeUsdc: summary.trackedVolumeUsdc,
      settledVolumeUsdc: summary.settledVolumeUsdc,
      currentStreak: summary.currentStreak,
    },
    profile: summary,
    notes: [
      walletAnalytics.usedHostedWalletOverlay
        ? `Arc ID now ranks this wallet from hosted multi-app activity through ${arcIdSourceLabel}.`
        : indexedArcId
        ? `Arc ID now ranks this wallet from indexed AgentMarket activity through ${arcIdSourceLabel}.`
        : "Arc ID beta is based on tracked AgentMarket and ArcPulse activity right now.",
      unlockConfig.enabled
        ? `A ${ARC_ID_UNLOCK_PRICE_USDC} USDC transfer on Arc now unlocks and verifies this card, plus the deeper Arc wallet activity details.`
        : "Configure an Arc ID unlock recipient on the server to turn the paid unlock live.",
      nftConfig.enabled
        ? `Season 1 Arc ID NFT minting is live at ${ARC_ID_NFT_MINT_PRICE_USDC} USDC after a paid unlock.`
        : "Deploy and configure the Arc ID NFT contract to turn the collectible mint live.",
      walletAnalytics.usedHostedWalletOverlay
        ? "Wallet ranking now blends hosted multi-app wallet analytics, Pulse streaks, community activity, and broader Arc wallet behavior."
        : indexedArcId
        ? "Wallet ranking now blends indexed jobs, claims, completions, settlement volume, Pulse streaks, community activity, and broader Arc wallet behavior."
        : "Arc ID now layers Arc wallet behavior into the tracked AgentMarket, streak, and community model.",
      summary.appFootprint?.length
        ? `Wallet-level attribution is now live across ${summary.appFootprint.length} tracked app slice${summary.appFootprint.length === 1 ? "" : "s"}, led by ${summary.appFootprint[0].name}.`
        : "Wallet-level attribution will deepen as more Arc app slices are connected to Pulse.",
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
    agentAutomation: {
      summaryBotEnabled: SUMMARY_AGENT_ENABLED,
      maxBudgetUsdc: formatUsdc(SUMMARY_AGENT_MAX_BUDGET_USDC),
      maxConcurrentJobs: SUMMARY_AGENT_MAX_CONCURRENT_JOBS,
      publicBaseUrl: resolvePublicApiBaseUrl(),
    },
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

app.get("/api/agents/:agentKey/metadata", async (req, res) => {
  if (String(req.params.agentKey || "").toLowerCase() !== AGENT_KEYS.summary) {
    return res.status(404).json({ error: "Unknown agent" });
  }

  try {
    const db = await ensurePulseDatabase();
    res.json(buildSummaryBotMetadata(db));
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load SummaryBot metadata" });
  }
});

app.get("/api/agents/:agentKey/status", async (req, res) => {
  if (String(req.params.agentKey || "").toLowerCase() !== AGENT_KEYS.summary) {
    return res.status(404).json({ error: "Unknown agent" });
  }

  try {
    const db = await ensurePulseDatabase();
    const registration = getAgentRegistration(db, AGENT_KEYS.summary);
    res.json({
      ...getSummaryBotCatalogEntry(db),
      runtime: {
        bootstrapped: summaryAgentRuntime.bootstrapped,
        running: summaryAgentRuntime.running,
        lastStartedAt: summaryAgentRuntime.lastStartedAt,
        lastCompletedAt: summaryAgentRuntime.lastCompletedAt,
        lastError: summaryAgentRuntime.lastError,
      },
      registration,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load SummaryBot status" });
  }
});

app.get("/api/agents/:agentKey/jobs/:jobId/deliverable", async (req, res) => {
  if (String(req.params.agentKey || "").toLowerCase() !== AGENT_KEYS.summary) {
    return res.status(404).json({ error: "Unknown agent" });
  }

  try {
    const db = await ensurePulseDatabase();
    const run = req.query?.run
      ? getAgentRunById(db, req.query.run)
      : getAgentRunByJobId(db, AGENT_KEYS.summary, req.params.jobId);
    if (!run?.result || !run.result.summary) {
      return res.status(404).json({ error: "Deliverable not found" });
    }

    const payload = {
      jobId: run.jobId,
      agentKey: run.agentKey,
      jobTitle: run.jobTitle,
      generatedAt: run.result.generatedAt || run.updatedAt,
      summary: run.result.summary,
      sourceUrls: Array.isArray(run.result.sourceUrls) ? run.result.sourceUrls : [],
      model: run.result.model || SUMMARY_AGENT_MODEL,
      deliverableLocator: run.deliverableLocator,
      submitTxHash: run.submitTxHash,
    };

    const acceptsHtml = String(req.headers.accept || "").includes("text/html");
    if (!acceptsHtml) return res.json(payload);

    const list = payload.sourceUrls.length
      ? `<ul>${payload.sourceUrls.map(url => `<li><a href="${escapeAgentHtml(url)}" target="_blank" rel="noreferrer">${escapeAgentHtml(url)}</a></li>`).join("")}</ul>`
      : "<p>No external public URLs were attached to this job.</p>";

    res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SummaryBot Deliverable #${Number(payload.jobId)}</title>
    <style>
      body { font-family: Georgia, serif; margin: 0; background: #f7f4ee; color: #1b1b1b; }
      main { max-width: 820px; margin: 0 auto; padding: 40px 24px 72px; }
      .kicker { font: 600 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.12em; text-transform: uppercase; color: #7a6a58; }
      h1 { font-size: 34px; line-height: 1.1; margin: 10px 0 12px; }
      .meta { color: #695d50; margin-bottom: 28px; }
      .card { background: #fff; border: 1px solid #ded5c6; border-radius: 18px; padding: 24px; box-shadow: 0 10px 30px rgba(44, 36, 22, 0.06); }
      h2 { font-size: 18px; margin-top: 0; }
      pre { white-space: pre-wrap; word-break: break-word; font: 15px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; }
      a { color: #245f9f; }
    </style>
  </head>
  <body>
    <main>
      <div class="kicker">AgentMarket SummaryBot</div>
      <h1>${escapeAgentHtml(payload.jobTitle || `Job #${payload.jobId}`)}</h1>
      <div class="meta">Generated ${escapeAgentHtml(new Date(Number(payload.generatedAt || Date.now())).toUTCString())}${payload.submitTxHash ? ` · <a href="${ARC_EXPLORER_URL}/tx/${escapeAgentHtml(payload.submitTxHash)}" target="_blank" rel="noreferrer">Arc tx</a>` : ""}</div>
      <section class="card">
        <h2>Deliverable</h2>
        <pre>${escapeAgentHtml(payload.summary)}</pre>
      </section>
      <section class="card" style="margin-top:20px">
        <h2>Public sources</h2>
        ${list}
      </section>
    </main>
  </body>
</html>`);
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load the SummaryBot deliverable" });
  }
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

app.get("/api/agents", async (req, res) => {
  try {
    const db = await ensurePulseDatabase();
    res.json([
      getSummaryBotCatalogEntry(db),
    ]);
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load agents" });
  }
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
    startSummaryAgentLoop();
  });
}

export default app;
