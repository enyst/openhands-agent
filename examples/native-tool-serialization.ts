import {
  ToolDefinition,
  buildAnthropicMessagesBody,
  buildChatCompletionsBody,
  buildGeminiInteractionsBody,
  buildOpenAIResponsesBody,
  llmProfileSchema,
  messageSchema,
  textContent,
} from '@smolpaws/openhands-agent';
import { z } from 'zod';

const tool = new ToolDefinition({
  name: 'lookup_value',
  description: 'Look up a value by key.',
  inputSchema: z.object({ key: z.string() }).strict(),
});
const messages = [messageSchema.parse({ role: 'user', content: [textContent('Look up verification.')] })];

const requests = {
  openaiChat: buildChatCompletionsBody(
    llmProfileSchema.parse({ profileId: 'chat', providerId: 'openai', model: 'gpt-4.1' }),
    messages,
    [tool],
  ),
  openaiResponses: buildOpenAIResponsesBody(
    llmProfileSchema.parse({
      profileId: 'responses',
      providerId: 'openai',
      model: 'gpt-5-nano',
      openAiApiMode: 'responses',
    }),
    messages,
    [tool],
  ),
  anthropic: buildAnthropicMessagesBody(
    llmProfileSchema.parse({ profileId: 'anthropic', providerId: 'anthropic', model: 'claude-sonnet-4-5' }),
    messages,
    [tool],
  ),
  gemini: buildGeminiInteractionsBody(
    llmProfileSchema.parse({ profileId: 'gemini', providerId: 'gemini', model: 'gemini-3.5-flash-lite' }),
    messages,
    [tool],
  ),
};

console.log(JSON.stringify(
  Object.fromEntries(Object.entries(requests).map(([provider, request]) => [provider, request.tools])),
  null,
  2,
));
