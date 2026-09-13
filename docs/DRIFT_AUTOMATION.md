# Weekly drift automation runbook

This runbook is the procedure an unattended coding agent follows to advance
`@smolpaws/openhands-agent` against upstream `OpenHands/software-agent-sdk`.
It is written for a scheduled OpenHands Cloud automation with a hard wall-clock
budget, but a human can follow it verbatim.

It does not replace policy. Read these first, in this order:

1. [`AGENTS.md`](../AGENTS.md) — operational rules for coding agents.
2. [`TRANSPILE_CONTRACT.md`](TRANSPILE_CONTRACT.md) — scope, dispositions, `DEV-*`/`EXC-*`/`EXT-*` policies, tests-first rule.
3. [`DRIFT_TOOLING.md`](DRIFT_TOOLING.md) — the `drift:scan` / `drift:prepare` / `drift:check` machinery.

If anything in this runbook contradicts the contract, the contract wins.

## Outcome of one run

Exactly one of:

- **No new upstream release since the pin** → do nothing except print a short summary. Do not open a PR.
- **An open drift PR already exists** → resume it (see [Resuming](#resuming-an-open-drift-pr)).
- **A new release exists** → one PR on branch `drift/<OLD8>..<NEW8>` that closes one finite interval, or a pushed work-in-progress branch plus a draft PR with a `## Handoff` section when the time budget runs out.

Never merge. Never push to `main`. Never move the pin in a partial state.

## Time budget

The automation is killed at 30 minutes. Plan for 25.

| Checkpoint | Deadline | If late |
|---|---|---|
| Repos cloned, `npm ci` done, interval selected | 6 min | continue |
| Interval prepared and classified, review file committed and pushed | 12 min | continue |
| `PORT` items done | 22 min | stop porting; push; draft PR with `## Handoff` |
| Oracle regenerated, evidence green, pin moved, PR opened | 27 min | push whatever is committed; draft PR with `## Handoff` |

Commit and push after every completed step. A pushed branch is the only state
that survives the sandbox. An unpushed sandbox is a wasted run.

## Environment setup

The automation clones `enyst/openhands-agent` for you. Work inside that clone.
Then:

```sh
# 1. Toolchain
node --version            # 22.x expected; install via nvm if missing
npm ci

# 2. Upstream checkout with history (blob filter keeps it fast; diffs fetch lazily)
git clone --filter=blob:none https://github.com/OpenHands/software-agent-sdk ../software-agent-sdk
UPSTREAM=../software-agent-sdk

# 3. Python for the pinned oracle (only needed at the close step)
command -v uv >/dev/null || python3 -m pip install --user uv
```

`OLD_PIN` is always read from the manifest, never typed by hand:

```sh
OLD_PIN="$(node -p "require('./transpile/upstream.json').commit")"
```

## Selecting `NEW_PIN`

Intervals end on upstream **release commits** (first-parent commits on `main`
whose subject starts with `Release v`). Pick the newest release that keeps the
interval reviewable in one run:

```sh
git -C "$UPSTREAM" log --first-parent --format='%H %s' "$OLD_PIN..origin/main" \
  | grep -E ' Release v[0-9]' | head -n 1
```

Rules:

- If that prints nothing, there is no new release: stop, print
  `no new upstream release since <OLD_PIN>`, and exit successfully.
- Count first-parent commits in `OLD_PIN..NEW_PIN`. If there are more than 30,
  choose an **earlier** release commit so the interval stays under 30. One
  weekly run may leave later releases for next week; that is the design.
- `NEW_PIN` must be the full 40-character SHA. Never a branch name.

Branch: `drift/${OLD_PIN:0:8}..${NEW_PIN:0:8}`. Create it from `origin/main`.

## Resuming an open drift PR

Before selecting anything, look for an open PR whose head branch starts with
`drift/`. If one exists:

1. Check out that branch. Its interval is fixed; do not pick a new `NEW_PIN`.
2. Read its description. A `## Handoff` section lists what is done and what remains.
3. Check CI on its head. Red CI is the first thing to fix.
4. Continue from the first unfinished step below, then remove the `## Handoff`
   section and mark the PR ready for review when the interval is closed.

Do not open a second drift PR while one is open. If the open PR was authored
by a human and has review discussion, leave it alone and exit with a summary.

## Procedure

### Step 1 — prepare the interval

```sh
npm run drift:prepare -- \
  --upstream "$UPSTREAM" \
  --to "$NEW_PIN" \
  --out "transpile/updates/${OLD_PIN:0:8}..${NEW_PIN:0:8}.json"
```

This writes three sibling files: `.json` (your review), `.inventory.json`
(generated facts, do not edit), `.md` (generated report). Read the `.md`.
Commit all three immediately with message
`drift(<OLD8>..<NEW8>): prepare interval`.

### Step 2 — classify every unit before touching code

Open the `.json`. Every key in `items` is `<full-sha>:<target>`. For each:

- Look at the upstream commit: `git -C "$UPSTREAM" show --stat <sha>` and the
  diff of the in-scope files listed in the inventory. Read the upstream tests
  that changed.
- Find the TypeScript counterpart in `src/`. Use the inventory `modules` as the
  hint (`llm` → `src/llm/`, `conversation` → `src/conversation/`, etc.).
- Set `disposition`, a concrete `reason`, and `docsImpact` (`"none"` or `"update"`).

Disposition guide:

| Situation | Disposition | Required fields |
|---|---|---|
| Upstream changed observable SDK behavior that the TS port implements | `PORT` | `evidence` (filled in Step 3) |
| Release version bumps, `uv.lock`, CI, LiteLLM-only internals, telemetry with no TS surface | `NO_TARGET_CHANGE` | specific `reason` (say *what* has no TS counterpart) |
| Touches confirmation gates, security analyzers, cipher/secret persistence, ACP runtime | `DEVIATION` | `policy: "DEV-SDK-00x"` |
| Entirely inside plugin or marketplace runtime | `EXCLUDED` | `policy: "EXC-SDK-00x"`; every changed file must be under that exclusion |
| In scope, real behavior change, but not portable this run | `DEFERRED` | `tracking`, `compatibilityConsequence`, `revisitTrigger` |
| Target is `server` | `NO_TARGET_CHANGE` | reason: `openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; this repository owns only the SDK/tools/workspace TypeScript sources.` |

Every key under `unmapped` needs a short string explanation (for example
`"clients/typescript: upstream TS client, not part of this transpile"`). If a
path recurs every interval, also add it to `ignorePrefixes`/`ignorePaths` in
`transpile/upstream.json` in the same PR.

`DEFERRED` is honest, not lazy. Use it when the port needs a design decision,
a new provider surface, or more than the remaining budget. Never use it to
avoid reading the diff.

Validate, then commit and push:

```sh
npm run drift:check -- --upstream "$UPSTREAM" \
  --review "transpile/updates/${OLD_PIN:0:8}..${NEW_PIN:0:8}.json" --phase review
git add transpile/updates && git commit -m "drift(<OLD8>..<NEW8>): classify interval review units" && git push -u origin HEAD
```

### Step 3 — port `PORT` items tests-first

For each `PORT` unit, smallest first:

1. Find the upstream test change (or write the missing compatibility test from
   the source diff).
2. Add or adapt the TypeScript test under the matching `src/<module>/__tests__/`.
3. Run only that test file and confirm it fails for the expected reason:
   `npx vitest run src/<module>/__tests__/<file>.test.ts`
4. Implement the smallest change that makes it green. Keep provider-specific
   behavior in provider clients; keep the shared `LLMClient` boundary thin.
5. Add the test path to that unit's `evidence` array in the review `.json`.
6. Commit: `drift(<sha8>): <what was ported> (PORT)` and push.

If a `PORT` turns out to be larger than the remaining budget, reclassify it
`DEFERRED` with a real `revisitTrigger` (for example `"next interval; needs
streaming surface in src/llm"`), note it in the PR, and move on. Do not leave
half-implemented code.

### Step 4 — regenerate the pinned Python projection oracle

`transpile/wire/python-projection-oracle.json` records the upstream commit it
was generated from, and CI fails if it disagrees with the manifest. Regenerate
it at `NEW_PIN`:

```sh
git -C "$UPSTREAM" checkout --detach "$NEW_PIN"
( cd "$UPSTREAM" && OPENHANDS_UPSTREAM_COMMIT="$NEW_PIN" \
  uv run --package openhands-sdk python \
    "$OLDPWD/scripts/parity/generate-python-projection-oracle.py" \
    --cases "$OLDPWD/transpile/wire/projection-cases.json" \
    --output "$OLDPWD/transpile/wire/python-projection-oracle.json" )
```

`OPENHANDS_UPSTREAM_COMMIT` is mandatory and must equal `NEW_PIN`. `uv`
downloads a matching Python (3.12+) and syncs the workspace on first use;
this took about 30 seconds on a fresh sandbox, budget up to 5 minutes. Then:

```sh
npx tsc -p tsconfig.parity.json
npx tsx scripts/parity/check-projection-parity.ts --report .wire/projection.json
```

A parity mismatch here means upstream changed event-to-message projection and
the corresponding unit was misclassified. Go back to Step 3 for it.

### Step 5 — evidence

All of these must pass before the pin moves:

```sh
npm test
npm run test:drift
npm run typecheck
npm run typecheck:drift
npm run lint
npm run build
npm run typecheck:examples
```

`npm run test:examples` is slower; run it when any `PORT` touched `examples/`
or the agent loop, otherwise mention in the PR that it was skipped.

### Step 6 — close the interval and move the pin

```sh
npm run drift:check -- --upstream "$UPSTREAM" \
  --review "transpile/updates/${OLD_PIN:0:8}..${NEW_PIN:0:8}.json" --phase close
```

Only when that passes, set `"commit"` in `transpile/upstream.json` to
`NEW_PIN`. Re-run `npm run drift:check ... --phase close` once more: the
checker recognizes an already-closed interval and passes. Commit everything as
one commit:

```
drift: close upstream interval <OLD8>..<NEW8> (vX.Y.Z -> vA.B.C)
```

### Step 7 — open the PR

Use `.github/PULL_REQUEST_TEMPLATE/upstream-pin-advance.md` as the body
layout. Fill in the disposition counts from the review file, tick only the
evidence you actually ran, and list every `DEFERRED` with its revisit trigger.
Under "Agent-server evidence" write: `Server re-vendor is handled by the
weekly smolpaws automation after this PR merges.` Base branch `main`.

If the run is ending on a partial branch, open the PR as a **draft** and add:

```
## Handoff
Done: <steps completed>
Remaining: <steps and unit ids left>
Blockers: <anything a human must decide>
```

## Hard rules

- One interval per PR. The pin moves only in the closing commit.
- Never edit `*.inventory.json`; regenerate with `drift:prepare` if the
  interval changes.
- Never introduce or widen an intentional difference without a `DEV-*`/`EXC-*`
  entry in the contract. If a change seems to need one, classify `DEFERRED`
  and say so in the PR; a human adds policy.
- Never disable, skip, or loosen a test to get green.
- Never touch `EXT-SDK-*` files (`send_message`, task-scheduler tools) as part
  of a port; they have no upstream counterpart.
- Do not rewrite `TRANSPILE_CONTRACT.md`, `DRIFT_TOOLING.md`, or `AGENTS.md`
  in a drift PR. Set `docsImpact: "update"` and describe the needed change in
  the PR instead.
- No secrets in commits, review files, or PR text.
- Commit messages: no model names, no tool attribution beyond
  `Co-authored-by: openhands <openhands@all-hands.dev>`.

## Cross-repository follow-up

The Python agent-server package is transpiled in
`smolpaws/smolpaws/packages/openhands-agent-server`. Its weekly automation
re-vendors this package from `main` after a drift PR merges, then reviews the
`:server` units of the same interval there. This repository's PR must not
wait for it, and must not try to do it.
