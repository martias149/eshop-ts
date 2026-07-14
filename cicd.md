# CI/CD plan — eshop-ts (Cloudflare Workers + GitHub Actions)

Plan for a free, three-tier pipeline: **test → dev → prod**. Written to be
executed by Claude in this repo. Phases run in order; each ends with a
verification step — do not proceed past a failed one.

## State of the world (verified 2026-07-14, re-verify anything marked ⟳)

This replaces an earlier draft written when the rewrite still lived in a
`worker/` subdirectory of the Django repo. Everything below reflects reality
after the move, the R2 removal, and the first production deploy.

- **Repo**: `github.com/jurab/eshop-ts`, public, only branch `main`. The worker
  is the **repo root** — there is no `worker/` subdirectory, so no
  `working-directory` is needed in workflows. The Django original lives in a
  separate repo and is not part of this pipeline.
- **Production is already live**: worker `eshop` at
  `https://eshop.brazdil94.workers.dev`, D1 `eshop-db`
  (`a1a82243-3632-4add-a3b7-bfcff7f248f6`), migrations applied, seed data
  loaded. Deploys are currently manual (`npx wrangler deploy` from this
  machine). This plan automates that and adds a dev tier beneath it.
- **There is no R2.** It is not enabled on the account, so there is no `MEDIA`
  binding and no `r2_buckets` block. Product images are static assets under
  `public/media/`. Do not add R2 resources to any environment.
- **Bindings**: `DB` (D1) and `ASSETS` (static assets from `public/`). Vars:
  `STRIPE_CURRENCY`, `PASSWORD_HASH_ITERATIONS`.
- **Secrets**: only `ANTHROPIC_API_KEY` is set, on prod. `STRIPE_SECRET_KEY`,
  `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` and `SENTRY_DSN` are
  **unset by design** — the app degrades cleanly (payment falls back to a fake
  always-succeeds provider, Sentry stays off). Setting them is optional and
  orthogonal to this plan.
- **Tests are hermetic**: `@cloudflare/vitest-pool-workers` runs everything in
  local workerd with migrations injected from `migrations/`. **CI needs no
  cloud credentials to run tests** — only to deploy.
- Cloudflare account `c8d6805d36d64b5a42f22fe1847a6b6f`, local `wrangler` is
  OAuth-authenticated. `gh` is authenticated as `jurab` with `workflow` scope.
- Scripts: `npm run typecheck` (`tsc --noEmit`), `npm test` (`vitest run`).

## Target topology

| Tier | Trigger | Worker | D1 | Purpose |
|---|---|---|---|---|
| **test** | every PR | — | — | typecheck + vitest in local workerd. No cloud, no credentials, no deploy. |
| **dev** | push to `dev` | `eshop-dev` | `eshop-db-dev` | Live scratch environment. Safe to break. Stripe test-mode keys if wired. |
| **prod** | push to `main` | `eshop` | `eshop-db` | The real thing. Already live. |

Intended flow: feature branch → PR into `dev` (test tier gates it) → merge
(auto-deploys dev) → PR `dev` → `main` (test tier gates it again) → merge
(auto-deploys prod).

The point of the split is that **dev has its own database**. A migration or a
seed script that corrupts data can only corrupt `eshop-db-dev`. Sharing one D1
across both tiers would defeat the entire exercise.

## Ground rules

- Don't touch `src/` — this plan changes `wrangler.jsonc`, adds
  `.github/workflows/`, and adds this file. If a verification failure traces to
  app code, stop and report rather than patching around it.
- Steps marked **HUMAN** need something only Jura can provide (dashboard
  actions, secret values). Batch them: get as far as possible, then present all
  HUMAN items at once.

## Phase 0 — preconditions

1. `npm ci && npm run typecheck && npm test` — all green (38 tests as of
   writing).
2. `npx wrangler whoami` succeeds and shows account
   `c8d6805d36d64b5a42f22fe1847a6b6f`.
3. `gh auth status` shows `workflow` scope.
4. `git status` clean, on `main`, synced with origin.

## Phase 1 — dev environment

1. `npx wrangler d1 create eshop-db-dev` → note the returned `database_id`.

2. Add an `env.dev` block to `wrangler.jsonc`, keeping the existing top-level
   config as production:

```jsonc
"env": {
  "dev": {
    "name": "eshop-dev",
    "d1_databases": [
      {
        "binding": "DB",
        "database_name": "eshop-db-dev",
        "database_id": "<id from step 1>"
      }
    ],
    "vars": {
      "STRIPE_CURRENCY": "eur",
      "PASSWORD_HASH_ITERATIONS": 100000
    }
  }
}
```

   `assets` is **not** repeated — see the inheritance note in the pitfalls
   section; it is inherited, `vars` and `d1_databases` are not. ⟳ If the
   top-level config has grown new *bindings* or *vars* since this was written,
   mirror those into `env.dev` too (with `-dev` resource names).

3. Apply migrations to the dev database. **Verify the target first** — this is
   the step that can silently rewrite production if the env flag isn't honored:

```sh
npx wrangler d1 migrations list DB --env dev --remote   # must name eshop-db-dev
npx wrangler d1 migrations apply DB --env dev --remote
```

4. Seed it: `npx wrangler d1 execute DB --env dev --remote --file=./scripts/seed.sql`

5. Deploy it once by hand so the worker exists (secrets can't be set on a
   worker that has never been deployed): `npx wrangler deploy --env dev`

6. **HUMAN** (optional): dev secrets. `ANTHROPIC_API_KEY` for the chatbot; may
   reuse the prod value if Jura says so. Stripe keys, if wired at all, must be
   **test mode**. Set with `npx wrangler secret put <NAME> --env dev` — this is
   a *separate* secret store from prod, nothing is shared.

7. **Verify**: `npx wrangler deploy --dry-run --env dev` lists worker name
   `eshop-dev` and bindings `DB` + `ASSETS`. Then
   `curl https://eshop-dev.brazdil94.workers.dev/api/products` returns the six
   seeded products. Then `npm test` still passes (vitest reads `wrangler.jsonc`
   and must still parse it with the new `env` block).

## Phase 2 — GitHub secrets + workflows

1. **HUMAN**: create a Cloudflare API token (dashboard → My Profile → API
   Tokens → template **Edit Cloudflare Workers**, then add permission
   **Account · D1 · Edit**; scope it to this account). OAuth login cannot mint
   this — it must come from the dashboard.

2. Set repo secrets:

```sh
gh secret set CLOUDFLARE_API_TOKEN        # paste token
gh secret set CLOUDFLARE_ACCOUNT_ID --body "c8d6805d36d64b5a42f22fe1847a6b6f"
```

3. `.github/workflows/ci.yml` — the test tier. Runs on every PR, needs no
   credentials:

```yaml
name: CI

on:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

4. `.github/workflows/deploy.yml` — dev and prod. The `ENV_FLAG` expression is
   written truthy-branch-first on purpose; see pitfalls.

```yaml
name: Deploy

on:
  push:
    branches: [dev, main]

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      ENV_FLAG: ${{ github.ref_name == 'dev' && '--env dev' || '' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - name: Apply D1 migrations
        run: npx wrangler d1 migrations apply DB --remote $ENV_FLAG
      - name: Deploy
        run: npx wrangler deploy $ENV_FLAG
```

   Tests run before deploy in the same job: steps are sequential and a failing
   step aborts the rest, so a red test cannot ship.

5. Commit `wrangler.jsonc` + both workflows + this file. Push to `main`.

## Phase 3 — verification (end to end)

1. The Phase 2 push to `main` triggers **Deploy** → `gh run watch`. Must go
   green through migrations and deploy. Then
   `curl https://eshop.brazdil94.workers.dev/api/products` still returns JSON —
   i.e. the automated deploy did not break the live site.
2. Create the dev branch: `git checkout -b dev && git push -u origin dev`.
   Watch the run, then curl `https://eshop-dev.brazdil94.workers.dev/api/products`.
3. Confirm the two tiers are actually isolated — this is the whole point of the
   split, so prove it rather than assume it. Change a product's stock in dev
   only, and confirm prod is unaffected:

```sh
npx wrangler d1 execute DB --env dev --remote --command \
  "UPDATE products SET stock=999 WHERE slug='rubber-duck'"
curl -s https://eshop-dev.brazdil94.workers.dev/api/products/rubber-duck | grep -o '"stock":[0-9]*'  # 999
curl -s https://eshop.brazdil94.workers.dev/api/products/rubber-duck     | grep -o '"stock":[0-9]*'  # 0
```

   Then put dev back: `UPDATE products SET stock=0 WHERE slug='rubber-duck'`.
4. PR check: branch off `dev`, make a trivial change (whitespace in
   `README.md`), open a PR against `dev`. The `CI / test` check must appear and
   pass, and **no deploy must run**. Close the PR, delete the branch.

## Phase 4 — optional hardening (only if Jura asks)

- Branch protection on `main`: require the `CI / test` check and require PRs
  (`gh api repos/jurab/eshop-ts/branches/main/protection`, needs admin).
- A `preview` tier per-PR using wrangler versions (`wrangler versions upload`),
  giving every PR its own URL. Costs nothing but adds moving parts.
- Sentry release tagging in the deploy step (needs `SENTRY_DSN` wired first).
- Stripe: a test-mode webhook pointing at
  `https://eshop-dev.brazdil94.workers.dev/api/stripe/webhook` for dev, separate
  from prod's, each with its own `STRIPE_WEBHOOK_SECRET`.

## Known pitfalls

- **`vars` are not inherited by environments; `assets` is.** Verified against
  wrangler 4.107 with a dry-run probe: an `env.dev` declaring only
  `d1_databases` still resolved the `ASSETS` binding, but wrangler emitted
  `"vars" exists at the top level, but not on "env.dev" … not inherited`. So
  `env.dev` must repeat `vars` and every real binding, but not `assets`. The
  `--dry-run --env dev` binding check in Phase 1.7 exists to catch this class of
  mistake — trust its output over this paragraph.
- **`d1 migrations apply DB` takes the *binding* name**, resolved against the
  selected environment. Getting this wrong points migrations at production.
  Always run `d1 migrations list DB --env dev --remote` first and read which
  database it names.
- **Migrations run before the new code is live.** Fine for additive changes;
  for a destructive one, expand-then-contract across two deploys.
- **GitHub expression falsiness**: `x && '' || 'y'` always yields `'y'`, because
  `''` is falsy. Keep `ENV_FLAG` truthy-branch-first, exactly as written.
- **`compatibility_date` cannot outrun the installed wrangler's workerd.**
  It is pinned to `2026-07-09` because a later date made `wrangler dev` refuse
  to start (`newest date supported by this server binary is …`). Bump wrangler
  before bumping the date. `vitest.config.ts` overrides it for the test runner
  for the same reason — leave that override alone.
- **Free tier**: GitHub Actions is unlimited on public repos (this one is
  public); Workers free plan is 100k requests/day and hard-stops rather than
  billing. Two workers and two D1 databases still cost nothing. Nothing in this
  plan requires a paid plan.
