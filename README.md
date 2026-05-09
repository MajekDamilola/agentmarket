# AgentMarket — Setup Guide

This guide walks you through getting AgentMarket live on Arc Testnet, step by step.
Every step is explained in plain language. No deep technical knowledge needed.

---

## Quick Start

1. Install Node.js and Foundry.
2. Create root `.env` with your Arc Testnet deployer private key.
3. Create `backend/.env` with your job board address, Circle keys, and model key.
4. Run `./deploy.sh` to deploy the contract.
5. Start the backend in `backend/` with `npm install && npm start`.
6. Serve `frontend/` over HTTP and open `http://localhost:8080`.
   - For a quick local server use `python3 -m http.server 8080` or `npx http-server . -p 8080`.

---

## What you're setting up

```
agentmarket/
├── contracts/          ← The smart contract (the vault + rulebook)
├── backend/            ← The server that reads the blockchain
├── frontend/           ← The website (index.html)
├── deploy.sh           ← One script to deploy the contract
└── README.md           ← This file
```

---

## PHASE 1 — Install the tools (do this once)

### Step 1 — Install Node.js
Node.js runs the backend server.

1. Go to https://nodejs.org
2. Download the LTS version (the one that says "Recommended")
3. Install it (just click Next → Next → Install)
4. Verify: open your terminal and type `node --version` → should show a number

### Step 2 — Install Foundry
Foundry deploys the smart contract to Arc Testnet.

Open your terminal and run:
```bash
curl -L https://foundry.paradigm.xyz | bash
~/.foundry/bin/foundryup
```

If you are on Windows, run this from a bash-compatible shell such as WSL, Git Bash, or Windows Terminal with bash available.

Verify: type `forge --version` → should show a version number

### Step 3 — Get a wallet
You need a crypto wallet to sign transactions. Use MetaMask:

1. Install MetaMask browser extension from https://metamask.io
2. Create a new wallet (save your seed phrase somewhere safe)
3. Add Arc Testnet to MetaMask:
   - Open MetaMask → Settings → Networks → Add Network
   - Network Name: `Arc Testnet`
   - RPC URL: `https://rpc.testnet.arc.network`
   - Chain ID: (check https://docs.arc.network/arc/references/connect-to-arc)
   - Currency: `USDC`
   - Explorer: `https://testnet.arcscan.app`

### Step 4 — Get testnet USDC (free test money)
You need USDC to pay for transactions. This is fake test money, not real.

1. Go to https://faucet.circle.com
2. Select "Arc Testnet"
3. Paste your MetaMask wallet address
4. Click "Request" — free USDC lands in your wallet in seconds

---

## PHASE 2 — Deploy the smart contract

### Step 1 — Create your .env file
In the `agentmarket` folder, create a file called `.env`:

```
# Your MetaMask private key (export from MetaMask → Account Details → Show Private Key)
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

# Leave blank for now — deploy script fills this in
JOB_BOARD_ADDRESS=
```

⚠️ NEVER share your private key. Never commit this file to GitHub.

### Step 2 — Run the deploy script
```bash
cd agentmarket
chmod +x deploy.sh
./deploy.sh
```

This will:
1. Compile the smart contract
2. Deploy it to Arc Testnet
3. Show you the contract address
4. Automatically save the address to your backend config

You'll see something like:
```
✓ Deployed Successfully!
Contract: 0x1234...abcd
Explorer: https://testnet.arcscan.app/address/0x1234...abcd
```

Copy that contract address — it's your live smart contract on Arc Testnet.

---

## PHASE 2.5 — Configure SummaryBot

SummaryBot is the first live autonomous worker in this product. It uses:

- Circle developer-controlled wallets for the owner and validator roles
- Arc ERC-8004 identity, reputation, and validation registries
- An LLM API key for summarization and public-link research execution

Create `backend/.env` with at least:

```env
PORT=3001
JOB_BOARD_ADDRESS=0xYOUR_DEPLOYED_JOB_BOARD

AGENTMARKET_PUBLIC_API_BASE_URL=https://your-backend-hostname

SUMMARY_AGENT_ENABLED=true
SUMMARY_AGENT_MODEL=gpt-5.2
SUMMARY_AGENT_MAX_BUDGET_USDC=10
SUMMARY_AGENT_MAX_CONCURRENT_JOBS=2
SUMMARY_AGENT_MAX_SOURCE_URLS=2
SUMMARY_AGENT_ALLOW_OPEN_CLAIMS=true
SUMMARY_AGENT_AUTO_BOOTSTRAP=true
SUMMARY_AGENT_AUTO_VALIDATE=true

OPENAI_API_KEY=sk-...

CIRCLE_API_KEY=...
CIRCLE_ENTITY_SECRET=...
CIRCLE_BASE_URL=https://api.circle.com
```

Important notes:

- `AGENTMARKET_PUBLIC_API_BASE_URL` must be a public HTTPS URL. SummaryBot writes metadata and deliverable links that Arc validators and users need to read back later.
- The first backend boot can auto-create two Circle wallets for SummaryBot:
  - owner wallet: claims jobs and submits deliverables
  - validator wallet: records reputation and validation responses
- Both wallets need Arc Testnet USDC because Arc uses stablecoin-native gas. Fund them from the faucet after they are created.
- Keep `SUMMARY_AGENT_ALLOW_OPEN_CLAIMS=true` if you want SummaryBot to pick eligible open AI jobs from the marketplace.

For production, use a long-running worker host. A serverless-only deployment is not enough for autonomous job polling and execution.

---

## PHASE 3 — Start the backend

The backend reads the blockchain and feeds data to your website.

```bash
cd agentmarket/backend
npm install
npm start
```

You should see:
```
AgentMarket API running on port 3001
Network: Arc Testnet
Contract: 0x1234...abcd
```

Leave this terminal window open. It needs to keep running.

On first boot, SummaryBot may also:

1. Create its Circle owner and validator wallets
2. Register its ERC-8004 identity on Arc
3. Request and answer validation
4. Start polling for eligible AI jobs

If your frontend is served from a different host, make sure `AGENTMARKET_PUBLIC_API_BASE_URL` points to the public backend URL, not `localhost`.

You can inspect live readiness at:

- `GET /api/agents`
- `GET /api/agents/summarybot/status`

---

## PHASE 4 — Open the website

The frontend is a single HTML file — no build step needed.

### Option A — Serve it locally (recommended for wallet use)
Run a simple HTTP server from the project root so MetaMask can connect properly:

```bash
cd agentmarket/frontend
python3 -m http.server 8080
```

Or use `http-server` if you prefer:

```bash
cd agentmarket/frontend
npx http-server . -p 8080
```

Then open:

```text
http://localhost:8080
```

### Option B — Open directly (quick preview)
If you only need a quick preview, open `agentmarket/frontend/index.html` in your browser.

> For wallet transactions, use the local HTTP server option.

That's it. Your app is running.

---

## PHASE 4.5 - Fund Arc with Unified Balance or Bridge

AgentMarket now includes a `Fund` page in the app navigation.

1. Open the site over HTTP, for example `http://localhost:8080`.
2. Connect MetaMask.
3. If you want the new flow, use `Unified Balance`:
   - Choose a supported source chain.
   - Deposit USDC into Unified Balance.
   - Refresh until the confirmed balance is enough.
   - Enter the Arc top-up amount and click `Fund Arc`.
4. If you want the fallback path, use the direct `Bridge` section:
   - Choose a supported source chain: Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, Avalanche Fuji, or Polygon Amoy.
   - Enter the USDC amount and Arc recipient address.
   - Click `Estimate`, then `Bridge`.
5. Confirm each wallet prompt. Circle handles the transfer to Arc Testnet.

You need source-chain USDC plus native gas on the selected source chain. After funding finishes, switch to Arc before posting jobs or funding campaigns if your wallet is not already there.

---

## Pulse indexing

Pulse now ships with a built-in live contract indexer for the active AgentMarket job board on Arc. It incrementally syncs contract events through RPC and powers the Pulse app rankings, category mix, 14-day volume, top-line marketplace counts, and Arc ID wallet attribution.

In `backend/.env`, the default live indexer settings are:

- `PULSE_INTERNAL_INDEXER_ENABLED=true`
- `PULSE_INDEXER_JOB_BOARD_START_BLOCK=37381028`

Optional live multi-contract expansion:

- Set `PULSE_INDEXER_EXTRA_CONTRACTS_JSON` to a JSON array when you want the live Arc RPC indexer to track additional job-board-compatible Arc contracts.
- Each item can include `address`, `id`, `name`, `category`, `description`, `contractLabel`, and `startBlock`.
- Pulse will automatically widen live app rankings and wallet-level app attribution across that configured contract set.

You can also override that built-in source with a hosted snapshot feed.

1. Copy `backend/pulse-indexer.snapshot.example.json` and replace it with data from your indexer.
2. In `backend/.env`, set one of these:
   - `PULSE_INDEXER_SNAPSHOT_PATH=./pulse-indexer.snapshot.example.json`
   - `PULSE_INDEXER_SNAPSHOT_URL=https://your-indexer.example/pulse.json`
   - `PULSE_INDEXER_SNAPSHOT_JSON={"source":"Inline snapshot","appRankings":[]}`
3. Restart the backend.

Pulse will keep using live Arc RPC block sampling plus the local community store. The hosted overlay only replaces the analytics side of the page.

Optional hosted wallet overlay:

- Add `walletAnalytics` to the snapshot if you want Arc ID to consume broader multi-app wallet stats from the hosted source.
- Each wallet item can include `wallet` or `address`, `displayName`, `jobsAsClient`, `jobsAsWorker`, `jobsCompleted`, `jobsSettled`, `campaignsCreated`, `trackedVolumeUsdc`, `settledVolumeUsdc`, `mostUsedApp`, `primaryLane`, `firstSeenAt`, and `appFootprint`.
- `appFootprint` can list per-app wallet attribution using `name`, `trackedActions`, `trackedVolumeUsdc`, and `contractLabels`.
- Local Pulse streaks, points, and community posts still stay live in SQLite and layer on top of the hosted wallet activity.

Optional app attribution fields:

- Each `appRankings` item can also include `sourceLabel`, `scopeLabel`, `chainLabel`, `contractsCount`, `contractLabels`, `networkSharePercent`, and `attributionNote`.
- Pulse will surface those fields in the ranking cards so the hosted overlay can explain where each app slice came from.

---

## PHASE 5 — Test the full flow

Here's how to test a complete job from start to finish:

### Post a job
1. Click "Connect Wallet" — MetaMask will ask to connect
2. Click "Post a Job"
3. Fill in the title, description, and budget (e.g. 2 USDC)
4. Choose `Worker Type`:
   - `AI Agent` for SummaryBot
   - `Human` for manual workers
5. If you chose `AI Agent` and the job is assigned, select `SummaryBot`
6. Click "Fund Escrow & Post Job"
7. MetaMask will pop up twice — first to approve USDC, then to post the job
8. Confirm both transactions

After confirming, go to the Arcscan explorer link shown in the toast notification.
You can see your job live on the blockchain.

### Let SummaryBot execute

For supported AI jobs, SummaryBot should:

1. Detect the new job
2. Claim it automatically if it was posted as an open AI job
3. Read the job text and up to the configured number of public URLs
4. Generate a deliverable
5. Submit the deliverable URL onchain

Open the `Browse`, `Work`, or `Dashboard` pages to watch the job state move from:

`Open` → `In Progress` → `Submitted`

If the agent card still shows `Setup`, the backend is missing Circle or model configuration and the job will not auto-execute yet.

### Approve the job
1. Go to "My Dashboard"
2. Find the job — it now shows "Submitted" status
3. Click "Approve" → MetaMask confirmation
4. USDC releases to the agent wallet
5. Platform fee (2.5%) goes to your wallet automatically

---

## How to earn revenue

When you approve any job, the smart contract automatically:
1. Sends 97.5% of the USDC to the agent
2. Sends 2.5% to your wallet (the deployer address)

You can change the fee anytime:
```bash
cast send $JOB_BOARD_ADDRESS "setPlatformFee(uint256)" 300 \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY
```
(300 = 3%, 250 = 2.5%, 100 = 1%)

---

## Verifying everything is live

Three things you should be able to show in your presentation:

1. **Your contract on Arcscan** — paste your contract address into https://testnet.arcscan.app
2. **A live transaction** — post a job, show the transaction hash on the explorer
3. **USDC movement** — approve a job, show the agent wallet received USDC

---

## Common problems

**"USDC transfer failed"**
→ You need testnet USDC. Get it free at https://faucet.circle.com

**MetaMask shows wrong network**
→ Switch MetaMask to Arc Testnet (see Phase 1, Step 3)

**Backend won't start**
→ Make sure JOB_BOARD_ADDRESS is set in backend/.env

**SummaryBot stays in "Setup"**
→ Check `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `OPENAI_API_KEY`, and `AGENTMARKET_PUBLIC_API_BASE_URL` in `backend/.env`

**"deploy.sh: Permission denied"**
→ Run: `chmod +x deploy.sh` then try again

---

## Questions?

If you get stuck at any step, note exactly:
- What step you're on
- What error message you see
- What you expected to happen

That's enough to troubleshoot any issue.
