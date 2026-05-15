/**
 * AgentMarket Backend — Arc Testnet
 *
 * What this does:
 * - Serves job and agent data from the AgentJobBoard contract
 * - Manages SummaryBot: ERC-8004 identity registration, job polling, execution, deliverable submission
 * - Records ERC-8004 reputation after client approval
 * - Serves deliverable HTML pages so clients can read agent output
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "fs";
import { createPublicClient, http, formatUnits, parseAbiItem, parseEventLogs, keccak256, toBytes } from "viem";
import { arcTestnet } from "viem/chains";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3001", 10);
const JOB_BOARD_ADDRESS = process.env.JOB_BOARD_ADDRESS || "";
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ARC_EXPLORER_URL = "https://testnet.arcscan.app";

const CIRCLE_API_KEY = (process.env.CIRCLE_API_KEY || "").trim();
const CIRCLE_ENTITY_SECRET = (process.env.CIRCLE_ENTITY_SECRET || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const PUBLIC_API_BASE_URL = (process.env.AGENTMARKET_PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
const AGENT_LOOP_MS = Math.max(15_000, parseInt(process.env.AGENT_LOOP_MS || "20000", 10));
const AGENT_MAX_BUDGET_USDC = Math.max(1, parseFloat(process.env.AGENT_MAX_BUDGET_USDC || "50"));
const ARC_BLOCKCHAIN_ID = "ARC-TESTNET";

// ─── Arc RPC ──────────────────────────────────────────────────────

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http("https://rpc.testnet.arc.network"),
});

// ─── ABIs ─────────────────────────────────────────────────────────

const JOB_BOARD_ABI = [
  {
    name: "getAllJobs", type: "function", stateMutability: "view",
    inputs: [],
    outputs: [{
      type: "tuple[]", components: [
        { name: "id", type: "uint256" },
        { name: "client", type: "address" },
        { name: "agent", type: "address" },
        { name: "title", type: "string" },
        { name: "description", type: "string" },
        { name: "category", type: "string" },
        { name: "budget", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "status", type: "uint8" },
        { name: "deliverableUrl", type: "string" },
        { name: "createdAt", type: "uint256" },
        { name: "completedAt", type: "uint256" },
      ]
    }],
  },
  {
    name: "getJob", type: "function", stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{
      type: "tuple", components: [
        { name: "id", type: "uint256" },
        { name: "client", type: "address" },
        { name: "agent", type: "address" },
        { name: "title", type: "string" },
        { name: "description", type: "string" },
        { name: "category", type: "string" },
        { name: "budget", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "status", type: "uint8" },
        { name: "deliverableUrl", type: "string" },
        { name: "createdAt", type: "uint256" },
        { name: "completedAt", type: "uint256" },
      ]
    }],
  },
  {
    name: "getClientJobs", type: "function", stateMutability: "view",
    inputs: [{ name: "client", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "getAgentJobs", type: "function", stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "jobCount", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "platformFeeBps", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
];

const IDENTITY_ABI = [
  { name: "register", type: "function", stateMutability: "nonpayable", inputs: [{ name: "metadataURI", type: "string" }], outputs: [] },
  { name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { name: "tokenURI", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
];

// ─── Helpers ──────────────────────────────────────────────────────

const STATUS_LABELS = ["Open", "Funded", "Submitted", "Completed", "Rejected"];

function sameAddr(a, b) { return a?.toLowerCase() === b?.toLowerCase(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt6(v) { return parseFloat(formatUnits(BigInt(v || 0), 6)).toFixed(2); }

function formatJob(j) {
  const status = Number(j.status);
  const deadline = Number(j.deadline) * 1000;
  const now = Date.now();
  return {
    id: Number(j.id),
    client: j.client,
    agent: j.agent,
    title: j.title,
    description: j.description,
    category: j.category,
    budget: fmt6(j.budget),
    budgetRaw: j.budget.toString(),
    status,
    statusLabel: STATUS_LABELS[status] ?? "Unknown",
    isExpired: deadline > 0 && [0, 1].includes(status) && now > deadline,
    deliverableUrl: j.deliverableUrl,
    createdAt: Number(j.createdAt) * 1000,
    completedAt: Number(j.completedAt) * 1000,
    deadline,
    explorerUrl: `${ARC_EXPLORER_URL}/address/${JOB_BOARD_ADDRESS}`,
  };
}

async function getAllJobs() {
  if (!JOB_BOARD_ADDRESS) return [];
  const raw = await publicClient.readContract({
    address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI, functionName: "getAllJobs",
  });
  return raw.map(formatJob);
}

async function getJobById(id) {
  const raw = await publicClient.readContract({
    address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI,
    functionName: "getJob", args: [BigInt(id)],
  });
  return formatJob(raw);
}

// ─── Database ─────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, "..", "cache", "agentmarket.sqlite");
let _db = null;

async function getDb() {
  if (_db) return _db;
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_wallets (
      agent_key   TEXT NOT NULL,
      wallet_role TEXT NOT NULL,
      wallet_id   TEXT NOT NULL DEFAULT '',
      wallet_address TEXT NOT NULL DEFAULT '',
      wallet_set_id  TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (agent_key, wallet_role)
    );

    CREATE TABLE IF NOT EXISTS agent_identity (
      agent_key        TEXT PRIMARY KEY,
      identity_token_id TEXT NOT NULL DEFAULT '',
      identity_tx_hash  TEXT NOT NULL DEFAULT '',
      metadata_uri      TEXT NOT NULL DEFAULT '',
      validation_status INTEGER NOT NULL DEFAULT -1,
      validation_request_hash TEXT NOT NULL DEFAULT '',
      validation_tx_hash      TEXT NOT NULL DEFAULT '',
      registered_at    INTEGER NOT NULL DEFAULT 0,
      validated_at     INTEGER NOT NULL DEFAULT 0,
      updated_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id              TEXT PRIMARY KEY,
      job_id          INTEGER NOT NULL UNIQUE,
      job_title       TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'pending',
      deliverable_url TEXT NOT NULL DEFAULT '',
      deliverable_text TEXT NOT NULL DEFAULT '',
      submit_tx_hash  TEXT NOT NULL DEFAULT '',
      reputation_tx_hash TEXT NOT NULL DEFAULT '',
      error           TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_job_id ON agent_runs(job_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status, updated_at DESC);
  `);

  _db = db;
  return db;
}

function metaGet(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? "";
}
function metaSet(db, key, value) {
  db.prepare(`
    INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), Date.now());
}

function getWallet(db, agentKey, role) {
  return db.prepare("SELECT * FROM agent_wallets WHERE agent_key = ? AND wallet_role = ?")
    .get(agentKey, role) ?? null;
}
function saveWallet(db, agentKey, role, { walletId, walletAddress, walletSetId }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO agent_wallets (agent_key, wallet_role, wallet_id, wallet_address, wallet_set_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_key, wallet_role) DO UPDATE SET
      wallet_id = excluded.wallet_id,
      wallet_address = excluded.wallet_address,
      wallet_set_id = excluded.wallet_set_id,
      updated_at = excluded.updated_at
  `).run(agentKey, role, walletId, walletAddress.toLowerCase(), walletSetId, now, now);
  return getWallet(db, agentKey, role);
}

function getIdentity(db, agentKey) {
  return db.prepare("SELECT * FROM agent_identity WHERE agent_key = ?").get(agentKey) ?? null;
}
function saveIdentity(db, agentKey, payload) {
  const now = Date.now();
  const ex = getIdentity(db, agentKey);
  db.prepare(`
    INSERT INTO agent_identity (agent_key, identity_token_id, identity_tx_hash, metadata_uri, validation_status, validation_request_hash, validation_tx_hash, registered_at, validated_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_key) DO UPDATE SET
      identity_token_id = excluded.identity_token_id,
      identity_tx_hash  = excluded.identity_tx_hash,
      metadata_uri      = excluded.metadata_uri,
      validation_status = excluded.validation_status,
      validation_request_hash = excluded.validation_request_hash,
      validation_tx_hash = excluded.validation_tx_hash,
      registered_at     = excluded.registered_at,
      validated_at      = excluded.validated_at,
      updated_at        = excluded.updated_at
  `).run(
    agentKey,
    payload.identity_token_id ?? ex?.identity_token_id ?? "",
    payload.identity_tx_hash ?? ex?.identity_tx_hash ?? "",
    payload.metadata_uri ?? ex?.metadata_uri ?? "",
    payload.validation_status ?? ex?.validation_status ?? -1,
    payload.validation_request_hash ?? ex?.validation_request_hash ?? "",
    payload.validation_tx_hash ?? ex?.validation_tx_hash ?? "",
    payload.registered_at ?? ex?.registered_at ?? 0,
    payload.validated_at ?? ex?.validated_at ?? 0,
    now,
  );
  return getIdentity(db, agentKey);
}

function getRun(db, jobId) {
  return db.prepare("SELECT * FROM agent_runs WHERE job_id = ?").get(Number(jobId)) ?? null;
}
function saveRun(db, payload) {
  const now = Date.now();
  const ex = payload.id ? db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(payload.id) : getRun(db, payload.job_id);
  const id = ex?.id ?? payload.id ?? randomUUID();
  db.prepare(`
    INSERT INTO agent_runs (id, job_id, job_title, status, deliverable_url, deliverable_text, submit_tx_hash, reputation_tx_hash, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      job_id          = excluded.job_id,
      job_title       = excluded.job_title,
      status          = excluded.status,
      deliverable_url = excluded.deliverable_url,
      deliverable_text = excluded.deliverable_text,
      submit_tx_hash  = excluded.submit_tx_hash,
      reputation_tx_hash = excluded.reputation_tx_hash,
      error           = excluded.error,
      updated_at      = excluded.updated_at
  `).run(
    id,
    payload.job_id ?? ex?.job_id ?? 0,
    payload.job_title ?? ex?.job_title ?? "",
    payload.status ?? ex?.status ?? "pending",
    payload.deliverable_url ?? ex?.deliverable_url ?? "",
    payload.deliverable_text ?? ex?.deliverable_text ?? "",
    payload.submit_tx_hash ?? ex?.submit_tx_hash ?? "",
    payload.reputation_tx_hash ?? ex?.reputation_tx_hash ?? "",
    payload.error ?? ex?.error ?? "",
    ex?.created_at ?? now,
    now,
  );
  return db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id);
}

// ─── Circle client ─────────────────────────────────────────────────

let _circleClient = null;
function getCircle() {
  if (!CIRCLE_API_KEY || !CIRCLE_ENTITY_SECRET) return null;
  if (!_circleClient) {
    _circleClient = initiateDeveloperControlledWalletsClient({
      apiKey: CIRCLE_API_KEY,
      entitySecret: CIRCLE_ENTITY_SECRET,
    });
  }
  return _circleClient;
}

async function waitForCircleTx(txId, { timeoutMs = 120_000, pollMs = 2_500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    const { data } = await getCircle().getTransaction({ id: txId });
    const tx = data?.transaction;
    const state = String(tx?.state || "").toUpperCase();
    if (state === "COMPLETE") return tx;
    if (["FAILED", "CANCELLED", "DENIED"].includes(state)) {
      throw new Error(tx?.errorReason || `Circle tx ${state}`);
    }
  }
  throw new Error(`Timed out waiting for Circle tx ${txId}`);
}

async function circleContractCall(walletId, contractAddress, sig, params, idempotencyKey) {
  const circle = getCircle();
  const res = await circle.createContractExecutionTransaction({
    walletId,
    blockchain: ARC_BLOCKCHAIN_ID,
    contractAddress,
    abiFunctionSignature: sig,
    abiParameters: params,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  const txId = res?.data?.id;
  if (!txId) throw new Error("Circle did not return a transaction id");
  return waitForCircleTx(txId);
}

// ─── SummaryBot ERC-8004 Identity ─────────────────────────────────

const AGENT_KEY = "summarybot";

function getSummaryBotMetadataUri() {
  return PUBLIC_API_BASE_URL ? `${PUBLIC_API_BASE_URL}/api/agents/summarybot/metadata` : "";
}

function buildSummaryBotMetadata() {
  return {
    name: "SummaryBot",
    description: "Autonomous AI summarization and research agent on AgentMarket (Arc Testnet).",
    agent_type: "summarization",
    capabilities: ["summarize", "research", "analyze", "write"],
    version: "2.0.0",
  };
}

async function resolveIdentityTokenId(ownerAddress) {
  const latest = await publicClient.getBlockNumber();
  const from = latest > 10_000n ? latest - 10_000n : 0n;
  const logs = await publicClient.getLogs({
    address: IDENTITY_REGISTRY,
    event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"),
    args: { to: ownerAddress },
    fromBlock: from,
    toBlock: latest,
  });
  return logs.length ? String(logs[logs.length - 1].args.tokenId) : "";
}

async function ensureAgentWallets(db) {
  const circle = getCircle();
  if (!circle) throw new Error("Circle credentials not configured (CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET)");

  const existingOwner = getWallet(db, AGENT_KEY, "owner");
  const existingValidator = getWallet(db, AGENT_KEY, "validator");
  if (existingOwner?.wallet_id && existingValidator?.wallet_id) {
    return { owner: existingOwner, validator: existingValidator };
  }

  let walletSetId = existingOwner?.wallet_set_id || existingValidator?.wallet_set_id || "";
  if (!walletSetId) {
    const wsRes = await circle.createWalletSet({
      name: "AgentMarket SummaryBot",
      idempotencyKey: "agentmarket-summarybot-walletset-v2",
    });
    walletSetId = wsRes?.data?.walletSet?.id;
    if (!walletSetId) throw new Error("Circle did not return walletSetId");
  }

  const walletsRes = await circle.createWallets({
    blockchains: [ARC_BLOCKCHAIN_ID],
    count: 2,
    walletSetId,
    accountType: "SCA",
    idempotencyKey: "agentmarket-summarybot-wallets-v2",
  });
  const [ownerRaw, validatorRaw] = walletsRes?.data?.wallets ?? [];
  if (!ownerRaw?.id || !validatorRaw?.id) throw new Error("Circle did not return 2 wallets");

  const owner = saveWallet(db, AGENT_KEY, "owner", { walletId: ownerRaw.id, walletAddress: ownerRaw.address, walletSetId });
  const validator = saveWallet(db, AGENT_KEY, "validator", { walletId: validatorRaw.id, walletAddress: validatorRaw.address, walletSetId });
  return { owner, validator };
}

async function ensureWallets(db) {
  const circle = getCircle();
  if (!circle) throw new Error("Circle not configured");

  // Use pre-created wallets from environment variables
  const ownerWalletId = process.env.AGENT_OWNER_WALLET_ID;
  const ownerWalletAddress = process.env.AGENT_OWNER_WALLET_ADDRESS;
  const validatorWalletId = process.env.AGENT_VALIDATOR_WALLET_ID;
  const validatorWalletAddress = process.env.AGENT_VALIDATOR_WALLET_ADDRESS;
  const walletSetId = process.env.AGENT_WALLET_SET_ID;

  if (!ownerWalletId || !validatorWalletId) {
    throw new Error("Agent wallet IDs not configured in environment");
  }

  const owner = saveWallet(db, AGENT_KEY, "owner", {
    walletId: ownerWalletId,
    walletAddress: ownerWalletAddress,
    walletSetId: walletSetId,
  });

  const validator = saveWallet(db, AGENT_KEY, "validator", {
    walletId: validatorWalletId,
    walletAddress: validatorWalletAddress,
    walletSetId: walletSetId,
  });

  return { owner, validator };
}

const tokenId = await resolveIdentityTokenId(owner.wallet_address);
if (!tokenId) throw new Error("Could not find ERC-8004 token after registration");

console.log(`[SummaryBot] Identity registered. Token ID: ${tokenId}`);
return saveIdentity(db, AGENT_KEY, {
  identity_token_id: tokenId,
  identity_tx_hash: tx.txHash ?? "",
  metadata_uri: metadataUri,
  registered_at: Date.now(),
});
}

async function ensureAgentValidation(db) {
  const identity = await ensureAgentIdentity(db);
  if (identity.validation_status === 100) return identity;

  const { owner, validator } = await ensureAgentWallets(db);
  const requestHash = identity.validation_request_hash ||
    keccak256(toBytes(`summarybot_validation_${identity.identity_token_id}`));

  console.log("[SummaryBot] Requesting ERC-8004 validation…");
  await circleContractCall(
    owner.wallet_id,
    VALIDATION_REGISTRY,
    "validationRequest(address,uint256,string,bytes32)",
    [validator.wallet_address, identity.identity_token_id, identity.metadata_uri, requestHash],
    "agentmarket-summarybot-validation-request-v2",
  );

  const responseTx = await circleContractCall(
    validator.wallet_id,
    VALIDATION_REGISTRY,
    "validationResponse(bytes32,uint8,string,bytes32,string)",
    [requestHash, 100, identity.metadata_uri, `0x${"0".repeat(64)}`, "platform_verified"],
    "agentmarket-summarybot-validation-response-v2",
  );

  console.log("[SummaryBot] Validation complete.");
  return saveIdentity(db, AGENT_KEY, {
    validation_status: 100,
    validation_request_hash: requestHash,
    validation_tx_hash: responseTx.txHash ?? "",
    validated_at: Date.now(),
  });
}

// ─── SummaryBot Job Execution ──────────────────────────────────────

async function fetchUrl(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "AgentMarket SummaryBot/2.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    if (ct.includes("html")) {
      return raw.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 10_000);
    }
    return raw.slice(0, 10_000);
  } finally {
    clearTimeout(t);
  }
}

function extractUrls(text) {
  return [...new Set((text.match(/https?:\/\/[^\s)>]+/gi) ?? []).map(u => u.replace(/[.,;!?]+$/, "")))]
    .slice(0, 3);
}

async function runLLM(systemPrompt, userPrompt) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 1500,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function executeJob(job) {
  const urls = extractUrls(job.description);
  const sources = [];
  for (const url of urls) {
    try { sources.push({ url, text: await fetchUrl(url) }); }
    catch { sources.push({ url, text: "(could not fetch)" }); }
  }

  const sourceSection = sources.length
    ? sources.map((s, i) => `Source ${i + 1}: ${s.url}\n${s.text}`).join("\n\n")
    : "";

  const systemPrompt = [
    "You are SummaryBot, an autonomous AI agent on AgentMarket running on Arc Testnet.",
    "You complete jobs for clients who post summarization, research, and analysis tasks.",
    "Produce a clean, professional deliverable. Be factual and concrete.",
    "Structure your response with these sections: ## Summary, ## Key Findings, ## Action Items.",
    "If sources were provided, reference them. If information is missing, say so clearly.",
  ].join(" ");

  const userPrompt = [
    `Job Title: ${job.title}`,
    `Category: ${job.category}`,
    `Client Request:\n${job.description}`,
    sourceSection ? `\n\nFetched Sources:\n${sourceSection}` : "",
  ].join("\n");

  return runLLM(systemPrompt, userPrompt);
}

async function submitDeliverable(db, job, text) {
  const { owner } = await ensureAgentWallets(db);
  const runId = getRun(db, job.id)?.id ?? randomUUID();

  // Store the deliverable text first so the URL works
  saveRun(db, {
    id: runId,
    job_id: job.id,
    job_title: job.title,
    status: "submitting",
    deliverable_text: text,
    deliverable_url: "",
  });

  const deliverableUrl = `${PUBLIC_API_BASE_URL}/api/agents/summarybot/jobs/${job.id}/deliverable`;

  const tx = await circleContractCall(
    owner.wallet_id,
    JOB_BOARD_ADDRESS,
    "submitDeliverable(uint256,string)",
    [Number(job.id), deliverableUrl],
    `agentmarket-summarybot-submit-job-${job.id}`,
  );

  return saveRun(db, {
    id: runId,
    status: "submitted",
    deliverable_url: deliverableUrl,
    submit_tx_hash: tx.txHash ?? "",
  });
}

async function recordReputation(db, job) {
  const { validator } = await ensureAgentWallets(db);
  const identity = getIdentity(db, AGENT_KEY);
  if (!identity?.identity_token_id) return;

  const run = getRun(db, job.id);
  if (!run || run.reputation_tx_hash) return;

  const onTime = job.completedAt > 0 && job.deadline > 0 && job.completedAt <= job.deadline;
  const score = onTime ? 95 : 80;
  const tag = onTime ? "job_completed_on_time" : "job_completed_late";
  const feedbackHash = keccak256(toBytes(`${tag}:${job.id}`));

  console.log(`[SummaryBot] Recording ERC-8004 reputation for job #${job.id}…`);
  const tx = await circleContractCall(
    validator.wallet_id,
    REPUTATION_REGISTRY,
    "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
    [
      identity.identity_token_id,
      String(score),
      "0",
      tag,
      identity.metadata_uri,
      run.deliverable_url,
      `SummaryBot completed job #${job.id}`,
      feedbackHash,
    ],
    `agentmarket-summarybot-reputation-job-${job.id}`,
  );

  saveRun(db, { id: run.id, reputation_tx_hash: tx.txHash ?? "", status: "completed" });
  console.log(`[SummaryBot] Reputation recorded. Score: ${score}, Tx: ${tx.txHash}`);
}

// ─── Agent Loop ───────────────────────────────────────────────────

let agentRunning = false;
let agentBootstrapped = false;
const agentRuntime = { lastError: "", lastCycleAt: 0 };

async function runAgentCycle() {
  if (agentRunning) return;
  agentRunning = true;
  try {
    const db = await getDb();

    // Bootstrap: ensure wallets, identity, validation
    if (!agentBootstrapped) {
      await ensureAgentValidation(db);
      agentBootstrapped = true;
      console.log("[SummaryBot] Bootstrap complete. Ready to take jobs.");
    }

    const { owner } = await ensureAgentWallets(db);
    const jobs = await getAllJobs();

    // Record reputation for any completed jobs
    for (const job of jobs.filter(j => j.status === 3 && sameAddr(j.agent, owner.wallet_address))) {
      await recordReputation(db, job).catch(err => console.warn("[SummaryBot] Reputation error:", err.message));
    }

    // Find jobs assigned to us that are Funded and not yet processed
    const candidates = jobs.filter(j =>
      j.status === 1 &&                              // Funded
      sameAddr(j.agent, owner.wallet_address) &&     // assigned to us
      !getRun(db, j.id) &&                           // not yet started
      !j.isExpired &&
      parseFloat(j.budget) <= AGENT_MAX_BUDGET_USDC
    );

    for (const job of candidates) {
      console.log(`[SummaryBot] Picked up job #${job.id}: "${job.title}"`);
      try {
        saveRun(db, { job_id: job.id, job_title: job.title, status: "running" });
        const text = await executeJob(job);
        await submitDeliverable(db, job, text);
        console.log(`[SummaryBot] Delivered job #${job.id}`);
      } catch (err) {
        console.error(`[SummaryBot] Failed job #${job.id}:`, err.message);
        const run = getRun(db, job.id);
        saveRun(db, { id: run?.id, job_id: job.id, status: "failed", error: err.message });
      }
    }

    agentRuntime.lastError = "";
    agentRuntime.lastCycleAt = Date.now();
  } catch (err) {
    agentRuntime.lastError = err.message;
    console.warn("[SummaryBot] Cycle error:", err.message);
  } finally {
    agentRunning = false;
  }
}

function startAgentLoop() {
  runAgentCycle().catch(() => { });
  setInterval(() => {
    if (!agentRunning) runAgentCycle().catch(() => { });
  }, AGENT_LOOP_MS);
}

// ─── Express App ──────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// ─── Health ───────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    network: "Arc Testnet",
    contract: JOB_BOARD_ADDRESS,
    agent: { bootstrapped: agentBootstrapped, running: agentRunning, lastError: agentRuntime.lastError },
  });
});

// ─── Config ───────────────────────────────────────────────────────

app.get("/api/config", (req, res) => {
  res.json({
    jobBoardAddress: JOB_BOARD_ADDRESS,
    usdcAddress: USDC_ADDRESS,
    explorerUrl: ARC_EXPLORER_URL,
    identityRegistry: IDENTITY_REGISTRY,
    reputationRegistry: REPUTATION_REGISTRY,
  });
});

// ─── Jobs ─────────────────────────────────────────────────────────

app.get("/api/jobs", async (req, res) => {
  try {
    const jobs = await getAllJobs();
    res.json(jobs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/jobs/:id", async (req, res) => {
  try {
    res.json(await getJobById(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/client/:address/jobs", async (req, res) => {
  try {
    const all = await getAllJobs();
    res.json(all.filter(j => sameAddr(j.client, req.params.address)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/stats", async (req, res) => {
  try {
    const jobs = await getAllJobs();
    const completed = jobs.filter(j => j.status === 3);
    const volume = completed.reduce((s, j) => s + parseFloat(j.budget), 0);
    res.json({
      totalJobs: jobs.length,
      completedJobs: completed.length,
      openJobs: jobs.filter(j => j.status === 1).length,
      totalVolumeUsdc: volume.toFixed(2),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Agents ───────────────────────────────────────────────────────

app.get("/api/agents", async (req, res) => {
  try {
    const db = await getDb();
    const owner = getWallet(db, AGENT_KEY, "owner");
    const identity = getIdentity(db, AGENT_KEY);
    const recentRuns = db.prepare("SELECT * FROM agent_runs ORDER BY updated_at DESC LIMIT 10").all();

    res.json([{
      id: "summarybot",
      name: "SummaryBot",
      description: "Autonomous AI summarization, research, and analysis agent. Posts jobs to me and I execute them automatically — no human needed.",
      capabilities: ["summarize", "research", "analyze", "write"],
      walletAddress: owner?.wallet_address ?? "",
      identityTokenId: identity?.identity_token_id ?? "",
      validationStatus: identity?.validation_status ?? -1,
      isVerified: identity?.validation_status === 100,
      isLive: agentBootstrapped,
      liveStatus: agentRunning ? "running" : (agentRuntime.lastError ? "error" : "idle"),
      lastError: agentRuntime.lastError,
      completedJobs: recentRuns.filter(r => r.status === "completed").length,
      minBudget: "1.00",
      maxBudget: String(AGENT_MAX_BUDGET_USDC.toFixed(2)),
      metadataUrl: getSummaryBotMetadataUri(),
      explorerUrl: identity?.identity_token_id
        ? `${ARC_EXPLORER_URL}/address/${IDENTITY_REGISTRY}`
        : "",
      recentRuns: recentRuns.slice(0, 5),
    }]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/agents/summarybot/metadata", (req, res) => {
  res.json(buildSummaryBotMetadata());
});

app.get("/api/agents/summarybot/status", async (req, res) => {
  try {
    const db = await getDb();
    const identity = getIdentity(db, AGENT_KEY);
    const owner = getWallet(db, AGENT_KEY, "owner");
    res.json({
      bootstrapped: agentBootstrapped,
      running: agentRunning,
      lastError: agentRuntime.lastError,
      lastCycleAt: agentRuntime.lastCycleAt,
      walletAddress: owner?.wallet_address ?? "",
      identityTokenId: identity?.identity_token_id ?? "",
      validationStatus: identity?.validation_status ?? -1,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deliverable viewer — returns HTML page the client reads, JSON for API consumers
app.get("/api/agents/summarybot/jobs/:jobId/deliverable", async (req, res) => {
  try {
    const db = await getDb();
    const run = getRun(db, req.params.jobId);
    if (!run?.deliverable_text) {
      return res.status(404).json({ error: "Deliverable not found" });
    }

    const acceptsHtml = req.headers.accept?.includes("text/html");
    if (!acceptsHtml) {
      return res.json({
        jobId: run.job_id,
        jobTitle: run.job_title,
        text: run.deliverable_text,
        submitTxHash: run.submit_tx_hash,
        generatedAt: run.updated_at,
      });
    }

    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = run.deliverable_text
      .replace(/^## (.+)$/gm, `</section><section><h2>$1</h2>`)
      .replace(/^### (.+)$/gm, `<h3>$1</h3>`)
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>");

    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>SummaryBot — Job #${esc(run.job_id)}: ${esc(run.job_title)}</title>
  <style>
    body{font:16px/1.7 Georgia,serif;max-width:800px;margin:0 auto;padding:40px 24px 80px;background:#fafaf8;color:#1a1a1a}
    header{border-bottom:2px solid #111;padding-bottom:16px;margin-bottom:32px}
    .kicker{font:700 11px/1 monospace;letter-spacing:.15em;text-transform:uppercase;color:#666;margin-bottom:8px}
    h1{font-size:28px;margin:8px 0 4px}
    .meta{font-size:13px;color:#888}
    section{margin:24px 0}
    h2{font-size:18px;border-bottom:1px solid #e0e0e0;padding-bottom:6px;margin-bottom:12px}
    h3{font-size:15px;font-weight:700;margin:16px 0 4px}
    p{margin:8px 0}
    .tx{display:inline-block;margin-top:20px;font:12px monospace;background:#111;color:#7affc8;padding:6px 12px;border-radius:6px;text-decoration:none}
  </style>
</head>
<body>
  <header>
    <div class="kicker">AgentMarket · SummaryBot Deliverable</div>
    <h1>${esc(run.job_title || `Job #${run.job_id}`)}</h1>
    <div class="meta">Job #${esc(run.job_id)} · Generated ${new Date(run.updated_at).toUTCString()}</div>
    ${run.submit_tx_hash ? `<a class="tx" href="${ARC_EXPLORER_URL}/tx/${esc(run.submit_tx_hash)}" target="_blank">View Arc transaction ↗</a>` : ""}
  </header>
  <div>${html}</div>
</body>
</html>`);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Start ────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  AgentMarket API — Arc Testnet       ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`  Port:     ${PORT}`);
  console.log(`  Contract: ${JOB_BOARD_ADDRESS || "⚠ JOB_BOARD_ADDRESS not set"}`);
  console.log(`  Circle:   ${CIRCLE_API_KEY ? "✓ configured" : "✗ not set — agent will not auto-execute"}`);
  console.log(`  OpenAI:   ${OPENAI_API_KEY ? "✓ configured" : "✗ not set — agent will not auto-execute"}`);
  console.log(`  API base: ${PUBLIC_API_BASE_URL || "⚠ AGENTMARKET_PUBLIC_API_BASE_URL not set"}`);
  console.log(``);

  if (CIRCLE_API_KEY && CIRCLE_ENTITY_SECRET && OPENAI_API_KEY && JOB_BOARD_ADDRESS) {
    console.log("  Starting SummaryBot agent loop…");
    startAgentLoop();
  } else {
    console.log("  ⚠ Agent loop disabled. Set CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET,");
    console.log("    OPENAI_API_KEY, and JOB_BOARD_ADDRESS to enable autonomous execution.");
  }
});

export default app;