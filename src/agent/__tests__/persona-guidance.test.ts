import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '../agent.js';
import { AgentContext } from '../../context/agent-context.js';
import { ToolDefinition } from '../../tool/index.js';
import { llmProfileSchema } from '../../llm/index.js';
import { renderStaticSystemPrompt } from '../../context/persona.js';
const llm = { profile: llmProfileSchema.parse({ profileId: 'test', providerId: 'anthropic', model: 'claude-sonnet-4-5' }), complete: async () => { throw new Error('No calls expected'); } };
const tool = (name: string, promptGuidance?: string) => new ToolDefinition({ name, description: name, inputSchema: z.object({}), ...(promptGuidance === undefined ? {} : { promptGuidance }) });

describe('persona and loaded-tool guidance (upstream 048c9be7 / bec71283)', () => {
  it('replaces persona sections, keeps capability sections, and leaves dynamic context untouched', () => {
    const context = new AgentContext({ systemMessageSuffix: 'Cite file paths.', currentDatetime: null });
    const plain = new Agent({ llm, context });
    const custom = new Agent({ llm, context, persona: 'You are a ramen chef.' });
    expect(plain.staticSystemMessage).toContain('<SOUL>');
    expect(custom.staticSystemMessage.startsWith('You are a ramen chef.')).toBe(true);
    for (const tag of ['SOUL', 'ROLE', 'EFFICIENCY', 'FILE_SYSTEM_GUIDELINES', 'CODE_QUALITY', 'VERSION_CONTROL', 'PULL_REQUESTS', 'PROBLEM_SOLVING_WORKFLOW', 'SELF_DOCUMENTATION', 'ENVIRONMENT_SETUP', 'TROUBLESHOOTING']) {
      expect(custom.staticSystemMessage).not.toContain(`<${tag}>`);
    }
    for (const tag of ['MEMORY', 'SECURITY', 'EXTERNAL_SERVICES', 'PROCESS_MANAGEMENT', 'IMPORTANT']) expect(custom.staticSystemMessage).toContain(`<${tag}>`);
    expect(custom.dynamicContext).toBe(plain.dynamicContext);
    expect(custom.dynamicContext).toContain('Cite file paths.');
    expect(custom.staticSystemMessage).not.toContain('SECURITY_RISK_ASSESSMENT');
  });
  it.each([' ', '\n', ' \t\n'])('ignores whitespace-only persona %j', persona => {
    expect(new Agent({ llm, persona }).staticSystemMessage).toBe(new Agent({ llm }).staticSystemMessage);
  });
  it('uses explicit inline prompt and appends exact unique guidance in loaded order', () => {
    const tools = [tool('a', 'GUIDANCE_ONE'), tool('b', 'GUIDANCE_TWO'), tool('c', 'GUIDANCE_ONE')];
    expect(new Agent({ llm, systemPrompt: 'Verbatim.', persona: 'Ignored', tools }).staticSystemMessage).toBe('Verbatim.\n\nGUIDANCE_ONE\n\nGUIDANCE_TWO');
    expect(new Agent({ llm, systemPrompt: 'Verbatim.', tools: [] }).staticSystemMessage).toBe('Verbatim.');
    const defaultPrompt = new Agent({ llm, tools }).staticSystemMessage;
    expect(defaultPrompt.indexOf('GUIDANCE_ONE\n\nGUIDANCE_TWO')).toBeLessThan(defaultPrompt.indexOf('<EXTERNAL_SERVICES>'));
    expect(defaultPrompt.match(/GUIDANCE_ONE/gu)).toHaveLength(1);
    expect(JSON.stringify(tools[0])).not.toContain('GUIDANCE_ONE');
    expect(tools[0]?.toMcpTool()).not.toHaveProperty('promptGuidance');
  });
  it('keeps planning instructions after the persona', () => {
    const prompt = renderStaticSystemPrompt({ persona: 'My planner.', preset: 'planning', planStructure: '1. GOAL' });
    expect(prompt.startsWith('My planner.')).toBe(true);
    expect(prompt).toContain('1. GOAL');
    expect(prompt).not.toContain('<MEMORY>');
  });
});
