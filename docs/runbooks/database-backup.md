# Database backup and restore

Two independent mechanisms protect the production D1 database
(`makethe-team`, id `3dd1de85-…` in `wrangler.jsonc`). Pick by what went wrong.

| What happened | Use |
| --- | --- |
| A migration, a cron bug or an operator statement damaged rows in the last 30 days | **Time Travel** (below) — restores in place, minutes |
| The database or the Cloudflare account itself is gone, or the damage is older than 30 days | **R2 dump** (below) — rebuild into a fresh database |

Both are set up; neither needs code. Everything below runs with the API
token in `.cf-token` (`set -a; . ./.cf-token; set +a`).

## Time Travel — point-in-time restore, 30 days

D1 keeps a continuous change log on the Workers Paid plan. Any moment in the
last 30 days can be restored, identified by a timestamp or a *bookmark*.

**Every production deploy prints a bookmark** before it applies migrations
(`Record D1 Time Travel bookmark` in `.github/workflows/deploy.yml`). If a
migration is the problem, open that run's log and copy the id from the line
`The current bookmark is '…'` — it is the exact state before the migration
touched anything.

```bash
# What is the database's current bookmark? (also proves the token works)
npx wrangler d1 time-travel info makethe-team

# Restore to a known point
npx wrangler d1 time-travel restore makethe-team --bookmark=<id>
npx wrangler d1 time-travel restore makethe-team --timestamp=2026-08-27T09:00:00Z
```

Three things to know before running `restore`:

- **It is whole-database and in place.** Every table goes back, including
  rows written since the point you chose — responses, joins, audit entries.
  Restoring to yesterday afternoon loses everything since yesterday afternoon.
  There is no per-table or per-row restore.
- **It is itself a bookmarked change**, so a restore to the wrong point can be
  undone by restoring forward again. Run `time-travel info` first and keep
  that id.
- **To recover a few rows without losing the rest**, do not restore
  production. Time Travel history belongs to one database and cannot be
  restored into another, so load the R2 dump nearest the point you want into
  a scratch database (next section), read the rows out of that, and write
  them into production by hand.

## R2 dump — daily, kept 90 days

`.github/workflows/backup.yml` runs at 03:17 UTC every day (and on demand:
`gh workflow run backup.yml`). It exports the whole database with
`wrangler d1 export --remote`, gzips it and uploads it to the R2 bucket
`makethe-team-backups` as `d1/makethe-team-<UTC stamp>.sql.gz`. The bucket's
`expire-90-days` lifecycle rule deletes each object after 90 days — that is
deliberate: the dump holds every player's email address, and erasure
(`erases_at`) promises those disappear. **Never commit a dump to git**, where
it would live forever.

Each dump is a complete SQL script: schema, data, and the `d1_migrations`
table, so a database rebuilt from it knows which migrations it already has.

`wrangler r2 object` has no `list`; find the dump you want on the bucket's
page in the Cloudflare dashboard (R2 → `makethe-team-backups` → `d1/`), or
work the name out from the date — the stamp is `YYYY-MM-DDTHHMMZ` and the
scheduled run uploads at about 03:20 UTC.

```bash
npx wrangler r2 object get makethe-team-backups/d1/makethe-team-<stamp>.sql.gz \
  --file=dump.sql.gz --remote
gunzip dump.sql.gz
```

### Restoring a dump

Restore into a **fresh** database, not over production — the dump's
`CREATE TABLE` statements fail against tables that already exist, and a
half-applied script is worse than either state.

```bash
npx wrangler d1 create makethe-team-restored          # note the id it prints
npx wrangler d1 execute makethe-team-restored --remote --file=dump.sql
npx wrangler d1 execute makethe-team-restored --remote \
  --command="select count(*) from players; select name from d1_migrations order by id desc limit 1"
```

Then point the Worker at it: change `database_id` (and `database_name`) in
`wrangler.jsonc`'s `d1_databases` entry, commit, and push `main`. The deploy
workflow's migration step will apply anything newer than the dump's last
recorded migration, and the smoke check confirms the Worker is serving.

Afterwards, delete the dump from the machine you fetched it to.

## What is not covered

- **Rows changed between the last dump and the failure** — up to 24 hours —
  if Time Travel is unavailable (database gone). Accepted: the product's
  data is fixtures and responses that people can re-enter.
- **Web push subscriptions** are in the database and restore with it, but
  their `VAPID_PRIVATE_KEY` is a Worker secret, not data — see
  `cloudflare.md`. A restore does not affect it; losing the secret does.
- The backup workflow uses the same `CLOUDFLARE_API_TOKEN` as deploy. If that
  token is rotated it needs **D1 → Edit** and **R2 → Edit**, or backups fail
  silently at 03:17 UTC — check the Actions tab after any token change.
