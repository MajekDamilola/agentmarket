<<<<<<< HEAD
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * AgentJobBoard - AI and Human Worker Marketplace on Arc Testnet
 * 
 * How it works:
 * 1. Client posts a job and locks USDC into escrow
 * 2. Agent or human worker submits their deliverable
 * 3. Client approves → USDC released to worker (minus platform fee)
 * 4. Client rejects → USDC returned to client
 * 5. Client leaves a review for the worker after completion
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

    enum JobStatus { Open, Funded, Submitted, Completed, Rejected }
    enum WorkerType { AI, Human }

    struct JobParams {
        address agent;
        string title;
        string description;
        string category;
        uint8 workerType;
        uint256 budget;
        uint256 deadlineHours;
        string[] milestoneDescriptions;
        uint256[] milestonePercentages;
    }

    struct Job {
        uint256 id;
        address client;
        address agent;
        string title;
        string description;
        string taskType;
        string category;
        WorkerType workerType;
        uint256 budget;
        uint256 deadline;
        JobStatus status;
        string deliverableHash;
        uint256 createdAt;
        uint256 completedAt;
        uint256 pickedAt;
        uint256 milestonesCount;
        uint256 completedMilestones;
    }

    struct Milestone {
        uint256 jobId;
        uint256 milestoneId;
        string description;
        uint256 percentage; // in basis points, e.g. 2500 = 25%
        bool completed;
        string deliverableHash;
        uint256 completedAt;
    }

    mapping(uint256 => Milestone[]) public jobMilestones;


    struct Review {
        uint256 jobId;
        address reviewer;
        address worker;
        uint8 rating;
        string comment;
        uint256 createdAt;
    }

    mapping(uint256 => Job) public jobs;
    mapping(address => uint256[]) public clientJobs;
    mapping(address => uint256[]) public agentJobs;
    mapping(address => Review[]) private workerReviews;
    mapping(uint256 => bool) public jobReviewed;

    // Bounty Campaigns
    struct Campaign {
        uint256 id;
        address creator;
        string title;
        string description;
        uint256 prizePool;
        uint256 entryFee;
        uint256 maxParticipants;
        uint256 deadline;
        bool expired;
        uint256 createdAt;
    }

    mapping(uint256 => Campaign) public campaigns;
    mapping(uint256 => mapping(address => string)) public campaignSubmissions;
    mapping(uint256 => address[]) public campaignParticipants;
    mapping(uint256 => address[]) public campaignWinners;
    uint256 public campaignCount;

    event JobPosted(
        uint256 indexed jobId,
        address indexed client,
        address indexed agent,
        string title,
        string category,
        uint256 budget,
        uint8 workerType
    );
    event JobFunded(uint256 indexed jobId, uint256 amount);
    event JobClaimed(uint256 indexed jobId, address indexed agent);
    event JobReopened(uint256 indexed jobId);
    event DeliverableSubmitted(uint256 indexed jobId, string deliverableHash);
    event JobCompleted(uint256 indexed jobId, address agent, uint256 agentPayout, uint256 platformFee);
    event JobRejected(uint256 indexed jobId, address client, uint256 refund);
    event ReviewSubmitted(uint256 indexed jobId, address indexed reviewer, address indexed worker, uint8 rating);

    // Bounty Campaign Events
    event CampaignCreated(uint256 indexed campaignId, address indexed creator, string title, uint256 prizePool);
    event ParticipantRegistered(uint256 indexed campaignId, address indexed participant);
    event EntrySubmitted(uint256 indexed campaignId, address indexed participant, string submissionURI);
    event WinnersSelected(uint256 indexed campaignId, address[] winners, uint256 prizePerWinner);
    event CampaignExpired(uint256 indexed campaignId, address creator, uint256 refund);

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

    function postAndFundJob(JobParams calldata params) external returns (uint256) {
        require(params.budget > 0, "Budget must be greater than 0");
        require(bytes(params.category).length > 0, "Category is required");
        require(params.workerType <= uint8(WorkerType.Human), "Invalid worker type");
        require(params.deadlineHours > 0 && params.deadlineHours <= 720, "Deadline must be 1-720 hours");
        require(params.milestoneDescriptions.length == params.milestonePercentages.length, "Milestone arrays must match");
        // Milestones are optional; if none, use single deliverable

        if (params.milestoneDescriptions.length > 0) {
            uint256 totalPercentage = 0;
            for (uint256 i = 0; i < params.milestonePercentages.length; i++) {
                totalPercentage += params.milestonePercentages[i];
            }
            require(totalPercentage == 10000, "Milestone percentages must sum to 100%");
        }

        require(
            IERC20(USDC).transferFrom(msg.sender, address(this), params.budget),
            "USDC transfer failed - did you approve first?"
        );

        jobCount++;
        uint256 jobId = jobCount;

        JobStatus initialStatus = params.agent == address(0) ? JobStatus.Open : JobStatus.Funded;
        jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            agent: params.agent,
            title: params.title,
            description: params.description,
            taskType: "",
            category: params.category,
            workerType: WorkerType(params.workerType),
            budget: params.budget,
            deadline: block.timestamp + (params.deadlineHours * 1 hours),
            status: initialStatus,
            deliverableHash: "",
            createdAt: block.timestamp,
            completedAt: 0,
            pickedAt: 0,
            milestonesCount: params.milestoneDescriptions.length,
            completedMilestones: 0
        });

        for (uint256 i = 0; i < params.milestoneDescriptions.length; i++) {
            jobMilestones[jobId].push(Milestone({
                jobId: jobId,
                milestoneId: i + 1,
                description: params.milestoneDescriptions[i],
                percentage: params.milestonePercentages[i],
                completed: false,
                deliverableHash: "",
                completedAt: 0
            }));
        }

        clientJobs[msg.sender].push(jobId);
        if (params.agent != address(0)) {
            agentJobs[params.agent].push(jobId);
        }

        emit JobPosted(jobId, msg.sender, params.agent, params.title, params.category, params.budget, params.workerType);
        if (params.agent != address(0)) {
            emit JobFunded(jobId, params.budget);
        }

        return jobId;
    }

    function submitMilestoneDeliverable(uint256 jobId, uint256 milestoneId, string calldata _deliverableHash) external onlyAgent(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded, "Job must be in Funded status");
        require(milestoneId > 0 && milestoneId <= job.milestonesCount, "Invalid milestone ID");
        require(!jobMilestones[jobId][milestoneId - 1].completed, "Milestone already completed");

        jobMilestones[jobId][milestoneId - 1].deliverableHash = _deliverableHash;

        emit DeliverableSubmitted(jobId, _deliverableHash);
    }

    function submitDeliverable(uint256 jobId, string calldata _deliverableHash) external onlyAgent(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded, "Job must be in Funded status");
        require(block.timestamp <= job.deadline, "Job deadline has passed");
        require(job.milestonesCount == 0, "Use milestone functions for milestone jobs");

        job.deliverableHash = _deliverableHash;
        job.status = JobStatus.Submitted;

        emit DeliverableSubmitted(jobId, _deliverableHash);
    }

    function approveMilestone(uint256 jobId, uint256 milestoneId) external onlyClient(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded, "Job must be in Funded status");
        require(milestoneId > 0 && milestoneId <= job.milestonesCount, "Invalid milestone ID");
        require(bytes(jobMilestones[jobId][milestoneId - 1].deliverableHash).length > 0, "No deliverable submitted");

        Milestone storage milestone = jobMilestones[jobId][milestoneId - 1];
        require(!milestone.completed, "Milestone already completed");

        milestone.completed = true;
        milestone.completedAt = block.timestamp;
        job.completedMilestones++;

        uint256 payout = (job.budget * milestone.percentage) / 10000;
        uint256 fee = (payout * platformFeeBps) / 10000;
        uint256 agentPayout = payout - fee;

        IERC20(USDC).transfer(job.agent, agentPayout);
        if (fee > 0) IERC20(USDC).transfer(owner, fee);

        if (job.completedMilestones == job.milestonesCount) {
            job.status = JobStatus.Completed;
            job.completedAt = block.timestamp;
            emit JobCompleted(jobId, job.agent, 0, 0); // No additional payout
        }

        emit JobCompleted(jobId, job.agent, agentPayout, fee);
    }

    function claimJob(uint256 jobId) external {
        Job storage job = jobs[jobId];
        require(job.client != address(0), "Job does not exist");
        require(job.status == JobStatus.Open, "Job is not available");
        require(block.timestamp <= job.deadline, "Job deadline has passed");
        require(msg.sender != job.client, "Client cannot claim their own job");

        job.agent = msg.sender;
        job.status = JobStatus.Funded;
        job.pickedAt = block.timestamp;
        agentJobs[msg.sender].push(jobId);

        emit JobClaimed(jobId, msg.sender);
        emit JobFunded(jobId, job.budget);
    }

    function reopenJob(uint256 jobId) external onlyClient(jobId) {
        Job storage job = jobs[jobId];
        require(job.client != address(0), "Job does not exist");
        require(job.status == JobStatus.Funded, "Job is not in progress");
        require(job.agent != address(0), "Job has no assigned agent");
        require(job.pickedAt > 0, "Job has not been claimed");
        require(block.timestamp > job.pickedAt + 24 hours, "Claim window has not expired");
        require(bytes(job.deliverableHash).length == 0, "Deliverable already submitted");

        job.agent = address(0);
        job.status = JobStatus.Open;
        job.pickedAt = 0;

        emit JobReopened(jobId);
    }

    function approveJob(uint256 jobId) external onlyClient(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Submitted, "Deliverable not yet submitted");
        require(job.milestonesCount == 0, "Use approveMilestone for milestone jobs");

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
        require(job.status == JobStatus.Submitted, "Deliverable not yet submitted");

        job.status = JobStatus.Rejected;
        IERC20(USDC).transfer(job.client, job.budget);

        emit JobRejected(jobId, job.client, job.budget);
    }

    function claimExpiredJob(uint256 jobId) external onlyClient(jobId) {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Funded, "Job not in funded state");
        require(block.timestamp > job.deadline, "Deadline not reached yet");

        job.status = JobStatus.Rejected;
        IERC20(USDC).transfer(job.client, job.budget);

        emit JobRejected(jobId, job.client, job.budget);
    }

    function submitReview(uint256 jobId, uint8 rating, string calldata comment) external {
        Job storage job = jobs[jobId];
        require(job.status == JobStatus.Completed, "Job must be completed");
        require(job.client == msg.sender, "Only client can submit review");
        require(!jobReviewed[jobId], "Review already submitted");
        require(rating >= 1 && rating <= 5, "Rating must be 1-5");
        require(bytes(comment).length > 0, "Comment cannot be empty");

        workerReviews[job.agent].push(Review({
            jobId: jobId,
            reviewer: msg.sender,
            worker: job.agent,
            rating: rating,
            comment: comment,
            createdAt: block.timestamp
        }));
        jobReviewed[jobId] = true;

        emit ReviewSubmitted(jobId, msg.sender, job.agent, rating);
    }

    function getJobMilestones(uint256 jobId) external view returns (Milestone[] memory) {
        return jobMilestones[jobId];
    }

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

    function setPlatformFee(uint256 _bps) external onlyOwner {
        require(_bps <= 1000, "Fee cannot exceed 10%");
        platformFeeBps = _bps;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // ─── Bounty Campaign Functions ─────────────────────────────────────

    function createCampaign(
        string calldata title,
        string calldata description,
        uint256 prizePool,
        uint256 entryFee,
        uint256 maxParticipants,
        uint256 deadlineHours
    ) external returns (uint256) {
        require(prizePool > 0, "Prize pool must be > 0");
        require(deadlineHours > 0, "Deadline must be > 0");
        uint256 deadline = block.timestamp + (deadlineHours * 1 hours);

        require(
            IERC20(USDC).transferFrom(msg.sender, address(this), prizePool),
            "USDC transfer failed - did you approve first?"
        );

        campaignCount++;
        uint256 campaignId = campaignCount;

        campaigns[campaignId] = Campaign({
            id: campaignId,
            creator: msg.sender,
            title: title,
            description: description,
            prizePool: prizePool,
            entryFee: entryFee,
            maxParticipants: maxParticipants,
            deadline: deadline,
            expired: false,
            createdAt: block.timestamp
        });

        emit CampaignCreated(campaignId, msg.sender, title, prizePool);

        return campaignId;
    }

    function register(uint256 campaignId) external {
        Campaign storage campaign = campaigns[campaignId];
        require(campaign.id != 0, "Campaign does not exist");
        require(block.timestamp < campaign.deadline, "Campaign deadline passed");
        require(
            campaignParticipants[campaignId].length < campaign.maxParticipants || campaign.maxParticipants == 0,
            "Max participants reached"
        );
        require(!isParticipant(campaignId, msg.sender), "Already registered");

        if (campaign.entryFee > 0) {
            require(
                IERC20(USDC).transferFrom(msg.sender, address(this), campaign.entryFee),
                "Entry fee transfer failed"
            );
        }

        campaignParticipants[campaignId].push(msg.sender);

        emit ParticipantRegistered(campaignId, msg.sender);
    }

    function isParticipant(uint256 campaignId, address participant) internal view returns (bool) {
        address[] memory participants = campaignParticipants[campaignId];
        for (uint256 i = 0; i < participants.length; i++) {
            if (participants[i] == participant) return true;
        }
        return false;
    }

    function submitEntry(uint256 campaignId, string calldata submissionURI) external {
        require(isParticipant(campaignId, msg.sender), "Not registered for campaign");
        Campaign storage campaign = campaigns[campaignId];
        require(block.timestamp < campaign.deadline, "Deadline passed");
        require(bytes(campaignSubmissions[campaignId][msg.sender]).length == 0, "Already submitted");

        campaignSubmissions[campaignId][msg.sender] = submissionURI;

        emit EntrySubmitted(campaignId, msg.sender, submissionURI);
    }

    function selectWinners(uint256 campaignId, address[] calldata winners) external {
        Campaign storage campaign = campaigns[campaignId];
        require(msg.sender == campaign.creator, "Only creator can select winners");
        require(campaignWinners[campaignId].length == 0, "Winners already selected");
        require(winners.length > 0, "At least one winner required");

        for (uint256 i = 0; i < winners.length; i++) {
            require(isParticipant(campaignId, winners[i]), "Winner not a participant");
        }

        campaignWinners[campaignId] = winners;

        uint256 prizePerWinner = campaign.prizePool / winners.length;
        for (uint256 i = 0; i < winners.length; i++) {
            require(IERC20(USDC).transfer(winners[i], prizePerWinner), "Prize transfer failed");
        }

        emit WinnersSelected(campaignId, winners, prizePerWinner);
    }

    function expireCampaign(uint256 campaignId) external {
        Campaign storage campaign = campaigns[campaignId];
        require(msg.sender == campaign.creator, "Only creator can expire");
        require(block.timestamp > campaign.deadline, "Deadline not passed");
        require(campaignWinners[campaignId].length == 0, "Winners already selected");
        require(!campaign.expired, "Already expired");

        campaign.expired = true;

        uint256 refund = campaign.prizePool;
        require(IERC20(USDC).transfer(campaign.creator, refund), "Refund failed");

        emit CampaignExpired(campaignId, campaign.creator, refund);
    }

    // ─── Bounty Campaign View Functions ───────────────────────────────

    function getCampaign(uint256 campaignId) external view returns (Campaign memory) {
        return campaigns[campaignId];
    }

    function getCampaignParticipants(uint256 campaignId) external view returns (address[] memory) {
        return campaignParticipants[campaignId];
    }

    function getCampaignWinners(uint256 campaignId) external view returns (address[] memory) {
        return campaignWinners[campaignId];
    }

    function getCampaignSubmission(uint256 campaignId, address participant) external view returns (string memory) {
        return campaignSubmissions[campaignId][participant];
    }

    function getAllCampaigns() external view returns (Campaign[] memory) {
        Campaign[] memory all = new Campaign[](campaignCount);
        for (uint256 i = 1; i <= campaignCount; i++) {
            all[i - 1] = campaigns[i];
        }
        return all;
    }
}
=======
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
>>>>>>> 2f9aa069b587e3d3696c154bf256a03598525934
