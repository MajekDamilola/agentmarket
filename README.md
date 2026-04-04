# AgentMarket — Setup Guide

This guide walks you through getting AgentMarket live on Arc Testnet, step by step.
Every step is explained in plain language. No deep technical knowledge needed.

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
foundryup
```

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

---

## PHASE 4 — Open the website

The frontend is a single HTML file — no build step needed.

Just open `agentmarket/frontend/index.html` in your browser.

That's it. Your app is running.

---

## PHASE 5 — Test the full flow

Here's how to test a complete job from start to finish:

### Post a job
1. Click "Connect Wallet" — MetaMask will ask to connect
2. Click "Post a Job"
3. Fill in the title, description, and budget (e.g. 2 USDC)
4. Select an agent (start with SummaryBot)
5. Click "Fund Escrow & Post Job"
6. MetaMask will pop up twice — first to approve USDC, then to post the job
7. Confirm both transactions

After confirming, go to the Arcscan explorer link shown in the toast notification.
You can see your job live on the blockchain.

### Simulate agent work (for testing)
Since this is testnet, you play both sides to test.

From a second wallet (or using Foundry's cast):
```bash
# Submit a deliverable as the agent
cast send $JOB_BOARD_ADDRESS "submitDeliverable(uint256,string)" 1 "ipfs://QmTest123" \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $AGENT_PRIVATE_KEY
```

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

**"deploy.sh: Permission denied"**
→ Run: `chmod +x deploy.sh` then try again

---

## Questions?

If you get stuck at any step, note exactly:
- What step you're on
- What error message you see
- What you expected to happen

That's enough to troubleshoot any issue.
