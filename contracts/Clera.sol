// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract Clera {
    address public constant USDC = 0x3600000000000000000000000000000000000000;
    address public owner;
    uint256 public platformFeeBps = 250;

    enum WorkerType { Human, AI, Any }
    enum JobStatus { Open, Funded, Submitted, Completed, Rejected }
    enum CampaignStatus { Active, Reviewing, Completed, Cancelled }

    struct Job {
        uint256 id;
        address client;
        address worker;
        string title;
        string description;
        string category;
        WorkerType workerType;
        uint256 budget;
        uint256 deadline;
        JobStatus status;
        string deliverableHash;
        uint256 createdAt;
        uint256 completedAt;
        bool isUrgent;
    }

    struct Review {
        address reviewer;
        address reviewee;
        uint256 jobId;
        uint8 rating;
        string comment;
        uint256 createdAt;
    }

    struct WorkerProfile {
        address wallet;
        string name;
        string bio;
        string skills;
        string workerType;
        uint256 totalJobs;
        uint256 totalEarned;
        uint256 totalRating;
        uint256 reviewCount;
        bool isVerified;
        bool isActive;
    }

    struct Campaign {
        uint256 id;
        address sponsor;
        string title;
        string description;
        string category;
        uint256 prizePool;
        uint256 maxParticipants;
        uint256 registrationDeadline;
        uint256 submissionDeadline;
        uint256 registeredCount;
        uint256 submissionCount;
        CampaignStatus status;
        uint256 createdAt;
        string rewardStructure;
    }

    struct CampaignSubmission {
        uint256 id;
        uint256 campaignId;
        address participant;
        string submissionLink;
        string submissionType;
        uint256 submittedAt;
        bool isWinner;
        uint256 reward;
    }

    uint256 public jobCount;
    uint256 public reviewCount;
    uint256 public campaignCount;

    mapping(uint256 => Job) public jobs;
    mapping(address => uint256[]) public clientJobs;
    mapping(address => uint256[]) public workerJobs;
    mapping(address => WorkerProfile) public workerProfiles;
    mapping(uint256 => Review) public reviews;
    mapping(uint256 => uint256) public jobReview;
    mapping(uint256 => Campaign) public campaigns;
    mapping(uint256 => mapping(address => bool)) public campaignRegistered;
    mapping(uint256 => mapping(address => bool)) public campaignSubmitted;
    mapping(uint256 => CampaignSubmission[]) public campaignSubmissions;
    mapping(uint256 => address[]) public campaignParticipants;
    mapping(address => uint256[]) public sponsorCampaigns;
    mapping(address => uint256[]) public participantCampaigns;
    address[] public registeredWorkers;

    event JobPosted(uint256 indexed jobId, address indexed client, string title, string category, uint256 budget);
    event JobCompleted(uint256 indexed jobId, address worker, uint256 payout);
    event JobRejected(uint256 indexed jobId);
    event ReviewPosted(uint256 indexed reviewId, uint256 indexed jobId, address reviewer, uint8 rating);
    event WorkerRegistered(address indexed worker, string name);
    event CampaignCreated(uint256 indexed campaignId, address indexed sponsor, string title, uint256 prizePool);
    event CampaignRegistration(uint256 indexed campaignId, address indexed participant);
    event SubmissionReceived(uint256 indexed campaignId, address indexed participant);
    event CampaignWinnersSelected(uint256 indexed campaignId);

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
    modifier onlyClient(uint256 jobId) { require(jobs[jobId].client == msg.sender, "Not client"); _; }
    modifier onlyWorker(uint256 jobId) { require(jobs[jobId].worker == msg.sender, "Not worker"); _; }

    constructor() { owner = msg.sender; }

    function postAndFundJob(
        address _worker, string calldata _title, string calldata _description,
        string calldata _category, uint8 _workerType, uint256 _budget,
        uint256 _deadlineHours, bool _isUrgent
    ) external returns (uint256) {
        require(_budget > 0, "Budget required");
        require(_worker != address(0), "Invalid worker");
        require(IERC20(USDC).transferFrom(msg.sender, address(this), _budget), "Transfer failed");

        jobCount++;
        jobs[jobCount] = Job(jobCount, msg.sender, _worker, _title, _description, _category,
            WorkerType(_workerType), _budget, block.timestamp + (_deadlineHours * 1 hours),
            JobStatus.Funded, "", block.timestamp, 0, _isUrgent);

        clientJobs[msg.sender].push(jobCount);
        workerJobs[_worker].push(jobCount);
        emit JobPosted(jobCount, msg.sender, _title, _category, _budget);
        return jobCount;
    }

    function submitDeliverable(uint256 _jobId, string calldata _hash) external onlyWorker(_jobId) {
        require(jobs[_jobId].status == JobStatus.Funded, "Not funded");
        jobs[_jobId].deliverableHash = _hash;
        jobs[_jobId].status = JobStatus.Submitted;
    }

    function approveJob(uint256 _jobId) external onlyClient(_jobId) {
        Job storage job = jobs[_jobId];
        require(job.status == JobStatus.Submitted, "Not submitted");
        uint256 fee = (job.budget * platformFeeBps) / 10000;
        uint256 payout = job.budget - fee;
        job.status = JobStatus.Completed;
        job.completedAt = block.timestamp;
        IERC20(USDC).transfer(job.worker, payout);
        if (fee > 0) IERC20(USDC).transfer(owner, fee);
        workerProfiles[job.worker].totalJobs++;
        workerProfiles[job.worker].totalEarned += payout;
        emit JobCompleted(_jobId, job.worker, payout);
    }

    function rejectJob(uint256 _jobId) external onlyClient(_jobId) {
        require(jobs[_jobId].status == JobStatus.Submitted, "Not submitted");
        jobs[_jobId].status = JobStatus.Rejected;
        IERC20(USDC).transfer(jobs[_jobId].client, jobs[_jobId].budget);
        emit JobRejected(_jobId);
    }

    function leaveReview(uint256 _jobId, uint8 _rating, string calldata _comment) external {
        Job storage job = jobs[_jobId];
        require(job.status == JobStatus.Completed, "Not completed");
        require(msg.sender == job.client || msg.sender == job.worker, "Not participant");
        require(jobReview[_jobId] == 0, "Already reviewed");
        require(_rating >= 1 && _rating <= 5, "Rating 1-5");
        address reviewee = msg.sender == job.client ? job.worker : job.client;
        reviewCount++;
        reviews[reviewCount] = Review(msg.sender, reviewee, _jobId, _rating, _comment, block.timestamp);
        jobReview[_jobId] = reviewCount;
        workerProfiles[reviewee].totalRating += _rating;
        workerProfiles[reviewee].reviewCount++;
        emit ReviewPosted(reviewCount, _jobId, msg.sender, _rating);
    }

    function registerWorker(string calldata _name, string calldata _bio, string calldata _skills, string calldata _workerType) external {
        if (!workerProfiles[msg.sender].isActive) registeredWorkers.push(msg.sender);
        workerProfiles[msg.sender] = WorkerProfile(msg.sender, _name, _bio, _skills, _workerType, 0, 0, 0, 0, false, true);
        emit WorkerRegistered(msg.sender, _name);
    }

    function verifyWorker(address _worker) external onlyOwner { workerProfiles[_worker].isVerified = true; }

    function createCampaign(
        string calldata _title, string calldata _description, string calldata _category,
        uint256 _prizePool, uint256 _maxParticipants, uint256 _registrationDays,
        uint256 _submissionDays, string calldata _rewardStructure
    ) external returns (uint256) {
        require(_prizePool > 0, "Prize pool required");
        require(IERC20(USDC).transferFrom(msg.sender, address(this), _prizePool), "Transfer failed");
        campaignCount++;
        campaigns[campaignCount] = Campaign(campaignCount, msg.sender, _title, _description, _category,
            _prizePool, _maxParticipants, block.timestamp + (_registrationDays * 1 days),
            block.timestamp + ((_registrationDays + _submissionDays) * 1 days),
            0, 0, CampaignStatus.Active, block.timestamp, _rewardStructure);
        sponsorCampaigns[msg.sender].push(campaignCount);
        emit CampaignCreated(campaignCount, msg.sender, _title, _prizePool);
        return campaignCount;
    }

    function registerForCampaign(uint256 _campaignId) external {
        Campaign storage c = campaigns[_campaignId];
        require(c.status == CampaignStatus.Active, "Not active");
        require(block.timestamp <= c.registrationDeadline, "Registration closed");
        require(!campaignRegistered[_campaignId][msg.sender], "Already registered");
        require(c.registeredCount < c.maxParticipants, "Campaign full");
        campaignRegistered[_campaignId][msg.sender] = true;
        c.registeredCount++;
        campaignParticipants[_campaignId].push(msg.sender);
        participantCampaigns[msg.sender].push(_campaignId);
        emit CampaignRegistration(_campaignId, msg.sender);
    }

    function submitCampaignWork(uint256 _campaignId, string calldata _link, string calldata _type) external {
        Campaign storage c = campaigns[_campaignId];
        require(c.status == CampaignStatus.Active, "Not active");
        require(campaignRegistered[_campaignId][msg.sender], "Not registered");
        require(!campaignSubmitted[_campaignId][msg.sender], "Already submitted");
        require(block.timestamp <= c.submissionDeadline, "Submission closed");
        campaignSubmitted[_campaignId][msg.sender] = true;
        c.submissionCount++;
        campaignSubmissions[_campaignId].push(CampaignSubmission(
            campaignSubmissions[_campaignId].length, _campaignId, msg.sender, _link, _type, block.timestamp, false, 0));
        emit SubmissionReceived(_campaignId, msg.sender);
    }

    function selectWinners(uint256 _campaignId, address[] calldata _winners, uint256[] calldata _rewards) external {
        Campaign storage c = campaigns[_campaignId];
        require(msg.sender == c.sponsor || msg.sender == owner, "Not sponsor");
        require(c.status == CampaignStatus.Active, "Not active");
        require(_winners.length == _rewards.length, "Mismatch");
        uint256 total = 0;
        for (uint256 i = 0; i < _rewards.length; i++) total += _rewards[i];
        require(total <= c.prizePool, "Exceeds pool");
        c.status = CampaignStatus.Completed;
        for (uint256 i = 0; i < _winners.length; i++) IERC20(USDC).transfer(_winners[i], _rewards[i]);
        uint256 remainder = c.prizePool - total;
        if (remainder > 0) IERC20(USDC).transfer(c.sponsor, remainder);
        emit CampaignWinnersSelected(_campaignId);
    }

    function cancelCampaign(uint256 _campaignId) external {
        Campaign storage c = campaigns[_campaignId];
        require(msg.sender == c.sponsor || msg.sender == owner, "Not sponsor");
        require(c.status == CampaignStatus.Active, "Not active");
        c.status = CampaignStatus.Cancelled;
        IERC20(USDC).transfer(c.sponsor, c.prizePool);
    }

    function getJob(uint256 _jobId) external view returns (Job memory) { return jobs[_jobId]; }
    function getClientJobs(address _client) external view returns (uint256[] memory) { return clientJobs[_client]; }
    function getWorkerJobs(address _worker) external view returns (uint256[] memory) { return workerJobs[_worker]; }
    function getCampaign(uint256 _id) external view returns (Campaign memory) { return campaigns[_id]; }
    function getCampaignSubmissions(uint256 _id) external view returns (CampaignSubmission[] memory) { return campaignSubmissions[_id]; }
    function getWorkerProfile(address _worker) external view returns (WorkerProfile memory) { return workerProfiles[_worker]; }
    function getReview(uint256 _reviewId) external view returns (Review memory) { return reviews[_reviewId]; }
    function getAllWorkers() external view returns (address[] memory) { return registeredWorkers; }
    function getAllJobs() external view returns (Job[] memory) {
        Job[] memory all = new Job[](jobCount);
        for (uint256 i = 1; i <= jobCount; i++) all[i-1] = jobs[i];
        return all;
    }
    function getAllCampaigns() external view returns (Campaign[] memory) {
        Campaign[] memory all = new Campaign[](campaignCount);
        for (uint256 i = 1; i <= campaignCount; i++) all[i-1] = campaigns[i];
        return all;
    }

    function setPlatformFee(uint256 _bps) external onlyOwner { require(_bps <= 1000, "Max 10%"); platformFeeBps = _bps; }
    function transferOwnership(address _new) external onlyOwner { owner = _new; }
}
