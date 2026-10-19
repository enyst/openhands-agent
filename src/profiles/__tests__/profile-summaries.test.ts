import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as publicSdk from '../../index.js';
import * as profiles from '../index.js';

// OpenHands db9c54b: tests/sdk/profiles/test_agent_profile.py summary regressions.
describe('public agent profile summaries', () => {
  it('keeps agent_kind a string in the public schema', () => {
    const schema = z.toJSONSchema(profiles.agentProfileInfoSchema);
    expect(schema.properties?.agent_kind).toMatchObject({ type: 'string', default: 'openhands' });
    expect(schema.properties?.agent_kind).not.toHaveProperty('enum');
  });

  it('accepts an ACP summary with a null LLM reference', () => {
    const summary = {
      id: '4a0672f0-85ae-42bd-8809-018776b80292',
      name: 'codex',
      agent_kind: 'acp',
      revision: 7,
      llm_profile_ref: null,
      mcp_server_refs: ['github'],
    };
    expect(profiles.agentProfileInfoSchema.parse(summary)).toEqual(summary);
  });

  it('validates lists of summaries with nullable defaults', () => {
    expect(profiles.agentProfileListResponseSchema.parse({
      profiles: [{ name: 'default', llm_profile_ref: 'default' }],
    })).toEqual({
      profiles: [{
        id: null, name: 'default', agent_kind: 'openhands', revision: null,
        llm_profile_ref: 'default', mcp_server_refs: null,
      }],
      active_agent_profile_id: null,
    });
  });

  it('does not instantiate or apply stored-profile restrictions to summaries', () => {
    expect(profiles.agentProfileInfoSchema.parse({
      id: 'opaque-id', name: '', agent_kind: 'future-agent', revision: -1,
    })).toEqual({
      id: 'opaque-id', name: '', agent_kind: 'future-agent', revision: -1,
      llm_profile_ref: null, mcp_server_refs: null,
    });
    expect(() => profiles.validateAgentProfile({ name: 'future', agent_kind: 'future-agent' })).toThrow();
  });

  it('projects known summary fields and keeps explicit empty selections', () => {
    expect(profiles.agentProfileListResponseSchema.parse({
      profiles: [{ name: 'selected', mcp_server_refs: [], extra: 'ignored' }],
      active_agent_profile_id: 'opaque-id', extra: 'ignored',
    })).toEqual({
      profiles: [{
        id: null, name: 'selected', agent_kind: 'openhands', revision: null,
        llm_profile_ref: null, mcp_server_refs: [],
      }],
      active_agent_profile_id: 'opaque-id',
    });
  });

  it('rejects missing required names and invalid summary field shapes', () => {
    for (const value of [{}, { name: null }, { name: 1 }, { name: 'x', agent_kind: null }, { name: 'x', mcp_server_refs: [1] }, { name: 'x', revision: 1.5 }]) {
      expect(profiles.agentProfileInfoSchema.safeParse(value).success).toBe(false);
    }
    for (const value of [{}, { profiles: null }, { profiles: [{}] }]) {
      expect(profiles.agentProfileListResponseSchema.safeParse(value).success).toBe(false);
    }
  });

  it('coerces only Python-compatible integral revision inputs', () => {
    const cases: Array<[unknown, number]> = [
      ['7', 7], [' 7 ', 7], ['7.0', 7], ['-1', -1], [true, 1], [false, 0],
      ['+7', 7], ['7_0', 70], ['1_000.00', 1000], ['01', 1], ['-000_2.0', -2],
      ['\u00857\u2003', 7], ['+01_0.00', 10], [-0, 0], ['-0.0', 0],
    ];
    for (const [revision, expected] of cases) {
      expect(profiles.agentProfileInfoSchema.parse({ name: 'x', revision }).revision).toBe(expected);
    }
    for (const revision of ['', ' ', '7.', '1.5', '1e2', '0x7', '7__0', '_7', '7_', '1.0_0', '1_.0', '+_7', '\ufeff7', '\u001c7', '٧', 'NaN', [], {}]) {
      expect(profiles.agentProfileInfoSchema.safeParse({ name: 'x', revision }).success).toBe(false);
    }
    expect(() => profiles.validateAgentProfile({ name: 'x', llm_profile_ref: 'main', revision: '7' })).toThrow();
  });

  it('does not coerce the other summary scalar fields', () => {
    for (const field of ['id', 'name', 'agent_kind', 'llm_profile_ref']) {
      for (const value of [1, true, false, [], {}]) {
        expect(profiles.agentProfileInfoSchema.safeParse({ name: 'x', [field]: value }).success).toBe(false);
      }
    }
    for (const value of [1, true, false, [], {}]) {
      expect(profiles.agentProfileListResponseSchema.safeParse({ profiles: [], active_agent_profile_id: value }).success).toBe(false);
    }
  });

  it('exports the same schemas through the public package root', () => {
    expect(publicSdk.agentProfileInfoSchema).toBe(profiles.agentProfileInfoSchema);
    expect(publicSdk.agentProfileListResponseSchema).toBe(profiles.agentProfileListResponseSchema);
    expect(publicSdk.agentProfileListResponseSchema.parse({ profiles: [] })).toEqual({
      profiles: [], active_agent_profile_id: null,
    });
  });
});
