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
        { name: "category", type: "string" },
        { name: "workerType", type: "uint8" },
        { name: "budget", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "status", type: "uint8" },
        { name: "deliverableHash", type: "string" },
        { name: "createdAt", type: "uint256" },
        { name: "completedAt", type: "uint256" },
        { name: "pickedAt", type: "uint256" },
        { name: "milestonesCount", type: "uint256" },
        { name: "completedMilestones", type: "uint256" },
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
        { name: "category", type: "string" },
        { name: "workerType", type: "uint8" },
        { name: "budget", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "status", type: "uint8" },
        { name: "deliverableHash", type: "string" },
        { name: "createdAt", type: "uint256" },
        { name: "completedAt", type: "uint256" },
        { name: "pickedAt", type: "uint256" },
        { name: "milestonesCount", type: "uint256" },
        { name: "completedMilestones", type: "uint256" },
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
    name: "getWorkerReviews",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "worker", type: "address" }],
    outputs: [{ type: "tuple[]", components: [
      { name: "jobId", type: "uint256" },
      { name: "reviewer", type: "address" },
      { name: "worker", type: "address" },
      { name: "rating", type: "uint8" },
      { name: "comment", type: "string" },
      { name: "timestamp", type: "uint256" },
    ] }],
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
  {
    name: "campaigns",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "id", type: "uint256" },
        { name: "creator", type: "address" },
        { name: "title", type: "string" },
        { name: "description", type: "string" },
        { name: "prizePool", type: "uint256" },
        { name: "entryFee", type: "uint256" },
        { name: "maxParticipants", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "expired", type: "bool" },
        { name: "createdAt", type: "uint256" },
      ],
    }],
  },
  {
    name: "campaignSubmissions",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }, { name: "", type: "address" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "campaignParticipants",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "campaignWinners",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "campaignCount",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "createCampaign",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "title", type: "string" },
      { name: "description", type: "string" },
      { name: "prizePool", type: "uint256" },
      { name: "entryFee", type: "uint256" },
      { name: "maxParticipants", type: "uint256" },
      { name: "deadlineHours", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "campaignId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "submitEntry",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "campaignId", type: "uint256" },
      { name: "submissionURI", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "selectWinners",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "campaignId", type: "uint256" },
      { name: "winners", type: "address[]" },
    ],
    outputs: [],
  },
  {
    name: "expireCampaign",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "campaignId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "getCampaign",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "campaignId", type: "uint256" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "id", type: "uint256" },
        { name: "creator", type: "address" },
        { name: "title", type: "string" },
        { name: "description", type: "string" },
        { name: "prizePool", type: "uint256" },
        { name: "entryFee", type: "uint256" },
        { name: "maxParticipants", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "expired", type: "bool" },
        { name: "createdAt", type: "uint256" },
      ],
    }],
  },
  {
    name: "getCampaignParticipants",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "campaignId", type: "uint256" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "getCampaignWinners",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "campaignId", type: "uint256" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "getCampaignSubmission",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "campaignId", type: "uint256" },
      { name: "participant", type: "address" },
    ],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "getAllCampaigns",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{
      type: "tuple[]",
      components: [
        { name: "id", type: "uint256" },
        { name: "creator", type: "address" },
        { name: "title", type: "string" },
        { name: "description", type: "string" },
        { name: "prizePool", type: "uint256" },
        { name: "entryFee", type: "uint256" },
        { name: "maxParticipants", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "expired", type: "bool" },
        { name: "createdAt", type: "uint256" },
      ],
    }],
  },
  {
    name: "submitMilestoneDeliverable",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "milestoneIndex", type: "uint256" },
      { name: "deliverableHash", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "approveMilestone",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "milestoneIndex", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "getJobMilestones",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: [
      { name: "percentage", type: "uint256" },
      { name: "description", type: "string" },
      { name: "deliverableHash", type: "string" },
      { name: "submittedAt", type: "uint256" },
      { name: "approved", type: "bool" },
    ] }],
  },
  {
    name: "submitReview",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "rating", type: "uint8" },
      { name: "comment", type: "string" },
    ],
    outputs: [],
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
const WORKER_TYPES = ["AI", "Human"];

// ─── Helper: format a raw job from contract ───────────────────────
function formatJob(job) {
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
    budget: formatUnits(job.budget, 6), // convert from 6-decimal USDC
    budgetRaw: job.budget.toString(),
    status: Number(job.status),
    statusLabel: STATUS_LABELS[Number(job.status)],
    deliverableHash: job.deliverableHash,
    createdAt: Number(job.createdAt) * 1000,
    completedAt: Number(job.completedAt) * 1000,
    pickedAt: Number(job.pickedAt) * 1000,
    deadline: Number(job.deadline) * 1000,
    milestonesCount: Number(job.milestonesCount),
    completedMilestones: Number(job.completedMilestones),
    explorerUrl: `https://testnet.arcscan.app/address/${JOB_BOARD_ADDRESS}`,
  };
}

// ─── Routes ──────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", network: "Arc Testnet", contractAddress: JOB_BOARD_ADDRESS });
});

// Config for frontend / clients
app.get("/api/config", (req, res) => {
  res.json({
    jobBoardAddress: JOB_BOARD_ADDRESS,
    usdcAddress: USDC_ADDRESS,
    explorerUrl: "https://testnet.arcscan.app"
  });
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

// Get open jobs
app.get("/api/jobs/open", async (req, res) => {
  try {
    const jobs = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getAllJobs",
    });
    res.json(jobs.map(formatJob).filter(job => job.status === 0));
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
    const address = req.params.address.toLowerCase();
    const jobIds = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getClientJobs",
      args: [address],
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
    const address = req.params.address.toLowerCase();
    const jobIds = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getAgentJobs",
      args: [address],
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

// Get milestones for a specific job
app.get("/api/jobs/:id/milestones", async (req, res) => {
  try {
    const jobId = req.params.id;
    const milestones = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getJobMilestones",
      args: [BigInt(jobId)],
    });
    const formattedMilestones = milestones.map(m => ({
      percentage: Number(m.percentage),
      description: m.description,
      deliverableHash: m.deliverableHash,
      submittedAt: Number(m.submittedAt) * 1000,
      approved: m.approved,
    }));
    res.json(formattedMilestones);
  } catch (error) {
    console.error("Error fetching milestones:", error);
    res.status(500).json({ error: "Failed to fetch milestones" });
  }
});

// Get reviews for a specific worker (AI or Human)
app.get("/api/worker/:address/reviews", async (req, res) => {
  try {
    const reviews = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getWorkerReviews",
      args: [req.params.address],
    });
    res.json(reviews.map(r => ({
      jobId: Number(r.jobId),
      reviewer: r.reviewer,
      worker: r.worker,
      rating: Number(r.rating),
      comment: r.comment,
      timestamp: Number(r.timestamp) * 1000,
    })));
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
      type: "AI",
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
      type: "AI",
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
    {
      id: "human-001",
      type: "Human",
      name: "Claire Jones",
      description: "Experienced researcher and report writer for startups and founders.",
      taskTypes: ["research", "report"],
      walletAddress: process.env.HUMAN_AGENT_1 || "0x0000000000000000000000000000000000000011",
      reputationScore: 92,
      completedJobs: 14,
      isNative: false,
      isVerified: true,
      minBudget: "2.50",
    },
    {
      id: "human-002",
      type: "Human",
      name: "Sam Patel",
      description: "Human operator for compliance checks, writing, and manual workflow support.",
      taskTypes: ["compliance", "review", "monitor"],
      walletAddress: process.env.HUMAN_AGENT_2 || "0x0000000000000000000000000000000000000022",
      reputationScore: 90,
      completedJobs: 9,
      isNative: false,
      isVerified: true,
      minBudget: "3.00",
    },
  ]);
});

// ─── Campaign Routes ──────────────────────────────────────────────

// Get all campaigns
app.get("/api/campaigns", async (req, res) => {
  try {
    const campaigns = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getAllCampaigns",
    });
    const formattedCampaigns = campaigns.map(c => ({
      id: Number(c.id),
      creator: c.creator,
      title: c.title,
      description: c.description,
      prizePool: formatUnits(c.prizePool, 6),
      entryFee: formatUnits(c.entryFee, 6),
      maxParticipants: Number(c.maxParticipants),
      deadline: Number(c.deadline) * 1000,
      expired: c.expired,
      createdAt: Number(c.createdAt) * 1000,
    }));
    res.json(formattedCampaigns);
  } catch (error) {
    console.error("Error fetching campaigns:", error);
    res.status(500).json({ error: "Failed to fetch campaigns" });
  }
});

// Get single campaign
app.get("/api/campaigns/:id", async (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getCampaign",
      args: [BigInt(campaignId)],
    });
    const formatted = {
      id: Number(campaign.id),
      creator: campaign.creator,
      title: campaign.title,
      description: campaign.description,
      prizePool: formatUnits(campaign.prizePool, 6),
      entryFee: formatUnits(c.entryFee, 6),
      maxParticipants: Number(c.maxParticipants),
      deadline: Number(c.deadline) * 1000,
      expired: campaign.expired,
      createdAt: Number(c.createdAt) * 1000,
    };
    res.json(formatted);
  } catch (error) {
    console.error("Error fetching campaign:", error);
    res.status(500).json({ error: "Failed to fetch campaign" });
  }
});

// Get campaign participants
app.get("/api/campaigns/:id/participants", async (req, res) => {
  try {
    const campaignId = req.params.id;
    const participants = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getCampaignParticipants",
      args: [BigInt(campaignId)],
    });
    res.json(participants);
  } catch (error) {
    console.error("Error fetching participants:", error);
    res.status(500).json({ error: "Failed to fetch participants" });
  }
});

// Get campaign winners
app.get("/api/campaigns/:id/winners", async (req, res) => {
  try {
    const campaignId = req.params.id;
    const winners = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getCampaignWinners",
      args: [BigInt(campaignId)],
    });
    res.json(winners);
  } catch (error) {
    console.error("Error fetching winners:", error);
    res.status(500).json({ error: "Failed to fetch winners" });
  }
});

// Get submission for a participant
app.get("/api/campaigns/:id/submission/:address", async (req, res) => {
  try {
    const campaignId = req.params.id;
    const address = req.params.address;
    const submission = await publicClient.readContract({
      address: JOB_BOARD_ADDRESS,
      abi: JOB_BOARD_ABI,
      functionName: "getCampaignSubmission",
      args: [BigInt(campaignId), address],
    });
    res.json({ submission });
  } catch (error) {
    console.error("Error fetching submission:", error);
    res.status(500).json({ error: "Failed to fetch submission" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AgentMarket API running on port ${PORT}`);
  console.log(`Network: Arc Testnet`);
  console.log(`Contract: ${JOB_BOARD_ADDRESS}`);
});
