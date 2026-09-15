# Context files and deferred persistent memory

This note records the current boundary at the canonical pin in [upstream.json](upstream.json). Explicit full-content skills are supported. Upstream's opt-in persistent-memory subsystem remains **DEFERRED**, tracked by SmolPaws bead **`smolpaws-45n`**. This documentation correction changes neither the pin nor runtime behavior.

## Supported explicit context

[`AgentContext`](../src/context/agent-context.ts) renders a `Skill` with `trigger: null` and `isAgentskillsFormat: false` in `REPO_CONTEXT`, including its full body. There is no 32,768-character limit on that constructor path. For example, after a host reads its selected file:

```ts
const memorySkill = skillSchema.parse({
  name: 'durable-memory',
  content: fileContents,
  source: filePath,
  trigger: null,
  isAgentskillsFormat: false,
});
const context = new AgentContext({ skills: [memorySkill] });
const agent = new Agent({ llm, context });
```

This supplies content directly; a prompt telling the model to read a path supplies only an instruction and depends on a later tool call. An AgentSkills-format `SKILL.md` ordinarily advertises a description for progressive disclosure instead. See [skill rendering tests](../src/skills/__tests__/skills.test.ts) and [deny-list tests](../src/skills/__tests__/path-rules.test.ts).

SmolPaws owns which public identity documents and private memory files its server loads. That selection is product configuration using the SDK's existing `Skill` and `AgentContext` surface, not a new SDK file-discovery API. Private file contents must stay out of source control and fixtures. The server's launch-additions request is a separate deployment-context contract; restoring full-content skills needs no deviation from its upstream length limit.

## Deferred native memory

[Upstream PR #4178](https://github.com/OpenHands/software-agent-sdk/pull/4178), commit `ca3361b64ff24770a91af41fa438bc6c66f71137`, added `AgentContext.load_memory` (default `false`), runtime `memory_context`, and `context/memory.py`. At the canonical pin, the loader reads the user index under `OH_PERSISTENCE_DIR/memory/MEMORY.md` (default `~/.openhands/memory/MEMORY.md`) and the workspace index `.openhands/memory/MEMORY.md`. It includes user then project memory with a default **6,000-character combined budget**, divides available space between tiers, and drops whole lines from the top with a truncation notice when needed. Daily logs are read on demand, never automatically injected.

Python `LocalConversation` resolves memory before first agent initialization. `memory_context` is excluded from serialized agent configuration, while its rendered text enters the persisted `SystemPromptEvent`. Restoring an existing prompt event does not silently rewrite it from changed files. TypeScript currently renders the supplied in-memory context during each completion; it does not implement that automatic memory-loading and prompt-snapshot lifecycle. Host-provided skills alone do not establish initialization/restore parity.

[Upstream PR #4566](https://github.com/OpenHands/software-agent-sdk/pull/4566), commit `4a9db193a88af20251dd0e86b8ffd9318507e1d1`, propagates the saved user memory preference across agent-server launch paths. That server behavior depends on the missing SDK memory subsystem. It remains deferred in the server, with work owned by `smolpaws/smolpaws/packages/openhands-agent-server` under the same bead; this SDK note does not claim a server implementation.

The compatibility consequence is explicit: setting upstream `agent_context.load_memory` does not currently provide equivalent TypeScript memory discovery, bounded rendering, settings propagation, or restore behavior. Revisit this deferral when implementing bead `smolpaws-45n`, or when an upstream change touches these surfaces. Port the pinned loader, context-serialization, conversation-initialization and server launch-preference tests before claiming completion:

- `tests/sdk/context/test_memory.py`
- `tests/sdk/context/test_agent_context_serialization.py`
- `tests/sdk/conversation/test_local_conversation_memory.py`
- `tests/agent_server/test_agent_profile_conv_start.py`

## Correction to historical review

The frozen [56ac317..54dfbc5 review](updates/56ac317..54dfbc5.md) classified `ca3361b64ff24770a91af41fa438bc6c66f71137:sdk` as `NO_TARGET_CHANGE` because the memory feature was absent from TypeScript. Its claim of future tracking had no tracking item in the [JSON record](updates/56ac317..54dfbc5.json). That absence is an in-scope compatibility gap. This note supersedes that rationale with **DEFERRED**, the consequence and revisit trigger above, and bead `smolpaws-45n`; the historical files remain unchanged.

The [322dec7d..49ea7458 review](updates/322dec7d..49ea7458.md) lists the related `4a9db193a88a:server` unit as `NO_TARGET_CHANGE` while its SDK-side reason points to separate server ownership. That handoff does not establish server parity. Its memory-preference propagation is likewise outstanding, as recorded above.

No `DEV-*`, `EXC-*` or `EXT-*` policy is added: this is deferred implementation of an existing upstream contract. The manifest's policy registry covers those intentional differences and extensions; it is not a deferral registry. Future interval reviews must still inspect changes to memory, context, settings and server launch behavior rather than treating an absent implementation as an exemption.
