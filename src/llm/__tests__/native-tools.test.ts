import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ToolDefinition } from '../../tool/index.js';
import { buildAnthropicMessagesBody } from '../anthropic.js';
import { buildGeminiInteractionsBody } from '../gemini.js';
import { llmProfileSchema, messageSchema, textContent } from '../index.js';
import { buildChatCompletionsBody, buildOpenAIResponsesBody } from '../openai.js';

const tool = new ToolDefinition({
  name: 'lookup_value',
  description: 'Look up a value by key.',
  inputSchema: z.object({ key: z.string() }).strict(),
});
const messages = [messageSchema.parse({ role: 'user', content: [textContent('Look it up.')] })];

const profiles = {
  chat: llmProfileSchema.parse({ profileId: 'chat', providerId: 'openai', model: 'gpt-4.1' }),
  responses: llmProfileSchema.parse({
    profileId: 'responses',
    providerId: 'openai',
    model: 'gpt-5-nano',
    openAiApiMode: 'responses',
  }),
  anthropic: llmProfileSchema.parse({ profileId: 'anthropic', providerId: 'anthropic', model: 'claude-sonnet-4-5' }),
  gemini: llmProfileSchema.parse({ profileId: 'gemini', providerId: 'gemini', model: 'gemini-3.5-flash-lite' }),
};

describe('cross-provider native tool serialization', () => {
  it('derives every provider declaration from the same ToolDefinition', () => {
    const chat = buildChatCompletionsBody(profiles.chat, messages, [tool]);
    const responses = buildOpenAIResponsesBody(profiles.responses, messages, [tool]);
    const anthropic = buildAnthropicMessagesBody(profiles.anthropic, messages, [tool]);
    const gemini = buildGeminiInteractionsBody(profiles.gemini, messages, [tool]);

    expect(chat.tools).toMatchObject([{ type: 'function', function: { name: tool.name } }]);
    expect(responses.tools).toMatchObject([{ type: 'function', name: tool.name }]);
    expect(anthropic.tools).toMatchObject([{ name: tool.name, input_schema: { type: 'object' } }]);
    expect(gemini.tools).toMatchObject([{ type: 'function', name: tool.name, parameters: { type: 'object' } }]);
  });

  it('omits provider tool fields when no definitions are supplied', () => {
    const bodies = [
      buildChatCompletionsBody(profiles.chat, messages),
      buildOpenAIResponsesBody(profiles.responses, messages),
      buildAnthropicMessagesBody(profiles.anthropic, messages),
      buildGeminiInteractionsBody(profiles.gemini, messages),
    ];

    for (const body of bodies) {
      expect(body).not.toHaveProperty('tools');
    }
  });
});
