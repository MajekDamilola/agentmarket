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

ARC_RPC="https://rpc.testnet.arc.network"

echo "▸ Compiling contract..."
forge build --contracts contracts/

echo ""
echo "▸ Deploying AgentJobBoard to Arc Testnet..."
OUTPUT=$(forge create contracts/AgentJobBoard.sol:AgentJobBoard \
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

# Update frontend
sed -i "s|window.JOB_BOARD_ADDRESS.*|window.JOB_BOARD_ADDRESS = '$CONTRACT_ADDRESS';|" frontend/index.html 2>/dev/null || true

echo "  ✓ Address saved to backend/.env"
echo ""
echo "NEXT STEPS:"
echo "  1. cd backend && npm install && npm start"
echo "  2. Open frontend/index.html in your browser"
echo "  3. Connect MetaMask to Arc Testnet"
echo ""
