import { describe, expect, it } from 'vitest';
import { automationConversationOptions, automationConversationTags, automationObservabilityContext, automationObservabilityHeaders } from '../index.js';
const env = { OPENHANDS_OBSERVABILITY_METADATA: '{"automation.id":"auto-1","automation.run_id":"run-1"}', OPENHANDS_OBSERVABILITY_TAGS: 'automation, manual', OPENHANDS_OBSERVABILITY_SPAN_NAME: 'automation.conversation', OPENHANDS_OBSERVABILITY_PARENT_SPAN_CONTEXT: 'parent-context' };
describe('automation SDK helpers (source test_automation_observability.py)', () => {
  it('collects generic env and explicit metadata/tags with stable deduplication', () => {
    expect(automationObservabilityContext({ env, metadata: { 'automation.subject.key': 'repo#123' }, tags: ['manual', ' candidate ', ''] })).toEqual({
      observabilityMetadata: { 'automation.id': 'auto-1', 'automation.run_id': 'run-1', 'automation.subject.key': 'repo#123' },
      observabilityTags: ['automation', 'manual', 'candidate'], observabilitySpanName: 'automation.conversation', observabilityParentSpanContext: 'parent-context',
    });
  });
  it('derives product tags from scalar automation metadata and ignores booleans/arrays', () => {
    expect(automationConversationTags({ 'automation.name': 'Trace me', 'automation.trigger_source': 'cron' }, env)).toEqual({ automationtrigger: 'automation', automationid: 'auto-1', automationname: 'Trace me', automationrunid: 'run-1' });
    expect(automationConversationTags({ 'automation.id': false, 'automation.name': ['not a name'], 'automation.run_id': 0 }, {})).toEqual({ automationtrigger: 'automation', automationrunid: '0' });
  });
  it('combines product and observability tags, allowing explicit product overrides', () => {
    expect(automationConversationOptions({ env, observabilityTags: ['polling'], conversationTags: { automationid: 'override', custom: 'tag' } })).toMatchObject({
      tags: { automationtrigger: 'automation', automationid: 'override', automationrunid: 'run-1', custom: 'tag' }, observabilityTags: ['automation', 'manual', 'polling'], observabilitySpanName: 'automation.conversation',
    });
    expect(automationConversationOptions({ env, includeConversationTags: false })).not.toHaveProperty('tags');
  });
  it('uses default or env span, with explicit span taking precedence', () => {
    expect(automationConversationOptions({ env: {} })).toEqual({ observabilitySpanName: 'automation.conversation' });
    expect(automationConversationOptions({ env: { OPENHANDS_OBSERVABILITY_SPAN_NAME: 'env.span' } }).observabilitySpanName).toBe('env.span');
    expect(automationConversationOptions({ env, spanName: 'caller.span' }).observabilitySpanName).toBe('caller.span');
  });
  it('returns direct API headers with compact metadata and injected trace carrier', () => {
    expect(automationObservabilityHeaders({ env, tags: ['candidate'], injectHeaders: headers => { headers.traceparent = 'trace'; } })).toEqual({
      'X-OpenHands-Observability-Metadata': '{"automation.id":"auto-1","automation.run_id":"run-1"}', 'X-OpenHands-Observability-Tags': 'automation,manual,candidate',
      'X-OpenHands-Observability-Span-Name': 'automation.conversation', 'X-OpenHands-Observability-Parent-Span-Context': 'parent-context', traceparent: 'trace',
    });
  });
});
