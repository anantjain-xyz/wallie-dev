#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
export PATH="/Users/anant/.nvm/versions/node/v22.13.1/bin:/Users/anant/Library/pnpm:$PATH"
cd /Users/anant/src/wallie-dev
exec /Users/anant/.nvm/versions/node/v22.13.1/bin/node node_modules/next/dist/bin/next dev "$@"
