# eshop-ts

TypeScript rewrite of the Django eshop app for Cloudflare Workers: Hono for
routing, Drizzle ORM against D1, R2 for media, one Worker serving both the
static frontend and the API.

The original Django + DRF app lives in a separate repo (`eshop`) and is the
behavioural reference. Django's admin has no equivalent here, so `/admin` is a
custom staff panel (products with inline price/stock editing and image upload,
categories, coupons, orders + bulk-ship, review moderation, user staff/active
toggles) served from `public/admin.html`.

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

npx wrangler r2 bucket create eshop-media

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

The matching product images are staged in `seed-media/products/` and need to
be uploaded to the `eshop-media` R2 bucket individually:

```sh
npx wrangler r2 object put eshop-media/products/mechanical-keyboard.png --file=./seed-media/products/mechanical-keyboard.png --remote
npx wrangler r2 object put eshop-media/products/usb-c-dock.png --file=./seed-media/products/usb-c-dock.png --remote
npx wrangler r2 object put eshop-media/products/rubber-duck.png --file=./seed-media/products/rubber-duck.png --remote
npx wrangler r2 object put eshop-media/products/ergonomic-mouse.png --file=./seed-media/products/ergonomic-mouse.png --remote
npx wrangler r2 object put eshop-media/products/hdmi-cable-2m.png --file=./seed-media/products/hdmi-cable-2m.png --remote
npx wrangler r2 object put eshop-media/products/fidget-cube.png --file=./seed-media/products/fidget-cube.png --remote
```

Or upload them all in one loop:

```sh
for f in seed-media/products/*.png; do
  npx wrangler r2 object put "eshop-media/products/$(basename "$f")" --file="$f" --remote
done
```

Demo accounts: `admin@example.com` / `admin` (staff + superuser) and
`student@example.com` / `correct-horse-battery` (regular user). Their
password hashes were freshly generated with `crypto.pbkdf2Sync` in the exact
`pbkdf2_sha256$<iterations>$<salt-b64>$<hash-b64>` format `src/lib/hash.ts`
expects — the original Django hashes were not reused (incompatible KDF).

## Deploy

```sh
npx wrangler deploy
```
