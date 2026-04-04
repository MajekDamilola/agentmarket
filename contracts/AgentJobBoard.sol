// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * AgentJobBoard - AI Agent Marketplace on Arc Testnet
 * 
 * How it works:
 * 1. Client posts a job and locks USDC into escrow
 * 2. Agent submits their deliverable (a hash proving they did the work)
 * 3. Client approves → USDC released to agent (minus platform fee)
 * 4. Client rejects → USDC returned to client
 */
contract AgentJobBoard {

    // Arc Testnet USDC contract address
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    // Platform owner (you) - receives the fee on every completed job
    address public owner;

    // Platform fee in basis points (250 = 2.5%)
    uint256 public platformFeeBps = 250;

    // Counter for job IDs
    uint256 public jobCount;

    // Job status flow: Open → Funded → Submitted → Completed OR Rejected
    enum JobStatus { Open, Funded, Submitted, Completed, Rejected }

    struct Job {
        uint256 id;
        address client;       // person who posted the job
        address agent;        // agent assigned to the job
        string title;
        string description;
        string taskType;      // e.g. "summarize", "monitor", "report"
        uint256 budget;       // in USDC (6 decimals)
        uint256 deadline;     // unix timestamp
        JobStatus status;
        string deliverableHash; // agent submits proof of work here
        uint256 createdAt;
        uint256 completedAt;
    }

    // All jobs stored by ID
    mapping(uint256 => Job) public jobs;

    // Track jobs per client and per agent
    mapping(address => uint256[]) public clientJobs;
    mapping(address => uint256[]) public agentJobs;

    // Events - these appear on the blockchain explorer
    event JobPosted(uint256 indexed jobId, address indexed client, address indexed agent, string title, uint256 budget);
    event JobFunded(uint256 indexed jobId, uint256 amount);
    event DeliverableSubmitted(uint256 indexed jobId, string deliverableHash);
    event JobCompleted(uint256 indexed jobId, address agent, uint256 agentPayout, uint256 platformFee);
    event JobRejected(uint256 indexed jobId, address client, uint256 refund);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not platform owner");
        _;
    }

    modifier onlyClient(uint256 jobId) {
        require(jobs[jobId].client == msg.sender, "Not the job client");
        _;
    }

    modifier onlyAgent(uint256 jobId) {
        require(jobs[jobId].agent == msg.sender, "Not the assigned agent");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * STEP 1: Client posts a job and funds it immediately
     * Budget must be approved for transfer before calling this
     */
    function postAndFundJob(
        address _agent,
        string calldata _title,
        string calldata _description,
        string calldata _taskType,
        uint256 _budget,
        uint256 _deadlineHours
    ) external returns (uint256) {
        require(_budget > 0, "Budget must be greater than 0");
        require(_agent != address(0), "Invalid agent address");
        require(_deadlineHours > 0 && _deadlineHours <= 720, "Deadline must be 1-720 hours");

        // Transfer USDC from client into this contract (escrow)
        require(
            IERC20(USDC).transferFrom(msg.sender, address(this), _budget),
            "USDC transfer failed - did you approve first?"
        );

        jobCount++;
        uint256 jobId = jobCount;

        jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            agent: _agent,
            title: _title,
            description: _description,
            taskType: _taskType,
            budget: _budget,
            deadline: block.timestamp + (_deadlineHours * 1 hours),
            status: JobStatus.Funded,
            deliverableHash: "",
            createdAt: block.timestamp,
            completedAt: 0
        });

        clientJobs[msg.sender].push(jobId);
        agentJobs[_agent].push(jobId);

        emit JobPosted(jobId, msg.sender, _agent, _title, _budget);
        emit JobFunded(jobId, _budget);

        return jobId;
    }

    /**
     * STEP 2: Agent submits their deliverable hash (proof of work)
     * In production this is an IPFS hash of the actual output
     */
    function submitDeliverable(uint256 jobId, string calldata _deliverableHash) external onlyAgent(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded, "Job must be in Funded status");
        require(block.timestamp <= job.deadline, "Job deadline has passed");

        job.deliverableHash = _deliverableHash;
        job.status = JobStatus.Submitted;

        emit DeliverableSubmitted(jobId, _deliverableHash);
    }

    /**
     * STEP 3A: Client approves the work → agent gets paid
     * Platform fee automatically goes to owner wallet
     */
    function approveJob(uint256 jobId) external onlyClient(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Submitted, "Deliverable not yet submitted");

        uint256 fee = (job.budget * platformFeeBps) / 10000;
        uint256 agentPayout = job.budget - fee;

        job.status = JobStatus.Completed;
        job.completedAt = block.timestamp;

        // Pay agent
        IERC20(USDC).transfer(job.agent, agentPayout);
        // Pay platform (you)
        if (fee > 0) IERC20(USDC).transfer(owner, fee);

        emit JobCompleted(jobId, job.agent, agentPayout, fee);
    }

    /**
     * STEP 3B: Client rejects the work → full refund
     */
    function rejectJob(uint256 jobId) external onlyClient(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Submitted, "Deliverable not yet submitted");

        job.status = JobStatus.Rejected;

        // Refund client in full
        IERC20(USDC).transfer(job.client, job.budget);

        emit JobRejected(jobId, job.client, job.budget);
    }

    /**
     * If deadline passes and agent never submitted → client can claim refund
     */
    function claimExpiredJob(uint256 jobId) external onlyClient(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded, "Job not in funded state");
        require(block.timestamp > job.deadline, "Deadline not reached yet");

        job.status = JobStatus.Rejected;
        IERC20(USDC).transfer(job.client, job.budget);

        emit JobRejected(jobId, job.client, job.budget);
    }

    // ── Read functions ──────────────────────────────────────────

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function getClientJobs(address client) external view returns (uint256[] memory) {
        return clientJobs[client];
    }

    function getAgentJobs(address agent) external view returns (uint256[] memory) {
        return agentJobs[agent];
    }

    function getAllJobs() external view returns (Job[] memory) {
        Job[] memory all = new Job[](jobCount);
        for (uint256 i = 1; i <= jobCount; i++) {
            all[i - 1] = jobs[i];
        }
        return all;
    }

    // ── Owner admin ─────────────────────────────────────────────

    function setPlatformFee(uint256 _bps) external onlyOwner {
        require(_bps <= 1000, "Fee cannot exceed 10%");
        platformFeeBps = _bps;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}
