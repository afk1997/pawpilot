#!/usr/bin/env bash
# Deploys the helpline to the VM from the laptop, or rolls it back (docs/runbooks/deploy.md).
#
#   scripts/deploy.sh <ssh-host> [ref]        ref: the branch, tag or commit to run (default main)
#   e.g. scripts/deploy.sh azureuser@<vm-ip>
#
# The deploy runs on the VM detached from this ssh session (/opt/arham/deploy/run.sh, its output in deploy.log
# there): a dropped connection never stops it halfway, with an old container stopped and its replacement not
# started. This script follows that log and reads the exit status the run leaves in deploy.status. On the VM, in
# /opt/arham/app as the ssh user, the run:
#   - checks out <ref> (a branch is fast-forwarded to origin's), builds the images and applies the migrations with
#     the new image before any new code starts; if one of these fails, the checkout goes back to what is running;
#   - re-creates the containers that changed (a worker with a turn in flight finishes it first: up to 170 s) and
#     reloads Caddy;
#   - waits up to 90 s for a re-created worker to log "worker started" with no restart.
# Then this script fetches https://<PUBLIC_HOSTNAME>/api/health until it answers 200 with a worker heartbeat younger
# than the run's `up`, which only the worker now running can have written, and exits 1 otherwise.
#
# Rollback: the same command with the "previous" ref the run printed, or an earlier tag. Migrations are not undone.
set -euo pipefail

DEPLOY_DIR=/opt/arham/deploy

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

echo "==> Deploying $ref to $host (the run is detached on the VM; its log: $DEPLOY_DIR/deploy.log)"
launched=$(mktemp)
trap 'rm -f "$launched"' EXIT
# The launcher below runs on the VM, read from stdin; everything in it runs from launch(), so bash has read all of it,
# the runner it writes included, before the first command. It takes the deploy lock, writes the runner, starts it in
# a session of its own (it inherits the lock, held until it ends) and prints its process id. (Into a file, not a
# $(...): bash 3.2, a Mac's, misreads a heredoc inside a command substitution.)
if ! ssh "$host" bash -s -- "$ref" >"$launched" <<'ARHAM_DEPLOY_LAUNCHER'
set -euo pipefail

launch() {
  local ref=$1 dir=/opt/arham/deploy
  if [[ ! -d "$dir" || ! -w "$dir" ]]; then
    echo "deploy: $dir is missing or not writable by $(id -un): run scripts/setup-vm.sh again, or" >&2
    echo "  sudo install -d -o $(id -un) -g $(id -gn) -m 700 $dir" >&2
    exit 2
  fi
  exec 9>>"$dir/deploy.lock"
  if ! flock -n 9; then
    echo "deploy: another deploy is running on this VM (its log: $dir/deploy.log)" >&2
    exit 3
  fi
  cat >"$dir/run.sh" <<'ARHAM_DEPLOY_RUNNER'
#!/usr/bin/env bash
# One deploy, written and started by scripts/deploy.sh; its output goes to /opt/arham/deploy/deploy.log.
set -euo pipefail

dir=/opt/arham/deploy
up_done=""
public_host=""

# The exit status, the seconds since `up` returned and PUBLIC_HOSTNAME, for scripts/deploy.sh.
# shellcheck disable=SC2329 # the EXIT trap runs it
finish() {
  local code=$? since=""
  if [[ -n "$up_done" ]]; then since=$(($(date +%s) - up_done)); fi
  echo "$code ${since:--} ${public_host:--}" >"$dir/deploy.status"
  echo "==> $(date -u +%FT%TZ) run ended, exit $code"
}
trap finish EXIT

compose() {
  docker compose -f docker/docker-compose.yml --env-file /opt/arham/.env "$@" </dev/null
}

worker_logs() {
  echo "--- the worker's last log lines:"
  docker logs --tail 30 "$1" 2>&1 || true
}

main() {
  local ref=$1 previous before after up_started started restarts started_at logs
  cd /opt/arham/app
  previous=$(git rev-parse --short HEAD)
  echo "==> $(date -u +%FT%TZ) git: $ref (previous: $previous)"
  # Until the new code runs, a failure puts the checkout back on what is running.
  back_to_previous() {
    echo "deploy: $1 failed; the checkout goes back to $previous, which is still running" >&2
    git checkout -q --detach "$previous" || echo "deploy: could not check out $previous again" >&2
    exit 1
  }
  git fetch --tags origin || back_to_previous "git fetch"
  if git show-ref --verify --quiet "refs/remotes/origin/$ref"; then
    git checkout "$ref" || back_to_previous "git checkout $ref"
    git pull --ff-only origin "$ref" || back_to_previous "git pull"
  else
    git checkout --detach "$ref" || back_to_previous "git checkout $ref"
  fi
  echo "now at $(git log -1 --format='%h %s')"

  echo "==> build"
  compose build || back_to_previous "the build"
  echo "==> migrate, with the new image, before the new code starts"
  compose run --rm -T app npm run migrate || back_to_previous "the migration"

  before=$(compose ps -q worker || true)
  echo "==> up (a worker with a turn in flight finishes it first: up to 170 s)"
  up_started=$(date +%s)
  compose up -d --remove-orphans
  up_done=$(date +%s)

  # Its config is a mounted directory, which `up` does not re-read.
  if [[ -n "$(compose ps -q --status running caddy)" ]]; then
    echo "==> reload Caddy"
    compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
  else
    echo "==> Caddy is not running yet: nothing to reload"
  fi
  public_host=$(compose config --environment | sed -n 's/^PUBLIC_HOSTNAME=//p' | tail -n 1) || true

  after=$(compose ps -q worker)
  if [[ -z "$after" ]]; then
    echo "deploy: no worker container after up" >&2
    exit 1
  fi
  if [[ "$after" == "$before" ]]; then
    # Its image and settings did not change, so `up` left it running.
    echo "==> the worker was not re-created: $(docker inspect -f '{{.State.Status}}, {{.RestartCount}} restarts' "$after")"
    if [[ "$(docker inspect -f '{{.State.Running}}' "$after")" != true ]]; then
      echo "deploy: the worker is not running" >&2
      worker_logs "$after"
      exit 1
    fi
  else
    echo "==> waiting for the new worker (up to 90 s)"
    started=""
    for _ in $(seq 1 45); do
      # Read whole first: grep -q at the end of a pipe can fail it under pipefail even when it matches.
      logs=$(docker logs "$after" 2>&1 || true)
      if grep -q '"msg":"worker started"' <<<"$logs"; then
        started=1
        break
      fi
      sleep 2
    done
    restarts=$(docker inspect -f '{{.RestartCount}}' "$after")
    started_at=$(docker inspect -f '{{.State.StartedAt}}' "$after")
    if [[ -z "$started" || "$restarts" != 0 || "$(date -d "$started_at" +%s)" -lt "$up_started" ]]; then
      echo "deploy: the new worker did not start (logged \"worker started\": ${started:-no}, restarts: $restarts)" >&2
      worker_logs "$after"
      exit 1
    fi
    echo "the new worker started at $started_at"
  fi

  # The images the new ones replaced.
  docker image prune -f >/dev/null
  compose ps
  echo "==> deployed $(git log -1 --format='%h %s'); to roll back: scripts/deploy.sh <ssh-host> $previous"
}

main "$@"
exit 0
ARHAM_DEPLOY_RUNNER
  if [[ -f "$dir/deploy.log" ]]; then mv -f "$dir/deploy.log" "$dir/deploy.log.1"; fi
  # There before the laptop starts following it.
  : >"$dir/deploy.log"
  echo running >"$dir/deploy.status"
  # Its own session, no terminal, its input from nowhere: the end of this ssh session cannot reach it.
  setsid nohup bash "$dir/run.sh" "$ref" >>"$dir/deploy.log" 2>&1 </dev/null &
  echo "$!"
}

launch "$@"
ARHAM_DEPLOY_LAUNCHER
then
  echo "deploy: the deploy did not start on the VM (see above)" >&2
  exit 1
fi
pid=$(cat "$launched")
if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
  echo "deploy: the VM did not report the run's process id: '$pid'" >&2
  exit 1
fi

# Until the run ends; tail stops by itself then. (The pid and the path are this script's own values.)
# shellcheck disable=SC2029
if ! ssh "$host" "tail -n +1 -f --pid=$pid $DEPLOY_DIR/deploy.log"; then
  echo "deploy: lost the connection while following the log; the deploy goes on on the VM. Follow it with" >&2
  echo "  ssh $host tail -f $DEPLOY_DIR/deploy.log" >&2
  echo "and read its result (exit status first) with: ssh $host cat $DEPLOY_DIR/deploy.status" >&2
  exit 2
fi
ended_at=$(date +%s)
# shellcheck disable=SC2029
if ! status=$(ssh "$host" "cat $DEPLOY_DIR/deploy.status" </dev/null); then
  echo "deploy: could not read the run's result: ssh $host cat $DEPLOY_DIR/deploy.status" >&2
  exit 2
fi
read -r code since_up_at_end vm_host <<<"$status"
if [[ "$code" == running ]]; then
  echo "deploy: the run ended without a status (killed?): on the VM, check the containers and start them: arham ps; arham up -d" >&2
  exit 1
fi
if [[ "$code" != 0 ]]; then
  echo "deploy: the run failed on the VM (exit $code): the log above says why" >&2
  exit 1
fi

if [[ -n "${PUBLIC_HOSTNAME:-}" ]]; then
  hostname=$PUBLIC_HOSTNAME
  echo "==> health at $hostname (PUBLIC_HOSTNAME from this shell, not the VM's $vm_host)"
else
  hostname=$vm_host
fi
url="https://$hostname/api/health"
echo "==> $url"
# 200 is not enough: the heartbeat must be younger than the run's `up`, or it is the replaced worker's. The new
# worker's first one can come just before `up` returns, and the next follows within 30 s.
code=000
body=""
age=""
for _ in $(seq 1 24); do
  since_up=$((since_up_at_end + $(date +%s) - ended_at))
  response=$(curl -sS --max-time 10 -w '\n%{http_code}' "$url" 2>&1) || true
  code=${response##*$'\n'}
  body=${response%$'\n'*}
  age=$(sed -n 's/.*"workerHeartbeatAgeS":\(-\{0,1\}[0-9]\{1,\}\).*/\1/p' <<<"$body")
  if [[ "$code" == 200 && -n "$age" && "$age" -lt "$since_up" ]]; then
    break
  fi
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
if [[ -z "$age" || "$age" -ge "$since_up" ]]; then
  echo "deploy: no worker heartbeat since the run's up ($since_up s ago; the last is ${age:-unknown} s old): is the worker running? (arham ps; arham logs worker)" >&2
  exit 1
fi
echo "deploy: healthy (worker heartbeat ${age} s old, up returned ${since_up} s ago)"
