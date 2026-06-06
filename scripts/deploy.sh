#!/usr/bin/env bash
# Deploy built fork to node_modules
# Usage: ./scripts/deploy.sh
set -euo pipefail

echo "==> Building fork..."
npm run build

echo ""
echo "==> Deploying to node_modules..."
sudo cp dist/index.mjs /usr/local/lib/node_modules/@agentmemory/agentmemory/dist/index.mjs

echo ""
echo "==> Verifying patch..."
if grep -q "supersedes.*sourceId.*memory" /usr/local/lib/node_modules/@agentmemory/agentmemory/dist/index.mjs; then
    echo "✅ Patch confirmed in deployed file"
else
    echo "❌ Patch NOT found — something went wrong!"
    exit 1
fi

echo ""
echo "==> Restarting agentmemory..."
systemctl --user restart agentmemory.service
sleep 5

echo ""
echo "==> Checking health..."
curl -s http://localhost:3111/agentmemory/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('Status:', d.get('health',{}).get('status','unknown'))"

echo ""
echo "✅ Deploy complete"
