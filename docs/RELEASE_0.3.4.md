# Release 0.3.4

`0.3.4` completes provider-native tool calling for `@smolpaws/openhands-agent`. It follows `0.3.3` by extending the resolved `ToolDefinition` flow beyond OpenAI to Anthropic Messages, the current Gemini Interactions API, and standard OpenAI-compatible Chat Completions routes.

## Highlights

- Added Anthropic native tool calling:
  - tool definitions serialize to Anthropic's `tools` format
  - assistant `tool_use` blocks become neutral `MessageToolCall` records
  - parallel `tool_result` blocks are grouped into one user turn for continuation
  - signed and redacted thinking blocks survive response parsing and transcript replay
  - malformed known blocks, arguments, and missing result IDs fail before a provider request
- Migrated Gemini to the current Interactions API:
  - requests use stateless `store: false` interactions, keeping the durable SDK transcript as the restore and fork source of truth
  - function tools, parallel function calls, function results, model output, and signed thought steps round-trip as typed interaction steps
  - malformed known response content fails closed while unknown future step types remain forward-compatible
- Extended standard Chat Completions tool behavior to OpenRouter, LiteLLM-compatible, and custom OpenAI-compatible routes without adding LiteLLM or translating nonstandard proxy dialects.
- Added cross-provider serialization coverage, focused continuation regressions, a credential-free serialization example, a credential-gated Gemini tool example, and provider research/architecture documentation.

## Verification

Run before publishing/tagging:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run typecheck:examples
npm run test:examples
npm run typecheck:live
npm pack --dry-run
```

Verification result for the release branch:

- `npm test` — passed, 40 files / 268 tests (267 before the final redacted-thinking regression)
- `npm run typecheck` — passed
- `npm run lint` — passed
- `npm run build` — passed
- `npm run typecheck:examples` — passed
- credential-free `npm run test:examples` — passed
- `npm run typecheck:live` — passed
- `npm pack --dry-run` — passed; tarball `smolpaws-openhands-agent-0.3.4.tgz`, package size 409.9 kB, unpacked size 2.0 MB, 76 files

## Live evidence

- `npm run live:gemini-tools` against `gemini-3.5-flash-lite` dispatched `lookup_value` and then `finish`, with two signed thought blocks preserved across stateless Interactions continuation.
- Anthropic was intentionally not called live because the available credential has no billing credit; request and continuation wire shapes are covered by focused tests and recorded provider shapes.

## Upgrade notes from 0.3.3

- Package metadata moves to `0.3.4`.
- Existing custom `LLMClient` implementations remain source-compatible because the `tools` argument remains optional.
- Generic profile dispatch now provides native tool calling for Anthropic and Gemini as well as the existing OpenAI paths.
- Gemini profiles now use the Interactions API rather than legacy `generateContent`. Sampling profile fields that Interactions does not expose are rejected instead of silently ignored.
- OpenAI-compatible routes support native tools when the endpoint implements the standard Chat Completions function dialect; native Anthropic/Gemini or other proxy-specific translations remain out of scope.
