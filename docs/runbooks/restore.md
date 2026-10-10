# Restore runbook: the database from a backup

When the database is lost or damaged (a failed disk, a bad migration, rows deleted by mistake) or the bot moves to a new VM. A restore brings back the database as of its dump; whatever came after it is lost (Interakt keeps its own copy of the WhatsApp messages).

The dumps are nightly, at 03:00 IST: `arham-<UTC time>.dump.gz`, a `pg_dump -Fc` archive gzipped, made by Postgres 17 (restore into Postgres 17 or newer). The commands run on the VM, with the `arham` alias from the [deploy runbook](deploy.md).

A restore always goes into a fresh, empty database volume. The current volume is copied aside first and deleted only once the bot works again.

## 1. Pick the dump

On this VM:

```bash
sudo ls -lt /opt/arham/backups | head
```

From Azure Blob (a new VM, or the VM's own copies are gone): in the portal, open the storage account, the container and the blob, and download it; or create a read-only SAS for that one blob with a short expiry and download it on the VM:

```bash
curl -fSo arham-<UTC time>.dump.gz 'https://<account>.blob.core.windows.net/backups/arham-<UTC time>.dump.gz?<read-only SAS>'
sudo install -m 600 arham-<UTC time>.dump.gz /opt/arham/backups/ && rm arham-<UTC time>.dump.gz
```

On a new VM, first do steps 2 and 3 of the deploy runbook (setup script, `/opt/arham/.env`), then build the images without starting anything (`arham build`), then continue at step 2 here; step 3 has nothing to set aside there, so skip it. Deploy from the laptop at the end (step 7).

## 2. Stop everything that writes

```bash
arham stop app worker backup
```

Caddy answers 502 until step 7, so Interakt's webhooks fail meanwhile.

## 3. Set the current data aside

```bash
arham stop postgres
docker volume create arham_pgdata_before_restore
docker run --rm --entrypoint cp -v arham_pgdata:/from:ro -v arham_pgdata_before_restore:/to postgres:17-alpine -a /from/. /to/
arham rm -f postgres
docker volume rm arham_pgdata
```

## 4. Start a fresh database

```bash
arham up -d --wait postgres
```

This creates an empty `arham_pgdata` volume with the `arham` database and user.

## 5. Restore

```bash
arham run --rm backup restore arham-<UTC time>.dump.gz
```

It logs `restore: restored arham-….dump.gz`. It refuses a database that already holds tables, and stops at the first error (`restore FAILED: …`). After a failure, run `arham rm -sf postgres`, `docker volume rm arham_pgdata` and step 4 again before retrying.

## 6. Check, and decide about queued turns

```bash
arham exec postgres psql -U arham -d arham -c "select count(*) as conversations from conversations" -c "select max(created_at) as newest_message from messages"
```

The newest message should be a little older than the dump's time.

Turn jobs that were queued when the dump was taken run as soon as the worker starts, so those reporters may get a reply hours late; the worker's sweep also re-queues reporter messages under 6 hours old that never got an answer. To see the queued jobs, and to drop them if a late reply would do more harm than good:

```bash
arham exec postgres psql -U arham -d arham -c "select count(*) from pgboss.job where name = 'turn' and state in ('created', 'retry')"
arham exec postgres psql -U arham -d arham -c "delete from pgboss.job where name = 'turn' and state in ('created', 'retry')"
```

## 7. Start the bot

The migrations first, every time: they apply whatever the dump predates, and do nothing otherwise.

```bash
arham run --rm -T app npm run migrate
arham up -d
```

On a new VM, deploy from the laptop instead (it migrates too): `scripts/deploy.sh azureuser@<vm-ip> main`. Once the Claude token is in `/opt/arham/.env`, starting the worker is the owner's step (deploy runbook, "Who runs what"). Then check `https://<PUBLIC_HOSTNAME>/api/health` (200 once the worker has sent its first heartbeat, within seconds) and `/admin`.

## 8. Clean up

Once the bot answers again:

```bash
docker volume rm arham_pgdata_before_restore
```

To go back to the data from before the restore instead: `arham stop app worker backup postgres`, `arham rm -f postgres`, `docker volume rm arham_pgdata`, `docker volume create arham_pgdata`, copy `arham_pgdata_before_restore` into it with the `docker run … cp` line of step 3 (the two volumes swapped), then `arham up -d`.

## Drill

Before go-live, and after any change to the backup service, restore the newest dump this way on the VM and check the bot. The procedure was rehearsed on 2026-10-10 against the stack on a laptop (Docker Desktop), with a dump from `backup.sh`: the restored database matched the original table for table, and the bot came back healthy.
