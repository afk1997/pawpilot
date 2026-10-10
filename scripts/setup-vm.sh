#!/usr/bin/env bash
# One-time setup of the helpline's Azure VM (Ubuntu 24.04, x86-64), run as root. Safe to run again.
#
#   sudo bash setup-vm.sh <repo-url> [ref]        ref: the branch, tag or commit to check out (default main)
#
# From the laptop, without copying the script over first:
#   ssh azureuser@<vm> 'sudo bash -s -- https://github.com/afk1997/pawpilot.git main' < scripts/setup-vm.sh
#
# It installs Docker CE and the compose plugin from Docker's apt repository, turns on unattended security upgrades,
# opens ufw for 22, 80 and 443, enables fail2ban's sshd jail, adds a 2 GiB swapfile (swappiness 10), creates
# /opt/arham/backups, clones or updates the repo in /opt/arham/app as the deploy user (DEPLOY_USER, default
# azureuser), adds that user to the docker group, and restricts /opt/arham/.env when it exists. Then it prints the
# next steps (docs/runbooks/deploy.md).
set -euo pipefail

REPO_URL="${1:-}"
REF="${2:-main}"
DEPLOY_USER="${DEPLOY_USER:-azureuser}"
ARHAM_DIR=/opt/arham
APP_DIR=$ARHAM_DIR/app
ENV_FILE=$ARHAM_DIR/.env
# Docker's release key (https://download.docker.com/linux/ubuntu/gpg).
DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

WARNINGS=()

step() { printf '\n==> %s\n' "$*"; }
warn() {
  printf 'setup-vm: WARNING: %s\n' "$*" >&2
  WARNINGS+=("$*")
}
die() {
  printf 'setup-vm: %s\n' "$*" >&2
  exit 1
}

# Runs a command as the deploy user, with that user's HOME (and so their git and ssh config). A first SSH clone
# accepts GitHub's host key once and refuses a changed one; git never prompts for a password.
as_deploy_user() {
  sudo -u "$DEPLOY_USER" -H env GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" "$@"
}

apt_install() {
  apt-get install -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@" </dev/null
}

install_packages() {
  step "Base packages"
  apt-get update </dev/null
  apt_install ca-certificates curl git gnupg ufw fail2ban python3-systemd unattended-upgrades
}

install_docker() {
  step "Docker CE and the compose plugin, from Docker's apt repository"
  install -m 0755 -d /etc/apt/keyrings
  local key fingerprints codename
  key=$(mktemp)
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$key"
  fingerprints=$(gpg --show-keys --with-colons "$key")
  if ! grep -q "^fpr:*:$DOCKER_KEY_FINGERPRINT:" <<<"$fingerprints"; then
    rm -f "$key"
    die "the key at download.docker.com does not have Docker's fingerprint $DOCKER_KEY_FINGERPRINT"
  fi
  install -m 0644 "$key" /etc/apt/keyrings/docker.asc
  rm -f "$key"
  # shellcheck disable=SC1091
  codename=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $codename
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update </dev/null
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  usermod -aG docker "$DEPLOY_USER"
  docker --version
  docker compose version
}

enable_unattended_upgrades() {
  step "Unattended security upgrades"
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  systemctl enable --now unattended-upgrades
}

configure_firewall() {
  step "Firewall (ufw): SSH, HTTP, HTTPS"
  # SSH first, so enabling the firewall never cuts this session off. Ports Docker publishes (caddy's 80 and 443)
  # bypass ufw, so the Azure network security group is the outer wall; ufw guards everything else on the host.
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443 # TCP, and UDP for HTTP/3
  ufw default deny incoming
  ufw default allow outgoing
  ufw --force enable
  ufw status verbose
}

configure_fail2ban() {
  step "fail2ban: the sshd jail"
  cat >/etc/fail2ban/jail.d/arham-sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  systemctl enable fail2ban
  if systemctl restart fail2ban && sleep 2 && fail2ban-client status sshd; then
    :
  else
    warn "fail2ban did not start its sshd jail: see journalctl -u fail2ban"
  fi
}

configure_swap() {
  step "Swap: a 2 GiB /swapfile, swappiness 10"
  local active
  active=$(swapon --show=NAME --noheadings)
  if ! grep -qx /swapfile <<<"$active"; then
    if [[ ! -f /swapfile ]]; then
      fallocate -l 2G /swapfile
      chmod 600 /swapfile
      mkswap /swapfile
    fi
    swapon /swapfile
  fi
  grep -qE '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo 'vm.swappiness = 10' >/etc/sysctl.d/99-arham-swappiness.conf
  sysctl -q -w vm.swappiness=10
  swapon --show
}

prepare_dirs() {
  step "$ARHAM_DIR"
  install -d -m 755 "$ARHAM_DIR"
  # The backup container writes the dumps as root; they hold reporters' phone numbers and messages.
  install -d -m 700 "$ARHAM_DIR/backups"
  chmod 700 "$ARHAM_DIR/backups"
}

checkout_repo() {
  step "The repository in $APP_DIR, as $DEPLOY_USER, at $REF"
  if [[ -d "$APP_DIR/.git" ]]; then
    as_deploy_user git -C "$APP_DIR" remote set-url origin "$REPO_URL"
    as_deploy_user git -C "$APP_DIR" fetch --tags origin
  else
    if [[ -e "$APP_DIR" && -n "$(ls -A "$APP_DIR")" ]]; then
      die "$APP_DIR exists but is not a git checkout; move it away and run again"
    fi
    install -d -o "$DEPLOY_USER" -g "$(id -gn "$DEPLOY_USER")" -m 755 "$APP_DIR"
    as_deploy_user git clone "$REPO_URL" "$APP_DIR"
  fi
  # A branch is fast-forwarded to origin's; a tag or a commit is checked out detached.
  if as_deploy_user git -C "$APP_DIR" show-ref --verify --quiet "refs/remotes/origin/$REF"; then
    as_deploy_user git -C "$APP_DIR" checkout "$REF"
    as_deploy_user git -C "$APP_DIR" merge --ff-only "origin/$REF"
  else
    as_deploy_user git -C "$APP_DIR" checkout --detach "$REF"
  fi
  as_deploy_user git -C "$APP_DIR" log -1 --format='%h %s'
}

restrict_env_file() {
  step "$ENV_FILE"
  if [[ -f "$ENV_FILE" ]]; then
    # docker compose reads it as the deploy user (scripts/deploy.sh), and nobody else may.
    chown "$DEPLOY_USER:" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ls -l "$ENV_FILE"
  else
    echo "not there yet (next steps)"
  fi
}

print_next_steps() {
  local env_step
  if [[ -f "$ENV_FILE" ]]; then
    env_step="  2. Check that $ENV_FILE holds the production values (the \"Production\" notes in .env.example)."
  else
    env_step="  2. Create $ENV_FILE from the template and fill in the production values (the \"Production\" notes in
     .env.example):
       sudo install -m 600 -o $DEPLOY_USER -g $(id -gn "$DEPLOY_USER") $APP_DIR/.env.example $ENV_FILE
       nano $ENV_FILE"
  fi
  cat <<EOF

Setup done. Next steps (docs/runbooks/deploy.md):
  1. Log out and back in, so that $DEPLOY_USER's docker group membership applies.
$env_step
  3. Add the Namecheap A record for PUBLIC_HOSTNAME (helpline.arhamalwayscare.org) pointing at this VM's public IP,
     and allow inbound 80 and 443 (and 22) in the VM's network security group.
  4. From the laptop, in the repo: scripts/deploy.sh $DEPLOY_USER@<this VM> $REF
  5. Load the directory spreadsheet and check /api/health (the runbook's "First deploy" section).
EOF
  if ((${#WARNINGS[@]} > 0)); then
    printf '\nWarnings:\n'
    printf '  - %s\n' "${WARNINGS[@]}"
  fi
}

main() {
  [[ -n "$REPO_URL" ]] || die "usage: sudo bash setup-vm.sh <repo-url> [ref]"
  [[ $EUID -eq 0 ]] || die "run as root (sudo)"
  id "$DEPLOY_USER" >/dev/null 2>&1 || die "no user $DEPLOY_USER on this machine (set DEPLOY_USER)"
  local os_id os_version
  # shellcheck disable=SC1091
  os_id=$(. /etc/os-release && echo "${ID:-}")
  # shellcheck disable=SC1091
  os_version=$(. /etc/os-release && echo "${VERSION_ID:-}")
  [[ "$os_id" == ubuntu ]] || die "written for Ubuntu 24.04; this is ${os_id:-unknown}"
  [[ "$os_version" == 24.04 ]] || warn "written for Ubuntu 24.04; this is $os_version"
  export DEBIAN_FRONTEND=noninteractive
  # The deploy user cannot read root's home, where sudo may have left us.
  cd /

  install_packages
  install_docker
  enable_unattended_upgrades
  configure_firewall
  configure_fail2ban
  configure_swap
  prepare_dirs
  checkout_repo
  restrict_env_file
  print_next_steps
}

# Everything runs from main, so bash has read the whole script before the first command: with `bash -s` over ssh
# the script is stdin, and nothing can swallow the rest of it.
main "$@"
