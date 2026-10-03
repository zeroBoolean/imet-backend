#!/usr/bin/env bash
set -euo pipefail
node -e "if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required')"
export npm_config_cache=/workspace/.npm-cache
cd /workspace/imet-server
test -e .env || cp .env.example .env
npm ci --no-fund --no-audit
npm run db:validate
cd /workspace/imet-client
test -e .env.local || cp .env.example .env.local
npm ci --no-fund --no-audit
