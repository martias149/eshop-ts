# eshop-ts

TypeScript rewrite of the Django eshop app for Cloudflare Workers: Hono for
routing, Drizzle ORM against D1, one Worker serving both the static frontend
and the API.

Live: **https://eshop.brazdil94.workers.dev** (`/admin` for the staff panel).

The original Django + DRF app lives in a separate repo (`eshop`) and is the
behavioural reference. Django's admin has no equivalent here, so `/admin` is a
custom staff panel (products with inline price/stock editing and image upload,
categories, coupons, orders + bulk-ship, review moderation, user staff/active
toggles) served from `public/admin.html`.

## Media, and the absence of R2

R2 is not enabled on the deployed account, so the seeded product images ship as
static assets under `public/media/` — served free, and at exactly the
`/media/products/*.png` URLs the seed data already points at. The `MEDIA`
binding is therefore optional: admin image *upload* returns 503 without it, and
everything else works. To turn uploads on, enable R2, create the bucket, and add
the binding back to `wrangler.jsonc`:

```sh
npx wrangler r2 bucket create eshop-media
for f in seed-media/products/*.png; do
  npx wrangler r2 object put "eshop-media/products/$(basename "$f")" --file="$f" --remote
done
```

```jsonc
"r2_buckets": [{ "binding": "MEDIA", "bucket_name": "eshop-media" }]
```

No other code change is needed — `src/index.ts`'s `/media/*` route already
falls back to R2 for any key with no matching static asset.

## Order emails, and the absence of Email Sending

Order confirmation (on payment) and shipped notification (on admin bulk-ship)
emails follow the same optional-binding pattern as R2: without the `EMAIL`
binding and `EMAIL_FROM` var they are silently skipped and nothing else
degrades. To turn them on, onboard a domain and add both to `wrangler.jsonc`:

```sh
npx wrangler email sending enable yourdomain.com
```

```jsonc
"send_email": [{ "name": "EMAIL" }],
"vars": { "EMAIL_FROM": "orders@yourdomain.com" }
```

A failed send is logged and never surfaced to the customer, and the
pending→paid transition is written with a conditional update, so even when
`/pay`, `/confirm-payment`, and the Stripe webhook race, exactly one of them
sends the confirmation.

Money is stored as integer cents throughout and rendered as decimal strings
(`"24.60"`) on the wire. D1 has no interactive transactions, so checkout
reserves stock with one conditional `UPDATE ... WHERE stock >= qty` per line
and compensates (restores) the earlier lines if a later one fails.

## Local dev

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in secrets for local testing

npx wrangler d1 migrations apply eshop-db --local
npx wrangler d1 execute eshop-db --local --file=./scripts/seed.sql

npx wrangler dev
```

The app is fully usable locally without any secrets: with `STRIPE_SECRET_KEY`
unset, `POST /api/orders/:id/pay` falls back to a fake always-succeeds
provider, and the support chatbot returns 503 until `ANTHROPIC_API_KEY` is set.

## Tests

```sh
npm run typecheck
npm test          # vitest, via @cloudflare/vitest-pool-workers
```

## One-time cloud setup

```sh
npx wrangler login

npx wrangler d1 create eshop-db
# paste the returned database_id into wrangler.jsonc (d1_databases[0].database_id)

# all secrets are optional — without them, payment uses the fake provider,
# the chatbot 503s, and Sentry stays off. Nothing else degrades.
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_PUBLISHABLE_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put SENTRY_DSN

npx wrangler d1 migrations apply eshop-db --remote
```

## Schema & migrations

Schema lives in `src/db/schema.ts`. After changing it, regenerate migrations:

```sh
npm run db:generate
```

## Seed data

Sample categories, products, product images, reviews, coupons, and the two
demo accounts (ported from the reference Django app's `db.sqlite3` and
`media/products/`) live in `scripts/seed.sql`. Load it into D1:

```sh
# local dev
npx wrangler d1 execute eshop-db --local --file=./scripts/seed.sql

# remote
npx wrangler d1 execute eshop-db --remote --file=./scripts/seed.sql
```

The matching product images live in `public/media/products/` and deploy as
static assets — no upload step. (`seed-media/products/` holds the same six
files, staged for R2 if you ever enable it; see above.)

Demo accounts: `admin@example.com` / `admin` (staff + superuser) and
`student@example.com` / `correct-horse-battery` (regular user). Their
password hashes were freshly generated with `crypto.pbkdf2Sync` in the exact
`pbkdf2_sha256$<iterations>$<salt-b64>$<hash-b64>` format `src/lib/hash.ts`
expects — the original Django hashes were not reused (incompatible KDF).

## Deploy

```sh
npx wrangler deploy
```
