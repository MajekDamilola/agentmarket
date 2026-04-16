#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# AgentMarket — Deploy to Arc Testnet
# Run this after setting up your .env file
# ═══════════════════════════════════════════════════════════════

set -e

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  AgentMarket — Arc Testnet Deploy"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Load env
source .env

# Check required vars
if [ -z "$PRIVATE_KEY" ]; then
  echo "ERROR: PRIVATE_KEY not set in .env"
  exit 1
fi

# Normalize private key format for forge
PRIVATE_KEY=${PRIVATE_KEY#0x}

ARC_RPC="https://rpc.testnet.arc.network"
FORGE_BIN="${FORGE_BIN:-forge}"

echo "▸ Compiling contract..."
"$FORGE_BIN" build --contracts contracts/

echo ""
echo "▸ Deploying AgentJobBoard to Arc Testnet..."
OUTPUT=$("$FORGE_BIN" create contracts/AgentJobBoard.sol:AgentJobBoard \
  --rpc-url $ARC_RPC \
  --private-key $PRIVATE_KEY \
  --broadcast 2>&1)

echo "$OUTPUT"

# Extract deployed address
CONTRACT_ADDRESS=$(echo "$OUTPUT" | grep "Deployed to:" | awk '{print $3}')
TX_HASH=$(echo "$OUTPUT" | grep "Transaction hash:" | awk '{print $3}')

if [ -z "$CONTRACT_ADDRESS" ]; then
  echo "ERROR: Could not find deployed address in output"
  exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ Deployed Successfully!"
echo ""
echo "  Contract: $CONTRACT_ADDRESS"
echo "  Explorer: https://testnet.arcscan.app/address/$CONTRACT_ADDRESS"
echo "  Tx:       https://testnet.arcscan.app/tx/$TX_HASH"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "▸ Saving contract address..."

# Update backend .env
if [ -f "backend/.env" ]; then
  sed -i "s|JOB_BOARD_ADDRESS=.*|JOB_BOARD_ADDRESS=$CONTRACT_ADDRESS|" backend/.env
else
  cp backend/.env.example backend/.env
  sed -i "s|JOB_BOARD_ADDRESS=.*|JOB_BOARD_ADDRESS=$CONTRACT_ADDRESS|" backend/.env
fi

# Update root .env so frontend and tools can see the deployed address
if grep -q '^JOB_BOARD_ADDRESS=' .env; then
  sed -i "s|^JOB_BOARD_ADDRESS=.*|JOB_BOARD_ADDRESS=$CONTRACT_ADDRESS|" .env
else
  echo "JOB_BOARD_ADDRESS=$CONTRACT_ADDRESS" >> .env
fi

# Update frontend fallback address
if [ -f "frontend/index.html" ]; then
  sed -i -E "s#let JOB_BOARD = (window\\.JOB_BOARD_ADDRESS \\|\\| )?'0x[a-fA-F0-9]{40}';#let JOB_BOARD = window.JOB_BOARD_ADDRESS || '$CONTRACT_ADDRESS';#" frontend/index.html
fi

echo "  ✓ Address saved to backend/.env and .env"
echo ""
echo "NEXT STEPS:"
echo "  1. cd backend && npm install && npm start"
echo "  2. Open frontend/index.html in your browser"
echo "  3. Connect MetaMask to Arc Testnet"
echo ""
