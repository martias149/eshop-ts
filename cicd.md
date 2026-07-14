# CI/CD — eshop-ts (Cloudflare Workers + GitHub Actions)

Free three-tier pipeline: **test → dev → prod**.

**Status: built and live**, except one step only a human can do — minting the
Cloudflare API token (see [Remaining](#remaining)). Until that token is in the
repo secrets, PR checks pass but the deploy workflows fail at the wrangler step.

## Topology

| Tier | Trigger | Worker | D1 | URL |
|---|---|---|---|---|
| **test** | every PR | — | — | — |
| **dev** | push to `dev` | `eshop-dev` | `eshop-db-dev` (`6c946ab6…`) | https://eshop-dev.brazdil94.workers.dev |
| **prod** | push to `main` | `eshop` | `eshop-db` (`a1a82243…`) | https://eshop.brazdil94.workers.dev |

Flow: feature branch → PR into `dev` (tests gate it) → merge, dev deploys → PR
`dev` → `main` (tests gate it again) → merge, prod deploys.

The point of the split is that **dev has its own database**. A bad migration can
only wreck `eshop-db-dev`. Verified by bumping a product's stock in dev and
watching prod not move.

The test tier needs **no Cloudflare credentials at all**: vitest runs the worker
in local workerd, and the env checks use `wrangler deploy --dry-run`, which
resolves config offline. So PRs from forks can be gated without handing out
deploy rights.

## What guards what

The pipeline's failure modes are mostly silent, so each one has a test that
fails on the real mistake. Every guard below was verified by reintroducing the
bug and watching it go red — a test that has never failed is not a test.

| Guard | Catches | Where |
|---|---|---|
| `no two environments share a database_id` | dev pointed at prod's D1 — every dev write and migration landing on live orders | `tests/node/envs.test.ts` |
| `env.N resolves its own DB, plus ASSETS and every var` | a binding or var silently missing from an env, asserted against **wrangler's own resolver** (`deploy --dry-run`), not against a re-derivation of its inheritance rules | `tests/node/envs.test.ts` |
| `env.N repeats every top-level var` | `vars` are **not** inherited by environments; a missing one is `undefined` at runtime, not a failed deploy | `tests/node/envs.test.ts` |
| `every wrangler command in deploy-dev carries --env dev` | the dev workflow losing its env flag and migrating production instead | `tests/node/workflows.test.ts` |
| `deploy-N runs the tests before it deploys` | shipping a red build | `tests/node/workflows.test.ts` |
| `seed.sql still applies to the current schema` | hand-maintained seed SQL rotting against a schema change — only surfaces when provisioning a new environment | `tests/seed.test.ts` |
| `the seeded password hashes still verify` | the seed's hash format drifting from `lib/hash.ts`, breaking both demo logins everywhere at once | `tests/seed.test.ts` |
| `the API emits exactly the keys the frontend reads` | backend/frontend contract drift — the source of 3 of this rewrite's 4 real bugs | `tests/contract.test.ts` |
| `the frontend reads the keys the API emits` | the other half of the same seam: `public/app.js` rendered in jsdom against a real-shaped payload | `tests/node/frontend.test.ts` |

`tests/fixtures/api-contract.ts` is the single source of truth for that seam —
both halves assert against it, so renaming a field fails both sides at once
rather than letting them drift apart.

### Two things deliberately *not* tested

- **GitHub expression falsiness.** Testing it would mean re-implementing
  GitHub's expression evaluator and asserting my copy behaves like my copy.
  Instead the footgun is designed out: two literal workflow files, no computed
  `--env`. (`x && '' || 'y'` always yields `'y'` because `''` is falsy — an
  earlier draft of this plan used exactly that shape to pick an environment.)
- **Whether the real cloud honours `--env`.** Needs live credentials; can't be
  hermetic. Covered instead by the config test above plus the fact that tests
  run before any destructive step.

## Layout

- `.github/workflows/ci.yml` — PRs: typecheck + tests. No credentials.
- `.github/workflows/deploy-dev.yml` — push to `dev`: test → migrate → deploy → smoke.
- `.github/workflows/deploy-prod.yml` — push to `main`: same, against production.
- `wrangler.jsonc` — top-level config is production; `env.dev` is the dev tier.
- Two vitest projects (`vitest.config.ts`): `worker` runs in real workerd;
  `node` runs the seams that need `child_process` / `fs` / jsdom, none of which
  exist inside workerd.

## Remaining

1. **HUMAN** — mint a Cloudflare API token: dashboard → My Profile → API Tokens
   → template **Edit Cloudflare Workers**, then add permission
   **Account · D1 · Edit**, scoped to account `c8d6805d36d64b5a42f22fe1847a6b6f`.
   The wrangler OAuth login cannot create this; it has no token-write scope.

   ```sh
   gh secret set CLOUDFLARE_API_TOKEN   # paste it
   ```

   `CLOUDFLARE_ACCOUNT_ID` is already set.

2. Then create the dev branch and watch the pipeline run for real:

   ```sh
   git checkout -b dev && git push -u origin dev
   gh run watch
   curl -s https://eshop-dev.brazdil94.workers.dev/api/products | head -c 200
   ```

## Optional, not done

- Branch protection on `main` requiring the `CI / test` check
  (`gh api repos/jurab/eshop-ts/branches/main/protection`, needs admin).
- Stripe and Sentry secrets. Unset by design — payment falls back to a fake
  always-succeeds provider and Sentry stays off. If Stripe is wired, dev must
  get **test-mode** keys and its own webhook endpoint pointing at
  `https://eshop-dev.brazdil94.workers.dev/api/stripe/webhook`.
- Per-PR preview URLs via `wrangler versions upload`.

## Known pitfalls

- **`vars` are not inherited by environments; `assets` is.** Verified with a
  dry-run probe against wrangler 4.107: an `env.dev` declaring only
  `d1_databases` still resolved `ASSETS`, but wrangler warned
  `"vars" exists at the top level, but not on "env.dev" … not inherited`. An
  earlier draft of this doc asserted the opposite about `assets` and was simply
  wrong — which is exactly why the test asserts on wrangler's output instead of
  on my understanding of it.
- **`d1 migrations apply DB` takes the *binding* name**, resolved against the
  selected environment. Drop `--env dev` and it applies to production. No
  prompt, no diff, no undo.
- **Migrations run before the new code is live.** Fine for additive changes; for
  a destructive one, expand-then-contract across two deploys.
- **`compatibility_date` cannot outrun the installed wrangler's workerd.** It is
  pinned to `2026-07-09` because a later date made `wrangler dev` refuse to
  start. The vitest `worker` project deliberately does **not** override the date
  any more, so the suite now fails if someone bumps it past what the pinned
  toolchain can run. Bump wrangler first.
  (Do not try to derive the supported date from workerd's version string:
  workerd `1.20260702.1` supports compat dates up to `2026-07-09`.)
- **Free tier**: Actions is unlimited on public repos; Workers free plan hard-
  stops at 100k req/day rather than billing. Two workers and two D1 databases
  still cost nothing.
