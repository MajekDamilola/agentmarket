import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "fs";
import { createPublicClient, http, formatUnits, parseAbiItem, keccak256, toBytes } from "viem";
import { arcTestnet } from "viem/chains";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT                = parseInt(process.env.PORT || "3001", 10);
const JOB_BOARD_ADDRESS   = (process.env.JOB_BOARD_ADDRESS || "").trim();
const USDC_ADDRESS        = "0x3600000000000000000000000000000000000000";
const IDENTITY_REGISTRY   = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";
const ZERO_ADDRESS        = "0x0000000000000000000000000000000000000000";
const EXPLORER            = "https://testnet.arcscan.app";
const ARC_BLOCKCHAIN_ID   = "ARC-TESTNET";
const LOG_SCAN_FROM_BLOCK = 0n;

const CIRCLE_API_KEY      = (process.env.CIRCLE_API_KEY || "").trim();
const CIRCLE_ENTITY_SECRET= (process.env.CIRCLE_ENTITY_SECRET || "").trim();
const OPENAI_API_KEY      = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_BASE_URL     = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim();
const OPENAI_MODEL        = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const PUBLIC_API_BASE_URL = (process.env.AGENTMARKET_PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
const AGENT_LOOP_MS       = Math.max(15000, parseInt(process.env.AGENT_LOOP_MS || "20000", 10));
const AGENT_MAX_BUDGET    = Math.max(1, parseFloat(process.env.AGENT_MAX_BUDGET_USDC || "50"));

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http("https://rpc.testnet.arc.network"),
});

const JOB_BOARD_ABI = [
  { name:"getAllJobs", type:"function", stateMutability:"view", inputs:[], outputs:[{type:"tuple[]",components:[{name:"id",type:"uint256"},{name:"client",type:"address"},{name:"agent",type:"address"},{name:"title",type:"string"},{name:"description",type:"string"},{name:"category",type:"string"},{name:"budget",type:"uint256"},{name:"deadline",type:"uint256"},{name:"status",type:"uint8"},{name:"deliverableUrl",type:"string"},{name:"createdAt",type:"uint256"},{name:"completedAt",type:"uint256"}]}] },
  { name:"getJob",    type:"function", stateMutability:"view", inputs:[{name:"jobId",type:"uint256"}], outputs:[{type:"tuple",components:[{name:"id",type:"uint256"},{name:"client",type:"address"},{name:"agent",type:"address"},{name:"title",type:"string"},{name:"description",type:"string"},{name:"category",type:"string"},{name:"budget",type:"uint256"},{name:"deadline",type:"uint256"},{name:"status",type:"uint8"},{name:"deliverableUrl",type:"string"},{name:"createdAt",type:"uint256"},{name:"completedAt",type:"uint256"}]}] },
  { name:"getClientJobs", type:"function", stateMutability:"view", inputs:[{name:"client",type:"address"}], outputs:[{name:"",type:"uint256[]"}] },
  { name:"getAgentJobs",  type:"function", stateMutability:"view", inputs:[{name:"agent",type:"address"}], outputs:[{name:"",type:"uint256[]"}] },
  { name:"jobCount",       type:"function", stateMutability:"view", inputs:[], outputs:[{name:"",type:"uint256"}] },
  { name:"platformFeeBps", type:"function", stateMutability:"view", inputs:[], outputs:[{name:"",type:"uint256"}] },
];

const IDENTITY_ABI = [
  { name:"ownerOf",  type:"function", stateMutability:"view", inputs:[{name:"tokenId",type:"uint256"}], outputs:[{name:"",type:"address"}] },
  { name:"tokenURI", type:"function", stateMutability:"view", inputs:[{name:"tokenId",type:"uint256"}], outputs:[{name:"",type:"string"}] },
];

const STATUS_LABELS = ["Open","Funded","Submitted","Completed","Rejected"];
const AGENT_WALLET_SET_NAME = "AgentMarket SummaryAgent";
const AGENT_OWNER_NAME = "SummaryAgent Owner";
const AGENT_OWNER_REF = "agentmarket-summaryagent-owner";
const AGENT_VALIDATOR_NAME = "SummaryAgent Validator";
const AGENT_VALIDATOR_REF = "agentmarket-summaryagent-validator";
const VALIDATION_RESPONSE_EVENT = parseAbiItem("event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)");

function sameAddr(a,b) { return a?.toLowerCase()===b?.toLowerCase(); }
function sleep(ms)     { return new Promise(r=>setTimeout(r,ms)); }
function fmt6(v)       { return parseFloat(formatUnits(BigInt(v||0),6)).toFixed(2); }
const UUID_V4_RE       = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function circleIdempotencyKey(value="") {
  const key=String(value||"").trim();
  return UUID_V4_RE.test(key) ? key : randomUUID();
}

function formatError(err) {
  const message=err?.response?.data?.message||err?.response?.data?.error||err?.message;
  if(message) return String(message);
  try { return JSON.stringify(err?.response?.data||err); }
  catch { return String(err); }
}

function agentWalletMeta(role) {
  return role==="owner"
    ? {name:AGENT_OWNER_NAME,refId:AGENT_OWNER_REF}
    : {name:AGENT_VALIDATOR_NAME,refId:AGENT_VALIDATOR_REF};
}

function toEpochMs(value) {
  const time=Date.parse(value||"");
  return Number.isFinite(time) ? time : 0;
}

function normalizeCircleWallet(wallet) {
  if(!wallet?.id||!wallet?.address||!wallet?.walletSetId) return null;
  return {
    id:String(wallet.id),
    address:String(wallet.address).toLowerCase(),
    walletSetId:String(wallet.walletSetId),
    name:String(wallet.name||""),
    refId:String(wallet.refId||""),
    createDateMs:toEpochMs(wallet.createDate),
    updateDateMs:toEpochMs(wallet.updateDate),
  };
}

function formatJob(j) {
  const status   = Number(j.status);
  const deadline = Number(j.deadline)*1000;
  return {
    id: Number(j.id), client: j.client, agent: j.agent,
    title: j.title, description: j.description, category: j.category,
    budget: fmt6(j.budget), budgetRaw: j.budget.toString(),
    status, statusLabel: STATUS_LABELS[status]??"Unknown",
    isExpired: deadline>0 && [0,1].includes(status) && Date.now()>deadline,
    deliverableUrl: j.deliverableUrl,
    createdAt: Number(j.createdAt)*1000,
    completedAt: Number(j.completedAt)*1000,
    deadline,
    explorerUrl: `${EXPLORER}/address/${JOB_BOARD_ADDRESS}`,
  };
}

async function getAllJobs() {
  if (!JOB_BOARD_ADDRESS) return [];
  const raw = await publicClient.readContract({ address:JOB_BOARD_ADDRESS, abi:JOB_BOARD_ABI, functionName:"getAllJobs" });
  return raw.map(formatJob);
}

async function getJobById(id) {
  const raw = await publicClient.readContract({ address:JOB_BOARD_ADDRESS, abi:JOB_BOARD_ABI, functionName:"getJob", args:[BigInt(id)] });
  return formatJob(raw);
}

const DB_PATH = path.join(__dirname,"..","cache","agentmarket.sqlite");
let _db = null;

async function getDb() {
  if (_db) return _db;
  await fs.mkdir(path.dirname(DB_PATH),{recursive:true});
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_wallets (agent_key TEXT NOT NULL, wallet_role TEXT NOT NULL, wallet_id TEXT NOT NULL DEFAULT '', wallet_address TEXT NOT NULL DEFAULT '', wallet_set_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(agent_key,wallet_role));
    CREATE TABLE IF NOT EXISTS agent_identity (agent_key TEXT PRIMARY KEY, identity_token_id TEXT NOT NULL DEFAULT '', identity_tx_hash TEXT NOT NULL DEFAULT '', metadata_uri TEXT NOT NULL DEFAULT '', validation_status INTEGER NOT NULL DEFAULT -1, validation_request_hash TEXT NOT NULL DEFAULT '', validation_tx_hash TEXT NOT NULL DEFAULT '', registered_at INTEGER NOT NULL DEFAULT 0, validated_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, job_id INTEGER NOT NULL UNIQUE, job_title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', deliverable_url TEXT NOT NULL DEFAULT '', deliverable_text TEXT NOT NULL DEFAULT '', submit_tx_hash TEXT NOT NULL DEFAULT '', reputation_tx_hash TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_runs_job ON agent_runs(job_id);
  `);
  _db = db;
  return db;
}

function getWallet(db,agentKey,role) { return db.prepare("SELECT * FROM agent_wallets WHERE agent_key=? AND wallet_role=?").get(agentKey,role)??null; }
function saveWallet(db,agentKey,role,{walletId,walletAddress,walletSetId}) {
  const now=Date.now();
  db.prepare(`INSERT INTO agent_wallets (agent_key,wallet_role,wallet_id,wallet_address,wallet_set_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_key,wallet_role) DO UPDATE SET wallet_id=excluded.wallet_id,wallet_address=excluded.wallet_address,wallet_set_id=excluded.wallet_set_id,updated_at=excluded.updated_at`).run(agentKey,role,walletId,walletAddress.toLowerCase(),walletSetId,now,now);
  return getWallet(db,agentKey,role);
}

function getIdentity(db,agentKey) { return db.prepare("SELECT * FROM agent_identity WHERE agent_key=?").get(agentKey)??null; }
function saveIdentity(db,agentKey,payload) {
  const now=Date.now(); const ex=getIdentity(db,agentKey);
  db.prepare(`INSERT INTO agent_identity (agent_key,identity_token_id,identity_tx_hash,metadata_uri,validation_status,validation_request_hash,validation_tx_hash,registered_at,validated_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_key) DO UPDATE SET identity_token_id=excluded.identity_token_id,identity_tx_hash=excluded.identity_tx_hash,metadata_uri=excluded.metadata_uri,validation_status=excluded.validation_status,validation_request_hash=excluded.validation_request_hash,validation_tx_hash=excluded.validation_tx_hash,registered_at=excluded.registered_at,validated_at=excluded.validated_at,updated_at=excluded.updated_at`).run(agentKey,payload.identity_token_id??ex?.identity_token_id??"",payload.identity_tx_hash??ex?.identity_tx_hash??"",payload.metadata_uri??ex?.metadata_uri??"",payload.validation_status??ex?.validation_status??-1,payload.validation_request_hash??ex?.validation_request_hash??"",payload.validation_tx_hash??ex?.validation_tx_hash??"",payload.registered_at??ex?.registered_at??0,payload.validated_at??ex?.validated_at??0,now);
  return getIdentity(db,agentKey);
}

function getRun(db,jobId) { return db.prepare("SELECT * FROM agent_runs WHERE job_id=?").get(Number(jobId))??null; }
function saveRun(db,payload) {
  const now=Date.now();
  const ex=payload.id ? db.prepare("SELECT * FROM agent_runs WHERE id=?").get(payload.id) : getRun(db,payload.job_id);
  const id=ex?.id??payload.id??randomUUID();
  db.prepare(`INSERT INTO agent_runs (id,job_id,job_title,status,deliverable_url,deliverable_text,submit_tx_hash,reputation_tx_hash,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET job_id=excluded.job_id,job_title=excluded.job_title,status=excluded.status,deliverable_url=excluded.deliverable_url,deliverable_text=excluded.deliverable_text,submit_tx_hash=excluded.submit_tx_hash,reputation_tx_hash=excluded.reputation_tx_hash,error=excluded.error,updated_at=excluded.updated_at`).run(id,payload.job_id??ex?.job_id??0,payload.job_title??ex?.job_title??"",payload.status??ex?.status??"pending",payload.deliverable_url??ex?.deliverable_url??"",payload.deliverable_text??ex?.deliverable_text??"",payload.submit_tx_hash??ex?.submit_tx_hash??"",payload.reputation_tx_hash??ex?.reputation_tx_hash??"",payload.error??ex?.error??"",ex?.created_at??now,now);
  return db.prepare("SELECT * FROM agent_runs WHERE id=?").get(id);
}

let _circle=null;
function getCircle() {
  if (!CIRCLE_API_KEY||!CIRCLE_ENTITY_SECRET) return null;
  if (!_circle) _circle=initiateDeveloperControlledWalletsClient({apiKey:CIRCLE_API_KEY,entitySecret:CIRCLE_ENTITY_SECRET});
  return _circle;
}

async function waitForCircleTx(txId,{timeoutMs=120000,pollMs=2500}={}) {
  const start=Date.now();
  while(Date.now()-start<timeoutMs) {
    await sleep(pollMs);
    const {data}=await getCircle().getTransaction({id:txId});
    const state=String(data?.transaction?.state||"").toUpperCase();
    if(state==="COMPLETE") return data.transaction;
    if(["FAILED","CANCELLED","DENIED"].includes(state)) throw new Error(data?.transaction?.errorReason||`Circle tx ${state}`);
  }
  throw new Error(`Timed out waiting for Circle tx ${txId}`);
}

async function circleCall(walletId,contractAddress,sig,params,idempotencyKey) {
  const res=await getCircle().createContractExecutionTransaction({walletId,blockchain:ARC_BLOCKCHAIN_ID,contractAddress,abiFunctionSignature:sig,abiParameters:params,fee:{type:"level",config:{feeLevel:"MEDIUM"}},idempotencyKey:circleIdempotencyKey(idempotencyKey)});
  const txId=res?.data?.id;
  if(!txId) throw new Error("No tx id from Circle");
  return waitForCircleTx(txId);
}

const AGENT_KEY="summaryagent";

function getMetadataUri() { return PUBLIC_API_BASE_URL?`${PUBLIC_API_BASE_URL}/api/agents/summaryagent/metadata`:""; }
function getValidationRequestHash(tokenId) { return keccak256(toBytes(`summaryagent_validation_${tokenId}`)); }

async function resolveTokenId(ownerAddress) {
  const latest=await publicClient.getBlockNumber();
  const logs=await publicClient.getLogs({address:IDENTITY_REGISTRY,event:parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"),args:{to:ownerAddress},fromBlock:LOG_SCAN_FROM_BLOCK,toBlock:latest});
  return logs.length?String(logs[logs.length-1].args.tokenId):"";
}

async function resolveValidationStatus(tokenId) {
  const requestHash=getValidationRequestHash(tokenId);
  const latest=await publicClient.getBlockNumber();
  const logs=await publicClient.getLogs({address:VALIDATION_REGISTRY,event:VALIDATION_RESPONSE_EVENT,args:{agentId:BigInt(tokenId),requestHash},fromBlock:LOG_SCAN_FROM_BLOCK,toBlock:latest});
  const status=logs.length?Number(logs[logs.length-1].args.response??-1):-1;
  return {requestHash,status};
}

async function updateCircleWalletRole(circle,wallet,role) {
  const meta=agentWalletMeta(role);
  if(wallet.name===meta.name&&wallet.refId===meta.refId) return wallet;
  try {
    const res=await circle.updateWallet({id:wallet.id,...meta});
    return normalizeCircleWallet(res?.data?.wallet)||{...wallet,...meta};
  } catch(err) {
    console.warn(`[SummaryAgent] Could not tag ${role} wallet ${wallet.address}:`,formatError(err));
    return {...wallet,...meta};
  }
}

async function scoreWalletPair(pair) {
  const tokenId=await resolveTokenId(pair.owner.address).catch(()=>"");
  return {pair,tokenId,score:(tokenId?1_000_000_000_000:0)+Math.max(pair.owner.updateDateMs,pair.validator.updateDateMs,pair.owner.createDateMs,pair.validator.createDateMs)};
}

async function findTaggedWalletPair(circle) {
  const [ownerRes,validatorRes]=await Promise.all([
    circle.listWallets({blockchain:ARC_BLOCKCHAIN_ID,refId:AGENT_OWNER_REF,order:"DESC",pageSize:100}),
    circle.listWallets({blockchain:ARC_BLOCKCHAIN_ID,refId:AGENT_VALIDATOR_REF,order:"DESC",pageSize:100}),
  ]);
  const owners=(ownerRes?.data?.wallets??[]).map(normalizeCircleWallet).filter(Boolean);
  const validators=(validatorRes?.data?.wallets??[]).map(normalizeCircleWallet).filter(Boolean);
  const pairs=owners.map(owner=>({owner,validator:validators.find(v=>v.walletSetId===owner.walletSetId)})).filter(pair=>pair.validator);
  if(!pairs.length) return null;
  const scored=await Promise.all(pairs.map(scoreWalletPair));
  return scored.sort((a,b)=>b.score-a.score)[0]??null;
}

async function findLegacyWalletPair(circle) {
  const sets=(await circle.listWalletSets({order:"DESC",pageSize:100}))?.data?.walletSets??[];
  const candidates=[];
  for(const set of sets.filter(s=>s?.name===AGENT_WALLET_SET_NAME)) {
    const walletRes=await circle.listWallets({blockchain:ARC_BLOCKCHAIN_ID,walletSetId:set.id,order:"ASC",pageSize:100});
    const wallets=(walletRes?.data?.wallets??[]).map(normalizeCircleWallet).filter(Boolean).sort((a,b)=>a.createDateMs-b.createDateMs);
    if(wallets.length<2) continue;
    candidates.push({owner:wallets[0],validator:wallets[1]});
  }
  if(!candidates.length) return null;
  const scored=await Promise.all(candidates.map(scoreWalletPair));
  return scored.sort((a,b)=>b.score-a.score)[0]??null;
}

async function recoverWalletsFromCircle(db,circle) {
  const match=await findTaggedWalletPair(circle) || await findLegacyWalletPair(circle);
  if(!match?.pair?.owner||!match?.pair?.validator) return null;
  const owner=await updateCircleWalletRole(circle,match.pair.owner,"owner");
  const validator=await updateCircleWalletRole(circle,match.pair.validator,"validator");
  return {
    owner:saveWallet(db,AGENT_KEY,"owner",{walletId:owner.id,walletAddress:owner.address,walletSetId:owner.walletSetId}),
    validator:saveWallet(db,AGENT_KEY,"validator",{walletId:validator.id,walletAddress:validator.address,walletSetId:validator.walletSetId}),
  };
}

async function hydrateIdentityFromChain(db,ownerWalletAddress) {
  const existing=getIdentity(db,AGENT_KEY);
  const tokenId=existing?.identity_token_id||await resolveTokenId(ownerWalletAddress);
  if(!tokenId) return existing??null;
  let requestHash=existing?.validation_request_hash||getValidationRequestHash(tokenId);
  let validationStatus=existing?.validation_status??-1;
  try {
    const resolved=await resolveValidationStatus(tokenId);
    requestHash=resolved.requestHash;
    validationStatus=resolved.status;
  } catch {}
  return saveIdentity(db,AGENT_KEY,{
    identity_token_id:String(tokenId),
    metadata_uri:getMetadataUri(),
    validation_request_hash:requestHash,
    validation_status:validationStatus,
    registered_at:existing?.registered_at??0,
    validated_at:validationStatus===100?(existing?.validated_at||Date.now()):(existing?.validated_at??0),
  });
}

async function ensureWallets(db) {
  const circle=getCircle();
  if(!circle) throw new Error("Circle not configured");
  const eo=getWallet(db,AGENT_KEY,"owner");
  const ev=getWallet(db,AGENT_KEY,"validator");
  const existingIdentity=getIdentity(db,AGENT_KEY);
  if((!eo?.wallet_id||!ev?.wallet_id||!existingIdentity?.identity_token_id)) {
    const recovered=await recoverWalletsFromCircle(db,circle);
    if(recovered?.owner?.wallet_id&&recovered?.validator?.wallet_id) return recovered;
  }
  if(eo?.wallet_id&&ev?.wallet_id) return {owner:eo,validator:ev};
  let wsId=eo?.wallet_set_id||ev?.wallet_set_id||"";
  if(!wsId) {
    const r=await circle.createWalletSet({name:AGENT_WALLET_SET_NAME,idempotencyKey:circleIdempotencyKey()});
    wsId=r?.data?.walletSet?.id;
    if(!wsId) throw new Error("No walletSetId from Circle");
  }
  const wr=await circle.createWallets({
    blockchains:[ARC_BLOCKCHAIN_ID],
    count:2,
    walletSetId:wsId,
    accountType:"EOA",
    idempotencyKey:circleIdempotencyKey(),
    metadata:[agentWalletMeta("owner"),agentWalletMeta("validator")],
  });
  const [or,vr]=wr?.data?.wallets??[];
  if(!or?.id||!vr?.id) throw new Error("Circle did not return 2 wallets");
  const owner=saveWallet(db,AGENT_KEY,"owner",{walletId:or.id,walletAddress:or.address,walletSetId:wsId});
  const validator=saveWallet(db,AGENT_KEY,"validator",{walletId:vr.id,walletAddress:vr.address,walletSetId:wsId});
  return {owner,validator};
}

async function ensureIdentity(db) {
  const {owner}=await ensureWallets(db);
  const existing=await hydrateIdentityFromChain(db,owner.wallet_address);
  if(existing?.identity_token_id) return existing;
  const metadataUri=getMetadataUri();
  if(!metadataUri) throw new Error("Set AGENTMARKET_PUBLIC_API_BASE_URL");
  console.log("[SummaryAgent] Registering ERC-8004 identity...");
  const tx=await circleCall(owner.wallet_id,IDENTITY_REGISTRY,"register(string)",[metadataUri],"agentmarket-summaryagent-register-v1");
  const tokenId=await resolveTokenId(owner.wallet_address);
  if(!tokenId) throw new Error("Could not find ERC-8004 token after registration");
  console.log(`[SummaryAgent] Registered. Token ID: ${tokenId}`);
  return saveIdentity(db,AGENT_KEY,{identity_token_id:tokenId,identity_tx_hash:tx.txHash??"",metadata_uri:metadataUri,registered_at:Date.now()});
}

async function ensureValidation(db) {
  const identity=await ensureIdentity(db);
  if(identity.validation_status===100) return identity;
  const {owner,validator}=await ensureWallets(db);
  const reqHash=identity.validation_request_hash||getValidationRequestHash(identity.identity_token_id);
  console.log("[SummaryAgent] Requesting ERC-8004 validation...");
  await circleCall(owner.wallet_id,VALIDATION_REGISTRY,"validationRequest(address,uint256,string,bytes32)",[validator.wallet_address,identity.identity_token_id,identity.metadata_uri,reqHash],"agentmarket-summaryagent-valrequest-v1");
  const resTx=await circleCall(validator.wallet_id,VALIDATION_REGISTRY,"validationResponse(bytes32,uint8,string,bytes32,string)",[reqHash,100,identity.metadata_uri,`0x${"0".repeat(64)}`,"platform_verified"],"agentmarket-summaryagent-valresponse-v1");
  console.log("[SummaryAgent] Validation complete.");
  return saveIdentity(db,AGENT_KEY,{validation_status:100,validation_request_hash:reqHash,validation_tx_hash:resTx.txHash??"",validated_at:Date.now()});
}

async function fetchUrl(url) {
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(),12000);
  try {
    const res=await fetch(url,{signal:ctrl.signal,headers:{"User-Agent":"AgentMarket SummaryAgent/1.0"}});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct=res.headers.get("content-type")??"";
    const raw=await res.text();
    return ct.includes("html")?raw.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,10000):raw.slice(0,10000);
  } finally { clearTimeout(t); }
}

function extractUrls(text) {
  return [...new Set((text.match(/https?:\/\/[^\s)>]+/gi)??[]).map(u=>u.replace(/[.,;!?]+$/,"")))].slice(0,3);
}

async function runLLM(system,user) {
  if(!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const res=await fetch(`${OPENAI_BASE_URL}/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${OPENAI_API_KEY}`},body:JSON.stringify({model:OPENAI_MODEL,max_tokens:1500,messages:[{role:"system",content:system},{role:"user",content:user}]})});
  if(!res.ok) { const d=await res.text().catch(()=>""); throw new Error(`OpenAI ${res.status}: ${d.slice(0,200)}`); }
  const data=await res.json();
  return data.choices?.[0]?.message?.content?.trim()??"";
}

async function executeJob(job) {
  const urls=extractUrls(job.description);
  const sources=[];
  for(const url of urls) {
    try { sources.push({url,text:await fetchUrl(url)}); }
    catch { sources.push({url,text:"(could not fetch)"}); }
  }
  const sourceSection=sources.length?sources.map((s,i)=>`Source ${i+1}: ${s.url}\n${s.text}`).join("\n\n"):"";
  const system="You are SummaryAgent, an autonomous AI agent on AgentMarket (Arc Testnet). You complete summarization, research, and analysis jobs for clients. Produce a clean professional deliverable. Structure your response with these exact sections: ## Summary, ## Key Findings, ## Action Items. Be factual and specific. If sources were provided, reference them.";
  const user=[`Job Title: ${job.title}`,`Category: ${job.category}`,`Client Request:\n${job.description}`,sourceSection?`\nFetched Sources:\n${sourceSection}`:""].join("\n");
  return runLLM(system,user);
}

async function submitDeliverable(db,job,text) {
  const {owner}=await ensureWallets(db);
  const runId=getRun(db,job.id)?.id??randomUUID();
  saveRun(db,{id:runId,job_id:job.id,job_title:job.title,status:"submitting",deliverable_text:text,deliverable_url:""});
  const deliverableUrl=`${PUBLIC_API_BASE_URL}/api/agents/summaryagent/jobs/${job.id}/deliverable`;
  const tx=await circleCall(owner.wallet_id,JOB_BOARD_ADDRESS,"submitDeliverable(uint256,string)",[Number(job.id),deliverableUrl],`agentmarket-submit-job-${job.id}`);
  return saveRun(db,{id:runId,status:"submitted",deliverable_url:deliverableUrl,submit_tx_hash:tx.txHash??""});
}

async function recordReputation(db,job) {
  const {validator}=await ensureWallets(db);
  const identity=getIdentity(db,AGENT_KEY);
  if(!identity?.identity_token_id) return;
  const run=getRun(db,job.id);
  if(!run||run.reputation_tx_hash) return;
  const onTime=job.completedAt>0&&job.deadline>0&&job.completedAt<=job.deadline;
  const score=onTime?95:80;
  const tag=onTime?"job_completed_on_time":"job_completed_late";
  const feedbackHash=keccak256(toBytes(`${tag}:${job.id}`));
  console.log(`[SummaryAgent] Recording reputation for job #${job.id}...`);
  const tx=await circleCall(validator.wallet_id,REPUTATION_REGISTRY,"giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",[identity.identity_token_id,String(score),"0",tag,identity.metadata_uri,run.deliverable_url,`SummaryAgent completed job #${job.id}`,feedbackHash],`agentmarket-reputation-job-${job.id}`);
  saveRun(db,{id:run.id,reputation_tx_hash:tx.txHash??"",status:"completed"});
  console.log(`[SummaryAgent] Reputation recorded. Score: ${score}`);
}

let agentRunning=false;
let agentBootstrapped=false;
const agentRuntime={lastError:"",lastCycleAt:0};

async function runAgentCycle() {
  if(agentRunning) return;
  agentRunning=true;
  try {
    const db=await getDb();
    if(!agentBootstrapped) {
      await ensureValidation(db);
      agentBootstrapped=true;
      console.log("[SummaryAgent] Bootstrap complete. Ready for jobs.");
    }
    const {owner}=await ensureWallets(db);
    const jobs=await getAllJobs();
    for(const job of jobs.filter(j=>j.status===3&&sameAddr(j.agent,owner.wallet_address))) {
      await recordReputation(db,job).catch(e=>console.warn("[SummaryAgent] Reputation error:",e.message));
    }
    const candidates=jobs.filter(j=>j.status===1&&sameAddr(j.agent,owner.wallet_address)&&!getRun(db,j.id)&&!j.isExpired&&parseFloat(j.budget)<=AGENT_MAX_BUDGET);
    for(const job of candidates) {
      console.log(`[SummaryAgent] Picked up job #${job.id}: "${job.title}"`);
      try {
        saveRun(db,{job_id:job.id,job_title:job.title,status:"running"});
        const text=await executeJob(job);
        await submitDeliverable(db,job,text);
        console.log(`[SummaryAgent] Delivered job #${job.id}`);
      } catch(err) {
        const message=formatError(err);
        console.error(`[SummaryAgent] Failed job #${job.id}:`,message);
        const run=getRun(db,job.id);
        saveRun(db,{id:run?.id,job_id:job.id,status:"failed",error:message});
      }
    }
    agentRuntime.lastError="";
    agentRuntime.lastCycleAt=Date.now();
  } catch(err) {
    agentRuntime.lastError=formatError(err);
    console.warn("[SummaryAgent] Cycle error:",agentRuntime.lastError);
  } finally { agentRunning=false; }
}

function startAgentLoop() {
  runAgentCycle().catch(()=>{});
  setInterval(()=>{ if(!agentRunning) runAgentCycle().catch(()=>{}); },AGENT_LOOP_MS);
}

const app=express();
app.use(cors());
app.use(express.json());

app.get("/health",(req,res)=>res.json({status:"ok",network:"Arc Testnet",contract:JOB_BOARD_ADDRESS,agent:{bootstrapped:agentBootstrapped,running:agentRunning,lastError:agentRuntime.lastError}}));

app.get("/api/config",(req,res)=>res.json({jobBoardAddress:JOB_BOARD_ADDRESS,usdcAddress:USDC_ADDRESS,explorerUrl:EXPLORER,identityRegistry:IDENTITY_REGISTRY,reputationRegistry:REPUTATION_REGISTRY}));

app.get("/api/jobs",async(req,res)=>{try{res.json(await getAllJobs());}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/jobs/:id",async(req,res)=>{try{res.json(await getJobById(req.params.id));}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/client/:address/jobs",async(req,res)=>{try{const jobs=await getAllJobs();res.json(jobs.filter(j=>sameAddr(j.client,req.params.address)));}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/stats",async(req,res)=>{try{const jobs=await getAllJobs();const completed=jobs.filter(j=>j.status===3);res.json({totalJobs:jobs.length,completedJobs:completed.length,openJobs:jobs.filter(j=>j.status===1).length,totalVolumeUsdc:completed.reduce((s,j)=>s+parseFloat(j.budget),0).toFixed(2)});}catch(e){res.status(500).json({error:e.message});}});

app.get("/api/agents",async(req,res)=>{
  try {
    const db=await getDb();
    const owner=getWallet(db,AGENT_KEY,"owner");
    const validator=getWallet(db,AGENT_KEY,"validator");
    const identity=getIdentity(db,AGENT_KEY);
    const runs=db.prepare("SELECT * FROM agent_runs ORDER BY updated_at DESC LIMIT 20").all();
    res.json([{
      id:"summaryagent",name:"SummaryAgent",
      description:"Autonomous AI agent that reads your job description, fetches any URLs you include, produces a structured deliverable, and submits it on-chain. No human involved.",
      capabilities:["summarize","research","analyze","write"],
      walletAddress:owner?.wallet_address??"",
      validatorWalletAddress:validator?.wallet_address??"",
      identityTokenId:identity?.identity_token_id??"",
      validationStatus:identity?.validation_status??-1,
      isVerified:identity?.validation_status===100,
      isLive:agentBootstrapped,
      liveStatus:agentRunning?"running":(agentRuntime.lastError?"error":"idle"),
      lastError:agentRuntime.lastError,
      completedJobs:runs.filter(r=>r.status==="completed").length,
      minBudget:"1.00",maxBudget:String(AGENT_MAX_BUDGET.toFixed(2)),
      metadataUrl:getMetadataUri(),
      recentRuns:runs.slice(0,5),
    }]);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/agents/summaryagent/metadata",(req,res)=>res.json({name:"SummaryAgent",description:"Autonomous AI summarization and research agent on AgentMarket (Arc Testnet).",agent_type:"summarization",capabilities:["summarize","research","analyze","write"],version:"1.0.0"}));

app.get("/api/agents/summaryagent/status",async(req,res)=>{
  try {
    const db=await getDb();
    const identity=getIdentity(db,AGENT_KEY);
    const owner=getWallet(db,AGENT_KEY,"owner");
    const validator=getWallet(db,AGENT_KEY,"validator");
    res.json({bootstrapped:agentBootstrapped,running:agentRunning,lastError:agentRuntime.lastError,lastCycleAt:agentRuntime.lastCycleAt,walletAddress:owner?.wallet_address??"",validatorWalletAddress:validator?.wallet_address??"",identityTokenId:identity?.identity_token_id??"",validationStatus:identity?.validation_status??-1});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/agents/summaryagent/jobs/:jobId/deliverable",async(req,res)=>{
  try {
    const db=await getDb();
    const run=getRun(db,req.params.jobId);
    if(!run?.deliverable_text) return res.status(404).json({error:"Deliverable not found"});
    if(!req.headers.accept?.includes("text/html")) return res.json({jobId:run.job_id,jobTitle:run.job_title,text:run.deliverable_text,submitTxHash:run.submit_tx_hash,generatedAt:run.updated_at});
    const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const html=run.deliverable_text.replace(/^## (.+)$/gm,"</section><section><h2>$1</h2>").replace(/\n\n/g,"</p><p>").replace(/\n/g,"<br>");
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>SummaryAgent — Job #${esc(run.job_id)}</title><style>body{font:16px/1.7 Georgia,serif;max-width:800px;margin:0 auto;padding:40px 24px 80px;background:#fafaf8;color:#1a1a1a}header{border-bottom:2px solid #111;padding-bottom:16px;margin-bottom:32px}.kicker{font:700 11px/1 monospace;letter-spacing:.15em;text-transform:uppercase;color:#666;margin-bottom:8px}h1{font-size:28px;margin:8px 0 4px}.meta{font-size:13px;color:#888}section{margin:24px 0}h2{font-size:18px;border-bottom:1px solid #e0e0e0;padding-bottom:6px;margin-bottom:12px}p{margin:8px 0}.tx{display:inline-block;margin-top:20px;font:12px monospace;background:#111;color:#7affc8;padding:6px 12px;border-radius:6px;text-decoration:none}</style></head><body><header><div class="kicker">AgentMarket · SummaryAgent Deliverable</div><h1>${esc(run.job_title||`Job #${run.job_id}`)}</h1><div class="meta">Job #${esc(run.job_id)} · ${new Date(run.updated_at).toUTCString()}</div>${run.submit_tx_hash?`<a class="tx" href="${EXPLORER}/tx/${esc(run.submit_tx_hash)}" target="_blank">View Arc transaction ↗</a>`:""}</header><div>${html}</div></body></html>`);
  } catch(e){res.status(500).json({error:e.message});}
});

app.listen(PORT,()=>{
  console.log(`\nAgentMarket API — Arc Testnet`);
  console.log(`Port:     ${PORT}`);
  console.log(`Contract: ${JOB_BOARD_ADDRESS||"⚠ JOB_BOARD_ADDRESS not set"}`);
  console.log(`Circle:   ${CIRCLE_API_KEY?"✓":"✗ not set"}`);
  console.log(`OpenAI:   ${OPENAI_API_KEY?"✓":"✗ not set"}`);
  console.log(`API base: ${PUBLIC_API_BASE_URL||"⚠ not set"}`);
  if(CIRCLE_API_KEY&&CIRCLE_ENTITY_SECRET&&OPENAI_API_KEY&&JOB_BOARD_ADDRESS) {
    console.log("\nStarting SummaryAgent loop...");
    startAgentLoop();
  } else {
    console.log("\n⚠ Agent loop disabled. Set CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, OPENAI_API_KEY, JOB_BOARD_ADDRESS to enable.");
  }
});

export default app;
