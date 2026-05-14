import { createWalletClient, createPublicClient, http, parseAbiItem, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const API = 'https://agentmarket-production-0352.up.railway.app';
const RPC = 'https://rpc.testnet.arc.network';
const JOB_BOARD_ADDRESS = '0x3a589F3282e2cb2886E099F43da2b890A89edBFD';
const USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
const PRIVATE_KEY = '0xafb308adbcc38257c6fa09b2102dc037f92e929cab723010ad76286a369efd9a';

const EABI = [
  parseAbiItem('function approve(address spender, uint256 amount) returns (bool)')
];

const BABI = [
  parseAbiItem('function postAndFundJob(address agent, string title, string description, string category, uint256 budget, uint256 deadlineHours) returns (uint256)'),
  parseAbiItem('function approveJob(uint256 jobId)')
];

async function main() {
  console.log('Starting E2E test...');
  const account = privateKeyToAccount(PRIVATE_KEY);
  const client = createWalletClient({
    account,
    chain: { id: 5042002 },
    transport: http(RPC)
  }).extend(publicActions);

  // Get agent list from API
  console.log('Fetching agents from API...');
  const res = await fetch(`${API}/api/agents`);
  const agents = await res.json();
  const agent = agents[0].walletAddress;
  console.log('Using agent:', agent);

  const budget = 2000000n; // 2 USDC

  console.log('Approving USDC...');
  const { request: approveReq } = await client.simulateContract({
    address: USDC_ADDRESS,
    abi: EABI,
    functionName: 'approve',
    args: [JOB_BOARD_ADDRESS, budget]
  });
  const approveTx = await client.writeContract(approveReq);
  await client.waitForTransactionReceipt({ hash: approveTx });
  console.log('USDC approved');

  console.log('Posting job...');
  const { request: postReq } = await client.simulateContract({
    address: JOB_BOARD_ADDRESS,
    abi: BABI,
    functionName: 'postAndFundJob',
    args: [agent, 'Summarize this website', 'Please summarize https://example.com', 'Summary', budget, 24n]
  });
  const postTx = await client.writeContract(postReq);
  const postReceipt = await client.waitForTransactionReceipt({ hash: postTx });
  console.log('Job posted! Tx:', postTx);
  
  // Get job ID from events or just use total jobs count.
  // We can just fetch the latest job for this client from the API.
  console.log('Waiting for backend to process...');
  let jobId = 0;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const jobsRes = await fetch(`${API}/api/client/${account.address}/jobs`);
    const jobs = await jobsRes.json();
    if (jobs.length > 0) {
      const job = jobs[jobs.length - 1];
      jobId = job.id;
      if (job.status === 2) { // Submitted
        console.log(`Job ${jobId} submitted by agent! Deliverable: ${job.deliverableUrl}`);
        break;
      }
      console.log(`Job ${jobId} status is ${job.status}...`);
    }
  }

  if (jobId > 0) {
    const jobRes = await fetch(`${API}/api/jobs/${jobId}`);
    const job = await jobRes.json();
    if (job.status === 2) {
      console.log('Approving job deliverable...');
      const { request: appReq } = await client.simulateContract({
        address: JOB_BOARD_ADDRESS,
        abi: BABI,
        functionName: 'approveJob',
        args: [BigInt(jobId)]
      });
      const appTx = await client.writeContract(appReq);
      await client.waitForTransactionReceipt({ hash: appTx });
      console.log('Job approved! E2E test successful.');
    } else {
      console.log('Agent did not submit deliverable in time.');
    }
  } else {
    console.log('Could not find job.');
  }
}

main().catch(console.error);
