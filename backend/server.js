import express from "express";
import cors from "cors";
import { createPublicClient, http, formatUnits } from "viem";
import { arcTestnet } from "viem/chains";
import dotenv from "dotenv";

dotenv.config();

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

const STATUS_LABELS = ["Open","Funded","Submitted","Completed","Rejected"];
const WORKER_TYPES = ["AI","Human"];
const COMPLETED_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────
function sameAddress(a, b) {
  return a?.toLowerCase() === b?.toLowerCase();
}

function toUsdcNumber(value) {
  const amount = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(amount) ? amount : 0;
}

function formatUsdc(value) {
  return toUsdcNumber(value).toFixed(2);
}

function utcDayKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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

async function getPulseSnapshot() {
  const [jobs, campaigns, recentBlocks] = await Promise.all([
    getAllFormattedJobs(),
    getAllFormattedCampaigns(),
    getRecentBlocks(),
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
    },
    recentBlocks,
    volume14d: buildPulseSeries(jobs),
    categoryBreakdown: buildCategoryBreakdown(activeJobs),
    appRankings: buildTrackedAppRankings(jobs, campaigns),
    notes: [
      "Live Arc blocks come directly from the Arc RPC endpoint.",
      "Volume, categories, and rankings are currently tracked from the AgentMarket contracts only.",
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
