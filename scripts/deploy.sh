#!/usr/bin/env bash
# Deploys the helpline to the VM from the laptop, or rolls it back (docs/runbooks/deploy.md).
#
#   scripts/deploy.sh <ssh-host> [ref]        ref: the branch, tag or commit to run (default main)
#   e.g. scripts/deploy.sh azureuser@<vm-ip>
#
# On the VM, in /opt/arham/app as the ssh user: checks out <ref> (a branch is fast-forwarded to origin's), builds the
# images, applies the migrations with the new image before any new code starts, then recreates the containers that
# changed. A worker with a turn in flight takes up to 170 s to stop. Then it fetches
# https://<PUBLIC_HOSTNAME>/api/health from here, prints it, and exits 1 unless it answers 200.
#
# Rollback: the same command with the "previous" ref it printed, or an earlier tag. Migrations are not undone.
set -euo pipefail

usage() {
  echo "usage: scripts/deploy.sh <ssh-host> [ref]" >&2
  exit 2
}

host="${1:-}"
ref="${2:-main}"
[[ -n "$host" ]] || usage
# The ref reaches a shell on the VM: only the characters a branch, a tag or a commit hash uses.
if [[ ! "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
  echo "deploy: refusing the ref '$ref'" >&2
  exit 2
fi

echo "==> Deploying $ref to $host"
# The script below runs on the VM, read from stdin. Everything in it runs from main, so bash has read all of it before
# the first command, and nothing in it can read the rest as its own input.
ssh "$host" bash -s -- "$ref" <<'REMOTE'
set -euo pipefail

compose() {
  docker compose -f docker/docker-compose.yml --env-file /opt/arham/.env "$@" </dev/null
}

main() {
  local ref=$1 previous
  cd /opt/arham/app
  exec 9>/tmp/arham-deploy.lock
  if ! flock -n 9; then
    echo "deploy: another deploy is running on this VM" >&2
    exit 1
  fi

  previous=$(git rev-parse --short HEAD)
  echo "==> git: $ref (previous: $previous)"
  git fetch --tags origin
  if git show-ref --verify --quiet "refs/remotes/origin/$ref"; then
    git checkout "$ref"
    git pull --ff-only origin "$ref"
  else
    git checkout --detach "$ref"
  fi
  echo "now at $(git log -1 --format='%h %s')"

  echo "==> build"
  compose build
  echo "==> migrate, with the new image, before the new code starts"
  compose run --rm -T app npm run migrate
  echo "==> up (a worker with a turn in flight finishes it first: up to 170 s)"
  compose up -d --remove-orphans
  # The images the new ones replaced.
  docker image prune -f >/dev/null
  compose ps
  echo "==> to roll back: scripts/deploy.sh <ssh-host> $previous"
}

main "$@"
REMOTE

hostname="${PUBLIC_HOSTNAME:-}"
if [[ -z "$hostname" ]]; then
  hostname=$(ssh "$host" 'cd /opt/arham/app && docker compose -f docker/docker-compose.yml --env-file /opt/arham/.env exec -T caddy printenv PUBLIC_HOSTNAME' </dev/null)
fi
url="https://$hostname/api/health"
echo "==> $url"
# The app needs a few seconds to start, and on the very first deploy Caddy is still getting the certificate.
code=000
body=""
for _ in $(seq 1 24); do
  response=$(curl -sS --max-time 10 -w '\n%{http_code}' "$url" 2>&1) || true
  code=${response##*$'\n'}
  body=${response%$'\n'*}
  [[ "$code" == 200 ]] && break
  sleep 5
done
if ! python3 -m json.tool <<<"$body" 2>/dev/null; then
  printf '%s\n' "$body"
fi
echo "HTTP $code"
if [[ "$code" != 200 ]]; then
  echo "deploy: /api/health is not 200: the checks above say why (docs/runbooks/deploy.md, Troubleshooting)" >&2
  exit 1
fi
echo "deploy: healthy"
