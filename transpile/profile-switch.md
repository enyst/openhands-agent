# Saved-profile switching evidence

This bounded port uses the current manifest pin, `50080b58d35b4824fda25fca2345d80bcd08aeff`, without advancing it. The builtin is **PORT**, adapted to the existing profile-first host boundary under DEV-SDK-004. The host step-boundary callback is the separately named EXT-SDK-003.

## Pinned sources and tests

- `openhands-sdk/openhands/sdk/tool/builtins/switch_llm.py`: saved profile names, action fields `profile_name`/`reason`, optional builtin, structured observation and error behavior.
- `openhands-sdk/openhands/sdk/settings/model.py`: `enable_switch_llm_tool` defaults true and controls optional tool inclusion even with an empty profile store.
- `tests/sdk/tool/test_switch_llm.py`: sorted names, successful model/reason, missing profile, unexpected resolver failure, enabled/disabled and empty-store behavior.
- `tests/sdk/conversation/test_switch_model.py`: next-call switching, custom profile storage, state agreement, profile changes, and switch plus finish in a single response without deadlock (#3485).
- `tests/agent_server/test_switch_llm_survives_reload.py`: host persistence evidence to be adapted in the separately maintained server package.

## Target boundary

`SwitchLLMTool.create({ profileNames, switchProfile })` accepts names and a runtime callback. Its action uses the existing TypeScript tool-input convention without Python's internal action discriminator. Its observation preserves the Python `kind`, `content`, `is_error`, `profile_name`, `reason`, and `active_model` fields. Both empty stores and absent runtime bindings have explicit descriptions/errors. Saved names are descriptive, not a hard-coded model enum.

The callback returns the selected model only after resolving and accepting the profile. Hosts may durably queue selection until `LocalConversation.onStepBoundary` after all tools in the current response have completed. Success therefore says the profile is accepted for the next LLM call. The host must preserve the old working binding on failed preparation, persist activation before returning a replacement agent, and restore accepted pending selections after restart. The SDK does not provide a singleton profile store or the Python mutable `LLMRegistry`; per-completion native accounting remains DEV-SDK-007. It does not inherit Python's first-write-wins `usage_id` client cache, which can silently discard a replacement model (SmolPaws `smolpaws-5wr`).

No condenser, title, oracle, or ask-agent model is implicitly changed. Native LLM condenser/ask-agent ports are not completed by this work. Settings-to-agent wiring and durable profile restoration are verified by the host package, because the SDK settings schemas alone do not construct an agent.

## Superseded historical interpretation

The frozen `d1595f72c..2eff609f` review classified `5f208d65f8d932ed8b699ddff6df12492d6c84f3:sdk` as `NO_TARGET_CHANGE` because TypeScript lacked the ask-agent registry-refresh path, noting only an `enable_switch_llm_tool` flag. That historical note did not establish that switching was implemented or excluded. At this pin the actual builtin and switching integration were missing, an in-scope gap. This port supplies the builtin and host integration seam; ask-agent refresh remains unimplemented. Frozen interval files are unchanged.

## Deterministic evidence

`src/tool/__tests__/switch-llm.test.ts` adapts the pinned tool tests. `src/conversation/__tests__/step-boundary.test.ts` verifies initial selection, durable parallel-tool completion, coalesced concurrent runs, same-response switch/finish, preserved run budget/state, non-running no-ops, and rejection propagation. Initial execution before implementation produced **10 expected failures and one existing-behavior pass**: no exported switch tool/resolver or boundary hook existed. A subsequent concurrency regression failed because a second `run()` invoked the boundary while two tool actions were still pending; coalescing active runs makes that test pass.

The adjacent queue-coordination regression verifies that `lastStepUserMessageId` includes arrivals during asynchronous preparation but excludes input queued after the final step. The marker is sampled synchronously before `Agent.step`; it is a target host-coordination feature, not part of the upstream switch source. Terminal status is visible before final-step preparation, including finish-tool responses.

The hook snapshots legacy history origin before host activation. Cross-profile opaque-history filtering is covered separately by the 14 tests in `src/agent/__tests__/profile-history.test.ts`, including native Anthropic/Gemini/OpenAI serialization, restoration, switch-back, reused response IDs, and known/unknown legacy origins. Pinned Python `llm.py` only explicitly strips Responses reasoning on the subscription path; DEV-SDK-008 records the broader target projection rather than claiming parity. The digest excludes secrets, headers, URL userinfo, and query values; same-profile edits limited to those excluded values are outside its detectable identity. Historical events and accounting records are never rewritten.

Final local SDK evidence: **568 tests passed, one existing remote-workspace integration skip**; seven drift-tool tests, SDK/drift/example typechecks, lint, bundle/declaration build, and deterministic examples passed. Socket-using test fixtures and the `tsx` example runner require local socket permission; a sandbox-only run reported those permission failures before the successful unrestricted-local test run. No live model call is claimed by this SDK evidence.
