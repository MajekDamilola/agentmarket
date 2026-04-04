import express from "express";
import cors from "cors";
import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
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

// ─── Your deployed contract address (fill in after deploying) ────
const JOB_BOARD_ADDRESS = process.env.JOB_BOARD_ADDRESS || "0x0000000000000000000000000000000000000000";
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

// ─── Contract ABI (the functions we call) ────────────────────────
const JOB_BOARD_ABI = [
  {
    name: "getJob",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "id", type: "uint256" },
        { name: "client", type: "address" },
        { name: "agent", type: "address" },
        { name: "title", type: "string" },
        { name: "description", type: "string" },
        { name: "taskType", type: "string" },
        { name: "budget", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "status", type: "uint8" },
        { name: "deliverableHash", type: "string" },
        { name: "createdAt", type: "uint256" },
        { name: "completedAt", type: "uint256" },
      ],
    }],
  },
  {
    name: "getAllJobs",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{
      type: "tuple[]",
      components: [
        { name: "id", type: "uint256" },
        { name: "client", type: "address" },
        { name: "agent", type: "address" },
        { name: "title", type: "string" },
        { name: "description", type: "string" },
        { name: "taskType", type: "string" },
        { name: "budget", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "status", type: "uint8" },
        { name: "deliverableHash", type: "string" },
        { name: "createdAt", type: "uint256" },
        { name: "completedAt", type: "uint256" },
      ],
    }],
  },
  {
    name: "getClientJobs",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "client", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "getAgentJobs",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "jobCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "platformFeeBps",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const IDENTITY_ABI = [
  {
    name: "tokenURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
];

const STATUS_LABELS = ["Open", "Funded", "Submitted", "Completed", "Rejected"];

// ─── Helper: format a raw job from contract ───────────────────────
function formatJob(job) {
  return {
    id: Number(job.id),
    client: job.client,
    agent: job.agent,
    title: job.title,
    description: job.description,
    taskType: job.taskType,
    budget: formatUnits(job.budget, 6), // convert from 6-decimal USDC
    budgetRaw: job.budget.toString(),
    deadline: Number(job.deadline) * 1000, // to milliseconds
    status: Number(job.status),
    statusLabel: STATUS_LABELS[Number(job.status)],
    deliverableHash: job.deliverableHash,
    createdAt: Number(job.createdAt) * 1000,
    completedAt: Number(job.completedAt) * 1000,
    explorerUrl: `https://testnet.arcscan.app/address/${JOB_BOARD_ADDRESS}`,
  };
}

// ─── Routes ──────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", network: "Arc Testnet", contractAddress: JOB_BOARD_ADDRESS });
});

// Get all jobs
app.get("/api/jobs", async (req, res) => {
  try {
    const jobs = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getAllJobs",
    });
    res.json(jobs.map(formatJob));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single job
app.get("/api/jobs/:id", async (req, res) => {
  try {
    const job = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getJob",
      args: [BigInt(req.params.id)],
    });
    res.json(formatJob(job));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get jobs for a specific client
app.get("/api/client/:address/jobs", async (req, res) => {
  try {
    const jobIds = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getClientJobs",
      args: [req.params.address],
    });

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

    res.json(jobs.map(formatJob));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get jobs for a specific agent
app.get("/api/agent/:address/jobs", async (req, res) => {
  try {
    const jobIds = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getAgentJobs",
      args: [req.params.address],
    });

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

    res.json(jobs.map(formatJob));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get platform stats (for the dashboard)
app.get("/api/stats", async (req, res) => {
  try {
    const [jobCount, feeBps, jobs] = await Promise.all([
      publicClient.readContract({ address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI, functionName: "jobCount" }),
      publicClient.readContract({ address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI, functionName: "platformFeeBps" }),
      publicClient.readContract({ address: JOB_BOARD_ADDRESS, abi: JOB_BOARD_ABI, functionName: "getAllJobs" }),
    ]);

    const formattedJobs = jobs.map(formatJob);
    const completed = formattedJobs.filter(j => j.status === 3);
    const totalVolume = completed.reduce((sum, j) => sum + parseFloat(j.budget), 0);

    res.json({
      totalJobs: Number(jobCount),
      completedJobs: completed.length,
      totalVolumeUsdc: totalVolume.toFixed(2),
      platformFeePercent: (Number(feeBps) / 100).toFixed(1),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get agent identity from ERC-8004 registry
app.get("/api/agent/:agentId/identity", async (req, res) => {
  try {
    const [owner, tokenURI] = await Promise.all([
      publicClient.readContract({
        address: IDENTITY_REGISTRY,
        abi: IDENTITY_ABI,
        functionName: "ownerOf",
        args: [BigInt(req.params.agentId)],
      }),
      publicClient.readContract({
        address: IDENTITY_REGISTRY,
        abi: IDENTITY_ABI,
        functionName: "tokenURI",
        args: [BigInt(req.params.agentId)],
      }),
    ]);

    res.json({
      agentId: req.params.agentId,
      ownerAddress: owner,
      metadataUri: tokenURI,
      identityRegistryUrl: `https://testnet.arcscan.app/address/${IDENTITY_REGISTRY}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hardcoded native agents (your own agents, always available)
app.get("/api/agents", async (req, res) => {
  res.json([
    {
      id: "native-001",
      name: "SummaryBot",
      description: "Summarizes documents, PDFs, and long text into clear bullet points",
      taskTypes: ["summarize", "analyze"],
      walletAddress: process.env.SUMMARY_AGENT_WALLET || "0x0000000000000000000000000000000000000001",
      reputationScore: 98,
      completedJobs: 0,
      isNative: true,
      isVerified: true,
      minBudget: "1.00",
    },
    {
      id: "native-002",
      name: "ReportAgent",
      description: "Generates structured market and data reports from raw inputs",
      taskTypes: ["report", "research"],
      walletAddress: process.env.REPORT_AGENT_WALLET || "0x0000000000000000000000000000000000000002",
      reputationScore: 95,
      completedJobs: 0,
      isNative: true,
      isVerified: true,
      minBudget: "2.00",
    },
    {
      id: "native-003",
      name: "TranslateAI",
      description: "Translates content between languages with context awareness",
      taskTypes: ["translate"],
      walletAddress: process.env.TRANSLATE_AGENT_WALLET || "0x0000000000000000000000000000000000000003",
      reputationScore: 97,
      completedJobs: 0,
      isNative: true,
      isVerified: true,
      minBudget: "1.00",
    },
  ]);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AgentMarket API running on port ${PORT}`);
  console.log(`Network: Arc Testnet`);
  console.log(`Contract: ${JOB_BOARD_ADDRESS}`);
});
