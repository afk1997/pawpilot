# Deploy runbook: the Azure VM

The helpline runs on one Azure VM as the Docker Compose stack in `docker/docker-compose.yml` (project `arham`):

| Service | What it is |
|---|---|
| `caddy` | Caddy 2 on ports 80 and 443: the Let's Encrypt certificate for `PUBLIC_HOSTNAME`, HTTP to HTTPS, gzip, the reverse proxy to `app` |
| `app` | the Next.js server (`node server.js`): the Interakt webhook, `/admin`, `/test-chat`, `/api/health` |
| `worker` | Claude turns, the fast path, the fallback, the minute sweeps and resends |
| `postgres` | Postgres 17, data in the volume `arham_pgdata`, no published port |
| `backup` | a dump every night at 03:00 IST into `/opt/arham/backups`, optionally uploaded to Azure Blob ([restore runbook](restore.md)) |

`app` and `worker` run one image (`docker/Dockerfile`), built on the VM. On the VM:

- `/opt/arham/app`: the repo checkout, owned by the deploy user (`azureuser`);
- `/opt/arham/.env`: every setting and secret, owned by `azureuser`, mode 600 (docker compose reads it as that user);
- `/opt/arham/backups`: the dumps, root only (they hold reporters' phone numbers and messages).

The commands below that start with `arham` use this alias; add it once to the deploy user's `~/.bashrc`:

```bash
alias arham='docker compose -f /opt/arham/app/docker/docker-compose.yml --env-file /opt/arham/.env'
```

## First deploy

### 1. The VM

In the Azure portal: Ubuntu Server 24.04 LTS, x64, 2 vCPU / 4 GiB (Standard_B2als_v2), Central India, a 64 GiB Standard SSD, SSH public key authentication for the user `azureuser`, and a static public IP with the DNS name label `arham-helpline`. In its network security group, allow inbound TCP 22 (from your own IP if you can), 80 and 443 (and UDP 443 for HTTP/3, optional).

### 2. Setup script

From the laptop, in the repo (the script runs as root on the VM; it is safe to run again):

```bash
ssh azureuser@<vm-ip> 'sudo bash -s -- https://github.com/afk1997/pawpilot.git main' < scripts/setup-vm.sh
```

It installs Docker CE and the compose plugin from Docker's apt repository (checking the key's fingerprint), turns on unattended security upgrades, opens ufw for 22, 80 and 443, enables fail2ban's sshd jail, adds a 2 GiB swapfile (swappiness 10), creates `/opt/arham/backups`, clones the repo into `/opt/arham/app` as `azureuser`, adds `azureuser` to the docker group and tightens `/opt/arham/.env` if it exists. It ends with the next steps and any warning. Log out and back in afterwards, so the docker group applies.

Ports that Docker publishes (Caddy's 80 and 443) bypass ufw: the network security group is the outer wall.

### 3. `/opt/arham/.env`

```bash
sudo install -m 600 -o azureuser -g azureuser /opt/arham/app/.env.example /opt/arham/.env
nano /opt/arham/.env
```

Fill in every value the template asks for, with its production value, including the "Production" section at its end:

- `POSTGRES_PASSWORD`: `openssl rand -hex 24` (hex only: it also goes into the database URL);
- `PUBLIC_HOSTNAME=helpline.arhamalwayscare.org` and `ACME_EMAIL` (Let's Encrypt's notices);
- `AZURE_BACKUP_SAS_URL`: optional, see [Backups](#backups);
- `INTERAKT_API_KEY` and `INTERAKT_WEBHOOK_SECRET`: the real values are safe before go-live, since nothing reaches Interakt until its webhook points at this host (test-chat conversations never do);
- `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token` on the laptop) and `LLM_TOKEN_ISSUED_AT`;
- `HELPLINE_PHONE`, `ADMIN_PASSWORD` and `SESSION_SECRET` (`openssl rand -hex 32`).

The compose file sets `DATABASE_URL` (from `POSTGRES_PASSWORD`), `NODE_ENV=production` and the worker's `LLM_HOME_DIR=/home/node/claude-home` itself, whatever the file says. A value containing `$` must be in single quotes: compose reads `$NAME` in this file as a reference to another variable.

### 4. DNS

Namecheap, Advanced DNS for arhamalwayscare.org: an A record, host `helpline`, value the VM's public IP, TTL 5 min. Check from the laptop with `dig +short helpline.arhamalwayscare.org`. Caddy gets the certificate on its first start once the name resolves to the VM and ports 80 and 443 are open. Until the record exists, the Azure DNS label's name works too: `PUBLIC_HOSTNAME=arham-helpline.centralindia.cloudapp.azure.com`, then switch (and `arham up -d`) once the record resolves.

### 5. Deploy

From the laptop, in the repo:

```bash
scripts/deploy.sh azureuser@<vm-ip> main
```

It builds the images on the VM (several minutes the first time), applies the migrations, starts the stack and prints `https://<PUBLIC_HOSTNAME>/api/health`; it exits 1 unless that answers 200. Before DNS points at the VM the certificate and that last check fail; check the app from the VM instead:

```bash
arham exec app node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => r.text()).then(console.log)"
```

### 6. The directory

The spreadsheet holds drivers' personal numbers: it never goes into git or an image. Copy it to the VM, readable only by the image's `node` user (uid 1000), and ingest it:

```bash
scp ambulances-clinics.csv azureuser@<vm-ip>:
# then on the VM:
sudo install -m 600 -o 1000 -g 1000 ~/ambulances-clinics.csv /opt/arham/ambulances-clinics.csv && rm ~/ambulances-clinics.csv
arham run --rm -v /opt/arham/ambulances-clinics.csv:/data/ambulances-clinics.csv:ro app npm run ingest:ambulances -- /data/ambulances-clinics.csv
```

Do the same after every edit of the spreadsheet (README, Operations, "Directory"). The coverage list in Claude's prompt refreshes within an hour, or at once with `arham restart worker`.

### 7. Checks before go-live

- `https://helpline.arhamalwayscare.org/api/health` answers 200 (the README's Operations section explains every check).
- `/admin` logs in; `/test-chat` answers. Test conversations never reach Interakt, but they are real Claude turns on the Max plan.
- One backup by hand, and a restore drill ([restore runbook](restore.md)).
- The owner's smoke run (README, "Go-live gate"), from the laptop.

### 8. Go live

- Interakt's webhook: `https://helpline.arhamalwayscare.org/api/webhook`, with the secret in `INTERAKT_WEBHOOK_SECRET`.
- An uptime monitor (UptimeRobot, free) on `https://helpline.arhamalwayscare.org/api/health` every 5 minutes, alerting the owner when it is not 200. Nothing in the stack alerts by itself.

## Routine operations

- **Deploy**: `scripts/deploy.sh azureuser@<vm-ip> [ref]` (a branch, tag or commit; default `main`). It checks out the ref (a branch is fast-forwarded to origin's), builds, migrates with the new image, then recreates what changed. A worker with a turn in flight finishes it first (up to 170 s). The app restarts in a few seconds, during which a webhook gets a 502 from Caddy: deploy at a quiet hour. It also deletes the images the new ones replaced.
- **Roll back**: the same command with the "previous" ref it printed (or an earlier tag). Migrations are not undone, so the older code runs on the newer schema: fine for a migration that only adds, but read it before rolling back across one.
- **Status and logs**: `arham ps`; `arham logs -f --tail=100 worker` (or `app`, `caddy`, `postgres`, `backup`). Each container keeps 5 × 10 MB of JSON logs.
- **A setting changed** (`/opt/arham/.env`): `arham up -d` recreates the services whose settings changed, the worker gracefully. The yearly token renewal: `claude setup-token` on the laptop, then `CLAUDE_CODE_OAUTH_TOKEN` and `LLM_TOKEN_ISSUED_AT` in `/opt/arham/.env`, then `arham up -d`.
- **Restart one service**: `arham restart worker`: the worker gets its 170 s to finish a turn.
- **Reboot** (the security upgrades leave `/var/run/reboot-required` when one is due; nothing reboots by itself): `arham stop worker` first, so a turn in flight finishes, then `sudo reboot`, then `arham up -d` (a container stopped by hand stays stopped across the reboot; the rest come back by themselves).
- **Base images** (now and then, at a quiet hour): `arham pull caddy postgres && arham build --pull && arham up -d`. Postgres restarts in a few seconds.
- **Disk**: `df -h /` and `docker system df`; `docker builder prune` frees the build cache.

## Backups

`backup` dumps the database every night at 21:30 UTC (03:00 IST) into `/opt/arham/backups/arham-<UTC time>.dump.gz`, reads each dump back before keeping it, and deletes dumps older than 30 days. Every run logs its steps (`arham logs --tail=20 backup`); a failed run logs `backup FAILED: <why>`. Nothing alerts on a failed backup: look at that log now and then. One backup now: `arham exec backup backup.sh`.

Off-VM copies (`AZURE_BACKUP_SAS_URL`):

1. A storage account (Standard, private access), preferably in another region (South India), and a private container, e.g. `backups`.
2. A lifecycle management rule (the storage account's Lifecycle management) for blobs with the prefix `backups/`: delete them 30 days after creation (or keep them longer).
3. A shared access signature for the container with the Create permission only, HTTPS only, and an expiry a year out (renew it with the Claude token). Create lets the VM add new dumps but not read, overwrite or delete any, so a leaked URL cannot destroy the backups.
4. The whole SAS URL (`https://<account>.blob.core.windows.net/backups?sv=…&sig=…`) as `AZURE_BACKUP_SAS_URL` in `/opt/arham/.env`, then `arham up -d` and `arham exec backup backup.sh`: the log says `uploaded arham-….dump.gz`. The URL is a secret; the script never logs it.

## Security notes

- Only Caddy faces the internet. Never publish the app's port 3000: the admin login limiter keys on the first `X-Forwarded-For` entry, which Caddy sets to the client's address (it drops any the client sent). Never publish Postgres's 5432.
- `/opt/arham/.env` holds the Claude token, the Interakt key and the admin secrets. The app container gets no Claude token; only the worker does.
- SSH is key-only (the Azure default for key authentication); fail2ban bans an address after 5 failed logins in 10 minutes, for an hour.

## Troubleshooting

- **`/api/health` is not 200**: read its checks. `config: false`: a setting in `/opt/arham/.env` is invalid (`arham logs worker` names it: `Invalid environment: …`). `db: false`: `arham logs postgres`. `workerHeartbeatAgeS` null or over 120: `arham ps` and `arham logs worker`. `authErrorLastHour: true`: the Claude token. `delivery: "degraded"`: replies are not reaching Interakt (`arham logs worker`).
- **No certificate**: `arham logs caddy`. The A record must point at the VM and ports 80 and 443 must be open in the network security group; Caddy keeps retrying.
- **A container restarting in a loop**: `arham ps`, then `arham logs <service>`.
