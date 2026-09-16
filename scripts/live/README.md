# Live provider tests

These scripts use real, billable provider APIs. They prove SDK/provider viability;
they do not replace deterministic tests or Python/TypeScript parity checks.

## DeepSeek v4 Flash

Set `DEEPSEEK_API_KEY` in your process environment, then run:

```sh
npm run live:deepseek-flash
```

`DEEPSEEK_MODEL` optionally overrides the default `deepseek-v4-flash`. The endpoint
is fixed to `https://api.deepseek.com`. Credentials use the existing example helper's
in-memory `SecretStore`; they are never written to profiles or snapshots.

The test checks an exact text response, a real tool call with concurrent user input,
and continuation from a JSON-restored event history. It asserts the latest requested
answer, preserved arrival order, and exactly one tool execution across restoration.
Each Agent completion is also compared with the provider's actual usage, ID, and
returned model: exactly one durable accounting record per call, matching token/cache
counts, correct accumulated totals, and no double counting on restore. Cache hits
may legitimately be zero. Missing counters and costs remain explicitly unknown;
calculated costs retain their pricing source. The initial direct text call is outside
the conversation and is excluded from its accumulated usage. Response IDs are checked
per call rather than assumed unique. This adds no API calls to the existing flow.
Only a synthetic in-memory echo tool and `finish` are exposed to the model.
Missing credentials fail the test rather than reporting a skipped success. Requests
are bounded by a 45-second timeout, 4,096 output tokens, 12 calls and a 3-minute test
deadline. The fetch wrapper keeps only usage/ID/model metadata; it never logs response
bodies, request content, or headers. Summary logs contain model/request/effect counts
and the number of recorded completions, calculated costs, and unknown costs.

On canonical `smolpaws/openhands-agent`, dispatch **Live LLM** from `main`:

```sh
gh workflow run llm.yml --repo smolpaws/openhands-agent --ref main
```

The GitHub environment is **`LLM`**, with secret `DEEPSEEK_API_KEY` and optional
variable `DEEPSEEK_MODEL`. Its deployment policy permits the `main` branch only;
the workflow also checks the canonical repository and branch. The secret is scoped
to the live-test step. The workflow runs on manual dispatch, with a six-minute job
timeout and serialized runs. It does not expose credentials to pull-request code.
Ordinary CI type-checks these scripts without credentials or API calls.

## Anthropic prompt caching (Haiku)

The cache smoke runs ordinary `Agent` turns, with no manually marked cache blocks.
It requires a real initial cache write, cache reads on the following turn and after
restoring event history, and exact per-call/accumulated cache metrics. A zero-hit
result fails. The synthetic prefix exceeds Haiku 4.5's 4,096-token cache minimum;
a per-run nonce prevents an earlier run's warm cache from hiding a missing write.
Only `finish` is exposed as a tool. Three completions are expected; six requests,
192 output tokens per request, 45 seconds per request and three minutes overall
are hard limits. Logs contain usage and marker counts, never credentials or text.

For native Anthropic, set `ANTHROPIC_API_KEY` and run:

```sh
npm run live:anthropic-cache-smoke
```

For the eval-proxy route used by SmolPaws, set `LITELLM_PROXY_API_KEY` and run:

```sh
LLM_PROVIDER_ID=litellm_proxy \
LLM_MODEL=anthropic/claude-haiku-4-5-20251001 \
LLM_BASE_URL=https://llm-proxy.eval.all-hands.dev/v1 \
npm run live:anthropic-cache-smoke
```

`LLM_MODEL` (or `ANTHROPIC_MODEL`) and `LLM_BASE_URL` select a different model or
endpoint. The default native model is Haiku 4.5. Missing credentials fail instead
of skipping. The **Live LLM** workflow also runs this regression from canonical
`main`, in the **LLM** environment, using secret `LITELLM_PROXY_API_KEY` and optional
variable `ANTHROPIC_CACHE_MODEL`. It uses Haiku through the eval proxy by default.
Deterministic upstream-derived tests remain the parity evidence; this script proves
that the real provider accepts the serialized requests and reports cached usage.

## Other scripts

- `llm-smoke.mjs` (`live:llm`) resolves credentials from the local OS keyring.
- `openai-responses-reasoning.ts` uses environment credentials through the same
  example helper; missing keys currently skip that separate script.
- The separate **Examples** workflow uses the existing `examples` environment
  with OpenAI, Anthropic and Gemini secrets. It is independent of `LLM`.
