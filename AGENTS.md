# OpenHands Agent Notes

- Work is tracked in Beads (`bd`). Check open Beads before starting follow-up work.
- The examples GitHub Environment now provides `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `ANTHROPIC_API_KEY` to `.github/workflows/examples.yml`.
- Use `createClientFromProfile(profile, store)` for generic LLM profile dispatch. It routes `providerId`/detected provider to Anthropic, Gemini, OpenAI Responses, or OpenAI-compatible chat. Product/REST callers should select `LLMProfile` records; use explicit provider factories such as `createOpenAIChatClientFromProfile` only for advanced SDK tests or provider-specific code.
- `Agent.step()` passes only usable `ToolDefinition` instances to `LLMClient.complete`; provider clients serialize native declarations and omit the request field when none are present. Anthropic uses `tool_use`/`tool_result`; Gemini uses stateless `/v1beta/interactions` step replay; OpenAI-compatible routes use the Chat Completions function dialect.
- `npm run live:openai-tools` proves real read/edit/finish dispatch with `gpt-5-nano`. `npm run live:gemini-tools` proves real `lookup_value`/finish dispatch and was verified with `gemini-3.5-flash-lite`. Anthropic tool tests use recorded shapes only because the key has no credit.
- Gemini signed thought round-trip now uses Interactions `thought` steps with lower-case `generation_config.thinking_level`; the previous GenerateContent `thinkingConfig` path is no longer used by `GeminiClient`.
