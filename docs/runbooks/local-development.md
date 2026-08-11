# Local development

## First run

```bash
npm ci
npm run db:migrate:local
npm run seed:local
npm run dev
```

The Worker serves on http://127.0.0.1:8787. Only `/` and `/robots.txt` exist;
everything else returns a bare 404 by design (TR-34).

## Triggering cron jobs by hand

`wrangler dev` does not fire cron triggers on a schedule. Invoke them directly
against the local scheduled-trigger endpoint (`wrangler dev` prints this path
in its startup banner):

```bash
# Daily materialisation
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=15+3+*+*+*"

# Hourly sweep (a stub until M3)
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=0+*+*+*+*"
```

## Inspecting the local database

```bash
npm run show:local
wrangler d1 execute makethe-team --local --command "SELECT * FROM games"
```

## Resetting

```bash
rm -rf .wrangler/state
npm run db:migrate:local
npm run seed:local
```

`scripts/seed.sql` deletes every row in four tables, so always go through
`npm run seed:local` — never `wrangler d1 execute --file=scripts/seed.sql`
by hand. The npm script creates a local-only `seed_guard` table that the
file's first statement writes to and its last statement drops; run the file
anywhere that table does not exist (production, or a stray `--remote`) and it
aborts on statement one, before any `DELETE`.

## Tests

```bash
npm test              # once
npm run test:watch    # watch mode
```

Tests run in workerd against a real D1 binding, built by applying the same
migration files wrangler applies in production (TR-27, TR-28). If you add a
migration, restart `npm test` — the migration directory is read at config load,
not on watch reload.
