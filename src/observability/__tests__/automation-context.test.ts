import { describe, expect, it, vi } from 'vitest';
import * as tracing from '../index.js';

const env = { OPENHANDS_OBSERVABILITY_METADATA: '{"automation.id":"auto-1","automation.run_id":"run-1","allowed":[1,2],"nested":{"not":"metadata"},"null":null,"":false}', OPENHANDS_OBSERVABILITY_TAGS: 'automation, manual,automation', OPENHANDS_OBSERVABILITY_SPAN_NAME: 'automation.conversation', OPENHANDS_OBSERVABILITY_PARENT_SPAN_CONTEXT: 'parent-context' };

describe('generic automation propagation (upstream #5462)', () => {
  it('returns the process value unchanged without loading dotenv, including empty values', () => {
    expect(tracing.getEnv('EMPTY', { EMPTY: '' })).toBe('');
    expect(tracing.getEnv('MISSING', {})).toBeUndefined();
    expect(tracing.shouldEnableObservability({ LMNR_PROJECT_API_KEY: '' })).toBe(false);
  });
  it('cleans environment metadata and merges explicit metadata with precedence', () => {
    expect(tracing.mergeObservabilityMetadata({ 'automation.id': 'caller', extra: true }, env)).toEqual({ 'automation.id': 'caller', 'automation.run_id': 'run-1', allowed: [1, 2], extra: true });
    expect(tracing.observabilityMetadataFromEnv({ OPENHANDS_OBSERVABILITY_METADATA: '{broken' })).toEqual({});
    expect(tracing.observabilityMetadataFromEnv({ OPENHANDS_OBSERVABILITY_METADATA: '[1,2]' })).toEqual({});
  });
  it('constructs generic headers and permits injected OTel carrier propagation without losing data on injector failure', () => {
    expect(tracing.observabilityHeadersFromEnv(env, carrier => { carrier.traceparent = '00-test'; })).toEqual({
      'X-OpenHands-Observability-Metadata': '{"automation.id":"auto-1","automation.run_id":"run-1","allowed":[1,2]}',
      'X-OpenHands-Observability-Tags': 'automation,manual,automation',
      'X-OpenHands-Observability-Span-Name': 'automation.conversation',
      'X-OpenHands-Observability-Parent-Span-Context': 'parent-context', traceparent: '00-test',
    });
    expect(tracing.observabilityHeadersFromEnv({ LMNR_SPAN_CONTEXT: 'fallback' }, () => { throw new Error('broken injector'); })).toEqual({ 'X-OpenHands-Observability-Parent-Span-Context': 'fallback' });
  });
  it('ends a failing tracing backend only once and never surfaces exporter errors', () => {
    const end = vi.fn(() => { throw new Error('exporter unavailable'); });
    const root = tracing.startRootSpan('conversation', { env: { OTEL_ENDPOINT: 'fake' }, spanFactory: () => ({ end }) });
    expect(() => tracing.endRootSpan(root)).not.toThrow();
    tracing.endRootSpan(root);
    expect(end).toHaveBeenCalledTimes(1);
  });
  it('releases a span whose backend fails while setting attributes', () => {
    const end = vi.fn();
    const root = tracing.startRootSpan('conversation', { env: { OTEL_ENDPOINT: 'fake' }, attributes: { value: 1 },
      spanFactory: () => ({ end, setAttribute() { throw new Error('backend unavailable'); } }) });
    expect(root).toBeNull();
    expect(end).toHaveBeenCalledTimes(1);
  });

});
