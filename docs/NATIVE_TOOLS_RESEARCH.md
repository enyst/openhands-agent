# Native Tool Calling Research

Research for beads: `openhands-agent-tools-research`, `openhands-agent-tools-native`

## Summary

This document captures provider-native tool API shapes for Anthropic Messages, Gemini Interactions API, and OpenAI-compatible clients, along with proven data-shape choices from the old oh-tab implementation. The goal is to wire `ToolDefinition[]` through each provider's `complete()` method.

## Implementation outcome

The provider work is implemented in the current four-client architecture. Anthropic Messages uses native `tool_use`/`tool_result` blocks; Gemini uses `/v1beta/interactions` with typed steps and `store: false`; OpenRouter, LiteLLM-compatible endpoints, and custom gateways reuse the standard Chat Completions function dialect. Gemini intentionally uses stateless replay because the durable SDK event/message transcript—not mutable client-held `previous_interaction_id` state—must remain sufficient for conversation restore and forks.

Provider unit tests cover request declarations, empty-tool omission, response calls, parallel calls, signed thinking, and result continuation. `examples/native-tool-serialization.ts` is keyless; OpenAI and Gemini live agent examples are credential-gated. Anthropic was not called live because the available key has no credit.


## Provider API Shapes

### Anthropic Messages API

**Official docs**: https://docs.anthropic.com/en/docs/build-with-claude/tool-use

#### Request format

```typescript
{
  model: string;
  max_tokens: number;
  messages: Message[];
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: JSONSchema; // OpenAPI 3.0 schema
  }>;
  tool_choice?: { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string };
}
```

**Key points**:
- Tools are top-level array, not nested under `function`
- `input_schema` is the JSON Schema directly (no `parameters` wrapper)
- `tool_choice` defaults to `auto` when tools are provided
- `any` forces a tool call, `none` prohibits tool calls, `tool` forces a specific tool

#### Response format

Model returns `tool_use` content blocks:

```typescript
{
  role: 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string; signature?: string } // for extended thinking
    | { type: 'tool_use'; id: string; name: string; input: unknown } // parsed JSON args
  >;
  stop_reason: 'tool_use' | 'end_turn' | ...;
}
```

#### Tool result continuation

Send results back as `tool_result` content in a `user` message:

```typescript
{
  role: 'user';
  content: [{
    type: 'tool_result';
    tool_use_id: string;
    content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: ... }>;
    is_error?: boolean;
  }];
}
```

**Important**:
- Previous assistant message with `tool_use` blocks must be included in next turn
- Tool results go in `user` role messages (not `tool` role)
- Multiple tool results can be in a single user message
- `is_error: true` signals tool execution failure

#### oh-tab reference

File: `~/repos/oh-tab/packages/agent-sdk/src/sdk/llm/anthropic.ts`

```typescript
const toAnthropicTools = (tools?: LLMToolDefinition[]): Array<{
  name: string;
  description?: string;
  input_schema: unknown;
}> | undefined => {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
  }));
};
```

Message serialization:
- `tool` role messages → `user` role with `tool_result` content blocks
- `tool_use_id` comes from `message.tool_call_id`
- Assistant messages with `tool_calls` → `tool_use` content blocks
- `input` is parsed JSON from `toolCall.function.arguments`

### Gemini Interactions API

**IMPORTANT**: Use the **Interactions API**, not the legacy `generateContent` API.

**Official docs**:
- Overview: https://ai.google.dev/gemini-api/docs/interactions-overview
- Function calling: https://ai.google.dev/gemini-api/docs/function-calling
- API reference: https://ai.google.dev/api/interactions-api

#### Request format

**Endpoint**: `POST /v1beta/interactions`

```typescript
{
  model: string; // e.g. "gemini-3.6-flash"
  input: string | Array<InputStep>; // user prompt or conversation history
  tools?: Array<{
    type: 'function';
    name: string;
    description: string;
    parameters: JSONSchema; // JSON Schema for arguments
  }>;
  generation_config?: {
    tool_choice?: 'auto' | 'any' | 'none';
    temperature?: number;
    thinking_level?: string; // for thinking models
    // ... other generation params
  };
  system_instruction?: string | { parts: Array<{ text: string }> };
  previous_interaction_id?: string; // for stateful multi-turn
  store?: boolean; // default true
}
```

**Key differences from legacy generateContent**:
- Tools use `type: 'function'` at top level (not nested `functionDeclarations`)
- `parameters` is the schema directly (no extra wrapper)
- `tool_choice` is in `generation_config`, not `toolConfig.functionCallingConfig.mode`
- Returns `Interaction` resource with `steps` array
- Supports stateful conversations via `previous_interaction_id`

#### Response format

Returns an `Interaction` object with execution `steps`:

```typescript
{
  id: string;
  steps: Array<
    | { type: 'thought'; content: Array<{ type: 'text'; text: string }> } // thinking steps
    | { type: 'function_call'; id: string; name: string; arguments: Record<string, unknown> }
    | { type: 'model_output'; content: Array<{ type: 'text'; text: string }> }
  >;
  output_text?: string; // convenience field
}
```

**Important**:
- `function_call` steps have `id`, `name`, and `arguments` (already parsed JSON object, not string)
- Multiple `function_call` steps can appear (parallel calling)
- `thought` steps contain thinking/reasoning content
- `model_output` steps contain final text response

#### Tool result continuation

Send results back as `function_result` input:

```typescript
{
  model: string;
  input: [{
    type: 'function_result';
    name: string; // function name
    call_id: string; // from function_call step
    result: Array<{ type: 'text'; text: string }>; // serialized result
  }];
  tools: [...]; // must re-send tools
  previous_interaction_id: string; // link to previous interaction
}
```

**Stateful vs stateless**:
- **Stateful** (recommended): use `previous_interaction_id` to continue conversation, server manages history
- **Stateless**: set `store: false`, send full conversation history in `input` array

#### Thought signatures

Gemini 3.x models support `thoughtSignature` for verifiable thinking:
- SDK automatically includes signature in request if present in previous messages
- Signature appears in `thought` steps
- Already verified in this repo: `thinkingConfig.thinkingLevel` for Gemini 3.x

#### oh-tab reference (legacy generateContent, DO NOT port directly)

File: `~/repos/oh-tab/packages/agent-sdk/src/sdk/llm/gemini.ts`

The old implementation uses `generateContent` API:

```typescript
const toGeminiTools = (tools): GeminiGenerateContentRequest['tools'] | undefined => {
  if (!tools?.length) return undefined;
  const functionDeclarations = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: stripUnsupportedSchemaProps(tool.function.parameters),
  }));
  return [{ functionDeclarations }]; // legacy nested shape
};
```

**DO NOT USE THIS SHAPE**: The Interactions API uses a flat `tools` array with `type: 'function'`.

Response parsing (still relevant for understanding):
- Function calls appear as `functionCall` parts in content
- Arguments are objects, not strings
- Tool results use `functionResponse` parts with `name` and `response`

### OpenAI-compatible

Already implemented in PR #7 for native OpenAI clients. The question is how to handle proxies like OpenRouter, LiteLLM-compatible servers, etc.

#### Strategy

1. **Reuse OpenAI Chat Completions shape** for most OpenAI-compatible providers
2. **Gate by `providerId`** for known quirks (e.g., OpenRouter might have different behavior)
3. **Document unsupported cases** clearly
4. **Do NOT add LiteLLM dependency** - stick to the four-client architecture

#### Current OpenAI implementation reference

`OpenAIChatClient` already wraps `ToolDefinition.toResponsesTool()` in the nested function shape:

```typescript
function toOpenAIChatTool(tool: ToolDefinition): Record<string, unknown> {
  const responsesTool = tool.toResponsesTool();
  return {
    type: 'function',
    function: {
      name: responsesTool.name,
      description: responsesTool.description,
      parameters: responsesTool.parameters,
      strict: responsesTool.strict,
    },
  };
}
```

Tool calls in responses:

```typescript
{
  message: {
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string }; // JSON string
    }>;
  };
}
```

Tool results in continuation:

```typescript
{
  role: 'tool';
  tool_call_id: string;
  name?: string;
  content: string;
}
```

## Implementation Plan

### Phase 1: Anthropic native tools

**Bead**: `openhands-agent-tools-anthropic`

1. **Update `AnthropicMessagesClient.complete()` signature**
   - Add `tools?: readonly ToolDefinition[]` parameter
   - Keep parameter optional for backward compatibility

2. **Request serialization**
   - Create `toAnthropicTool(tool: ToolDefinition)` function:
     ```typescript
     {
       name: tool.name,
       description: tool.description,
       input_schema: tool.toResponsesTool().parameters, // JSON Schema
     }
     ```
   - Add tools array to request body when `tools.length > 0`
   - Omit `tools` field when array is empty (don't send `tools: []`)
   - Default `tool_choice: { type: 'auto' }` when tools are present

3. **Response parsing**
   - `parseAnthropicMessagesResponse()` already handles `tool_use` blocks in content
   - Extract `tool_use` blocks → `MessageToolCall[]`
   - Parse `input` field as JSON for `arguments` string
   - Use `id` from `tool_use` block

4. **Message continuation serialization**
   - `toAnthropicMessage()` already handles `message.tool_calls` → `tool_use` blocks (lines 128-130)
   - `toAnthropicMessage()` already handles `role: 'tool'` → `tool_result` blocks (lines 106-108, 143-150)
   - Verify `tool_use_id` mapping from `message.tool_call_id`
   - Verify `input` serialization from `toolCall.arguments` string

5. **Tests**
   - Unit test: request serialization with tools
   - Unit test: request serialization with empty tools array (should omit field)
   - Unit test: response parsing with `tool_use` blocks
   - Unit test: tool result continuation message serialization
   - Unit test: error handling (invalid tool arguments)
   - Integration test: full round-trip with mock fetch
   - **NO LIVE TEST** per user instructions (Anthropic key has no billing)

6. **Edge cases from oh-tab**
   - Tool arguments parsing: try JSON parse, fall back to raw if invalid
   - Empty/missing descriptions: handle gracefully
   - Tool choice: support `auto`, `any`, `none`, and specific tool selection

### Phase 2: Gemini Interactions API native tools

**Bead**: `openhands-agent-tools-gemini`

**IMPORTANT**: Migrate `GeminiClient` to the Interactions API, don't add tools to the old `generateContent` implementation.

1. **Update `GeminiClient` to use Interactions API**
   - Change endpoint from `/models/${model}:generateContent` to `/interactions`
   - Update request body structure to Interactions format
   - Update response parsing to handle `Interaction.steps[]`
   - Preserve `thoughtSignature` round-trip for Gemini 3.x

2. **Add `tools` parameter to `complete()`**
   - Add `tools?: readonly ToolDefinition[]` parameter

3. **Request serialization**
   - Convert `messages` → `input` (may need new format for Interactions API)
   - System messages → `system_instruction`
   - Create `toGeminiInteractionsTool(tool: ToolDefinition)`:
     ```typescript
     {
       type: 'function',
       name: tool.name,
       description: tool.description,
       parameters: tool.toResponsesTool().parameters,
     }
     ```
   - Add `generation_config.tool_choice: 'auto'` when tools are present
   - Preserve `thinkingConfig.thinkingLevel` for Gemini 3.x

4. **Response parsing**
   - Parse `steps` array for `function_call` steps
   - Extract `{ id, name, arguments }` from function_call steps
   - Note: `arguments` is already a parsed object, not a string
   - Convert to `MessageToolCall[]`
   - Collect `thought` steps → `reasoning_content`
   - Collect `model_output` steps → message content

5. **Continuation serialization**
   - Use `previous_interaction_id` for stateful conversations
   - Convert `tool` role messages → `function_result` input items:
     ```typescript
     {
       type: 'function_result',
       name: message.name ?? 'unknown_tool',
       call_id: message.tool_call_id ?? '',
       result: [{ type: 'text', text: contentToString(message.content).join('\n') }],
     }
     ```
   - Re-send tools in continuation request

6. **Tests**
   - Unit test: Interactions API request format with tools
   - Unit test: tool-less request format
   - Unit test: function_call step parsing
   - Unit test: thought step integration with tool calls
   - Unit test: function_result continuation format
   - Unit test: thoughtSignature preservation
   - Live test: use `GEMINI_API_KEY` with newest Flash model (per user preference)
   - Verify working Gemini models via Interactions API (user mentioned `gemini-3.6-flash`, `gemini-3.5-flash`)

7. **Edge cases**
   - Arguments already objects, not strings (no JSON parse needed)
   - Multiple parallel function calls in same response
   - Mixing thought steps and function calls
   - Stateless mode: manage full conversation history client-side

### Phase 3: OpenAI-compatible client tool propagation

**Bead**: `openhands-agent-tools-openai-compatible`

1. **Audit existing OpenAIChatClient tool support**
   - Already implemented in `buildChatCompletionsBody()` (lines 140-170)
   - Already handles `tools.map(toOpenAIChatTool)`
   - Already omits `tools` field when empty

2. **Provider-specific gating**
   - OpenRouter: verify compatibility, add tests
   - Custom `baseUrl` proxies: document that they must be OpenAI-compatible
   - Add provider quirks if needed in `provider-quirks.ts`

3. **Tests**
   - Verify existing OpenAI Chat tests pass
   - Add OpenRouter-specific test cases if needed
   - Document unsupported providers in comments/docs

4. **Documentation**
   - Update README with OpenAI-compatible tool calling notes
   - Document known-working proxies (OpenRouter, etc.)
   - Document limitations for non-standard proxies

### Phase 4: Cross-provider validation

**Bead**: `openhands-agent-tools-validation`

1. **Integration tests**
   - Add cross-provider tool calling test suite
   - Verify all providers handle same `ToolDefinition` correctly
   - Test parallel tool calls (Anthropic, Gemini support this)
   - Test error cases (invalid arguments, missing tools, etc.)

2. **Live examples**
   - Update `examples/native-openai-tools.ts` to cover OpenAI Responses (already exists)
   - Add `examples/native-anthropic-tools.ts` (credential-gated)
   - Add `examples/native-gemini-tools.ts` (use live key)
   - Add `examples/cross-provider-tools.ts` showing profile switching

3. **Documentation**
   - Update `docs/ARCHITECTURE.md` with tool calling details
   - Add `docs/TOOL_CALLING.md` guide
   - Document tool choice modes per provider
   - Document parallel tool use support
   - Update README with tool calling overview

4. **CI adjustments**
   - Keep Anthropic live tests credential-gated (skip if no key)
   - Add Gemini live test (key exists per user)
   - Normal CI must not require live provider keys (use mocked tests)

## Key Architectural Decisions

1. **Tool definition source**: `ToolDefinition.toResponsesTool()` is the canonical schema source
   - All providers derive from this method
   - No parallel tool DTO layer
   - Provider clients own wire-format wrapping

2. **Optional tools parameter**: Keep `tools` parameter optional in all `complete()` signatures
   - Backward compatible with existing non-tool usage
   - Omit wire-level field when empty, don't send `tools: []`

3. **No LiteLLM dependency**: Stick to the four-client architecture
   - OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini (Interactions)
   - OpenRouter and compatible proxies use OpenAI Chat shape
   - Document unsupported providers clearly

4. **Preserve existing behaviors**:
   - Anthropic extended thinking round-trip
   - Gemini `thoughtSignature` for Gemini 3.x
   - OpenAI Responses reasoning content
   - All existing tests must continue to pass

5. **Gemini migration priority**: Move Gemini to Interactions API during tool work
   - The old `generateContent` API is legacy
   - Interactions is GA and recommended by Google
   - Combine migration with tool implementation
   - Preserve backward compatibility where possible

## Provider Comparison Table

| Feature | Anthropic | Gemini Interactions | OpenAI Chat |
|---------|-----------|---------------------|-------------|
| Tool definition shape | `{ name, description, input_schema }` | `{ type: 'function', name, description, parameters }` | `{ type: 'function', function: { name, description, parameters, strict } }` |
| Response tool call | `tool_use` content block | `function_call` step | `tool_calls[]` in message |
| Tool call ID | `id` in tool_use | `id` in function_call | `id` in tool_call |
| Arguments format | Parsed object (`input`) | Parsed object (`arguments`) | JSON string (`arguments`) |
| Tool result role | `user` with `tool_result` | `function_result` input item | `tool` role message |
| Tool result ID field | `tool_use_id` | `call_id` | `tool_call_id` |
| Parallel calls | Yes | Yes | Yes |
| Tool choice modes | `auto`, `any`, `none`, `{ type: 'tool', name }` | `auto`, `any`, `none` (in generation_config) | `auto`, `none`, `{ type: 'function', function: { name } }` |
| Thinking integration | Extended thinking blocks | Thought steps + signatures | Reasoning in Responses API |

## Testing Strategy

1. **Unit tests** (all providers):
   - Request serialization with tools
   - Request serialization without tools (omit field)
   - Response parsing with tool calls
   - Tool result continuation format
   - Error handling

2. **Integration tests** (mocked fetch):
   - Full round-trip: request → tool call → result → final response
   - Parallel tool calls
   - Thinking/reasoning + tool calls

3. **Live tests** (credential-gated):
   - Anthropic: **skip** (no billing, per user instructions)
   - Gemini: **include** (key works, use newest Flash)
   - OpenAI: already covered

4. **Example scripts**:
   - One per provider
   - Cross-provider comparison example
   - All examples skip gracefully if key missing

## References

- Anthropic Tool Use: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- Gemini Interactions API: https://ai.google.dev/gemini-api/docs/interactions-overview
- Gemini Function Calling: https://ai.google.dev/gemini-api/docs/function-calling
- Gemini API Reference: https://ai.google.dev/api/interactions-api
- Gemini Migration Guide: https://ai.google.dev/gemini-api/docs/migrate-to-interactions
- oh-tab reference: `~/repos/oh-tab/packages/agent-sdk/src/sdk/llm/{anthropic,gemini}.ts`
- OpenAI tools already merged: PR #7

## Next Steps

1. Mark research bead (`openhands-agent-tools-research`) as done
2. Start with `openhands-agent-tools-anthropic`
3. Continue with `openhands-agent-tools-gemini` (includes Interactions migration)
4. Quick pass on `openhands-agent-tools-openai-compatible` (mostly docs)
5. Finish with `openhands-agent-tools-validation` (tests, examples, docs)

Update bead statuses and commit `.beads/issues.jsonl` after each phase.
