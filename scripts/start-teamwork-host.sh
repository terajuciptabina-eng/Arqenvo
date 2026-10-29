#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/terajuciptabina-eng/Arqenvo.git"
ROOT="${HOME}/Library/Application Support/Arqenvo/teamwork-source"
mkdir -p "$(dirname "$ROOT")"

if ! command -v git >/dev/null 2>&1; then
  echo "Git is required. macOS may offer to install Command Line Tools; accept the prompt, then run this command again."
  xcode-select --install || true
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required. Install the current LTS from https://nodejs.org/en/download/ and rerun."
  exit 1
fi

if [ ! -d "$ROOT/.git" ]; then
  echo "Getting Arqenvo source from GitHub main for the first time..."
  git clone --branch main --single-branch "$REPO_URL" "$ROOT"
else
  echo "Updating Arqenvo source from GitHub main..."
  git -C "$ROOT" fetch origin main
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    echo "STOP: the Teamwork runtime checkout has local changes."
    echo "No files were overwritten. Inspect: $ROOT"
    exit 2
  fi
  git -C "$ROOT" checkout main
  git -C "$ROOT" reset --hard origin/main
fi

cd "$ROOT"
echo
echo "Arqenvo source revision: $(git rev-parse --short HEAD)"
echo "Project files and backups will be stored separately under ~/.arqenvo/teamwork."
echo
if [ ! -f "$HOME/.arqenvo/teamwork/users.json" ]; then
  echo "First run: enter an admin password of at least 4 characters. Use this only on a trusted private Wi-Fi network."
  read -r -s -p "Teamwork admin password: " ADMIN_PASSWORD
  echo
  if [ "${#ADMIN_PASSWORD}" -lt 4 ]; then
    echo "Password must be at least 4 characters. Run the launcher again."
    exit 1
  fi
  export ARQENVO_TEAMWORK_ADMIN_PASSWORD="$ADMIN_PASSWORD"
  export ARQENVO_TEAMWORK_ADMIN_USER="admin"
  unset ADMIN_PASSWORD
fi

echo "Starting the LAN host. Keep this Terminal window open while the team is working."
echo "Use the LAN URL printed below on this Mac and other devices on the same trusted Wi-Fi."
echo "Do not expose port 8080 to the public internet."
exec npm run teamwork:host
