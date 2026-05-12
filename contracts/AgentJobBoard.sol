// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * AgentJobBoard — AI Agent Marketplace on Arc Testnet
 *
 * Flow:
 * 1. Client calls postAndFundJob() — USDC locks in escrow
 * 2. Agent calls submitDeliverable() — job moves to Submitted
 * 3. Client calls approveJob() — USDC releases to agent minus fee
 *    OR client calls rejectJob() — USDC returned to client
 * 4. Client can claimExpiredJob() — refund if agent missed deadline
 */
contract AgentJobBoard {

    address public constant USDC = 0x3600000000000000000000000000000000000000;
    address public owner;
    uint256 public platformFeeBps = 250;
    uint256 public jobCount;

    enum JobStatus { Open, Funded, Submitted, Completed, Rejected }

    struct Job {
        uint256 id;
        address client;
        address agent;
        string  title;
        string  description;
        string  category;
        uint256 budget;
        uint256 deadline;
        JobStatus status;
        string  deliverableUrl;
        uint256 createdAt;
        uint256 completedAt;
    }

    mapping(uint256 => Job) public jobs;
    mapping(address => uint256[]) public clientJobs;
    mapping(address => uint256[]) public agentJobs;

    event JobPosted(uint256 indexed jobId, address indexed client, address indexed agent, string title, string category, uint256 budget);
    event DeliverableSubmitted(uint256 indexed jobId, string deliverableUrl);
    event JobCompleted(uint256 indexed jobId, address agent, uint256 agentPayout, uint256 platformFee);
    event JobRejected(uint256 indexed jobId, address client, uint256 refund);
    event JobExpired(uint256 indexed jobId, address client, uint256 refund);

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
    modifier onlyClient(uint256 jobId) { require(jobs[jobId].client == msg.sender, "Not client"); _; }
    modifier onlyAgent(uint256 jobId) { require(jobs[jobId].agent == msg.sender, "Not agent"); _; }

    constructor() { owner = msg.sender; }

    function postAndFundJob(
        address agent,
        string calldata title,
        string calldata description,
        string calldata category,
        uint256 budget,
        uint256 deadlineHours
    ) external returns (uint256) {
        require(agent != address(0), "Agent required");
        require(agent != msg.sender, "Client cannot be agent");
        require(budget > 0, "Budget required");
        require(bytes(title).length > 0, "Title required");
        require(bytes(category).length > 0, "Category required");
        require(deadlineHours >= 1 && deadlineHours <= 720, "Deadline 1-720 hours");
        require(IERC20(USDC).transferFrom(msg.sender, address(this), budget), "USDC transfer failed");

        jobCount++;
        jobs[jobCount] = Job({
            id: jobCount,
            client: msg.sender,
            agent: agent,
            title: title,
            description: description,
            category: category,
            budget: budget,
            deadline: block.timestamp + (deadlineHours * 1 hours),
            status: JobStatus.Funded,
            deliverableUrl: "",
            createdAt: block.timestamp,
            completedAt: 0
        });

        clientJobs[msg.sender].push(jobCount);
        agentJobs[agent].push(jobCount);
        emit JobPosted(jobCount, msg.sender, agent, title, category, budget);
        return jobCount;
    }

    function submitDeliverable(uint256 jobId, string calldata deliverableUrl) external onlyAgent(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded, "Job must be Funded");
        require(block.timestamp <= job.deadline, "Deadline passed");
        require(bytes(deliverableUrl).length > 0, "URL required");
        job.deliverableUrl = deliverableUrl;
        job.status = JobStatus.Submitted;
        emit DeliverableSubmitted(jobId, deliverableUrl);
    }

    function approveJob(uint256 jobId) external onlyClient(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Submitted, "Not submitted");
        uint256 fee = (job.budget * platformFeeBps) / 10000;
        uint256 agentPayout = job.budget - fee;
        job.status = JobStatus.Completed;
        job.completedAt = block.timestamp;
        IERC20(USDC).transfer(job.agent, agentPayout);
        if (fee > 0) IERC20(USDC).transfer(owner, fee);
        emit JobCompleted(jobId, job.agent, agentPayout, fee);
    }

    function rejectJob(uint256 jobId) external onlyClient(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Submitted, "Not submitted");
        job.status = JobStatus.Rejected;
        IERC20(USDC).transfer(job.client, job.budget);
        emit JobRejected(jobId, job.client, job.budget);
    }

    function claimExpiredJob(uint256 jobId) external onlyClient(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded || job.status == JobStatus.Open, "Not refundable");
        require(block.timestamp > job.deadline, "Not expired yet");
        job.status = JobStatus.Rejected;
        IERC20(USDC).transfer(job.client, job.budget);
        emit JobExpired(jobId, job.client, job.budget);
    }

    function getJob(uint256 jobId) external view returns (Job memory) { return jobs[jobId]; }
    function getAllJobs() external view returns (Job[] memory) {
        Job[] memory all = new Job[](jobCount);
        for (uint256 i = 1; i <= jobCount; i++) { all[i-1] = jobs[i]; }
        return all;
    }
    function getClientJobs(address client) external view returns (uint256[] memory) { return clientJobs[client]; }
    function getAgentJobs(address agent) external view returns (uint256[] memory) { return agentJobs[agent]; }
    function setPlatformFee(uint256 bps) external onlyOwner { require(bps <= 1000, "Max 10%"); platformFeeBps = bps; }
    function transferOwnership(address newOwner) external onlyOwner { require(newOwner != address(0), "Invalid"); owner = newOwner; }
}
