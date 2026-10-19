// Source-backed NO_TARGET_CHANGE evidence for 608a102c, 9f47d471, e2bac66b, 3385a486.
// These native request paths already preserved the changed upstream behavior.
import { expect, it } from 'vitest';
import { imageContent, llmProfileSchema, textContent } from '../index.js';
import { buildChatCompletionsBody } from '../openai.js';

it.each(['deepseek-v4.1-flash', 'openhands/deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.3'])(
  'keeps image parts for %s while text-only requests stay strings', model => {
    const profile = llmProfileSchema.parse({ profileId: 'vision', providerId: 'openai', model });
    const imageUrl = 'data:image/png;base64,abc123';
    const mixed = buildChatCompletionsBody(profile, [{ role: 'user', content: [textContent('What is in this image?'), imageContent([imageUrl])] }]);
    expect(mixed.messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'What is in this image?' }, { type: 'image_url', image_url: { url: imageUrl } },
    ] }]);
    expect(buildChatCompletionsBody(profile, [{ role: 'user', content: [textContent('Hello')] }]).messages)
      .toEqual([{ role: 'user', content: 'Hello' }]);
  },
);

it.each([
  'bedrock/openai.gpt-oss-120b-1:0', 'bedrock/us.openai.gpt-5.6-sol',
  'bedrock/us.openai.gpt-6-sol', 'bedrock/global.openai.gpt-6-luna', 'bedrock/us.openai.gpt-6-astra',
])('omits unsupported stop fields from the compatible request for %s', model => {
  // This proves the supported compatible wire path, not a native AWS transport.
  const profile = llmProfileSchema.parse({ profileId: 'stop', providerId: 'litellm_proxy', model });
  const body = buildChatCompletionsBody(profile, [{ role: 'user', content: [textContent('ping')] }]);
  expect(body).not.toHaveProperty('stop');
  expect(body).not.toHaveProperty('stopSequences');
});

for (const model of ['claude-haiku-5-5', 'claude-opus-5-5']) {
  for (const prefix of ['', 'anthropic/', 'litellm_proxy/anthropic/']) {
    it.each([true, false])(`preserves cache markers for ${prefix}${model}, enabled=%s without metadata`, cachingPrompt => {
      const profile = llmProfileSchema.parse({ profileId: 'cache', providerId: 'litellm_proxy', model: prefix + model, cachingPrompt });
      const body = buildChatCompletionsBody(profile, [
        { role: 'system', content: [textContent('Static instructions')] }, { role: 'user', content: [textContent('Hello')] },
      ]);
      const content = (body.messages as { content: string | { cache_control?: unknown }[] }[])[0]!.content;
      const markers = Array.isArray(content) ? content.filter(part => 'cache_control' in part).map(part => part.cache_control) : [];
      expect(markers).toEqual(cachingPrompt ? [{ type: 'ephemeral' }] : []);
    });
  }
}
