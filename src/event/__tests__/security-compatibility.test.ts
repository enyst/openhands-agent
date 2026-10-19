import { expect, it } from 'vitest';
import { eventSchema, llmConvertibleEventSchema } from '../index.js';
import { EventLog } from '../../conversation/event-log.js';
import { InMemoryFileStore } from '../../io/index.js';

it('preserves imported security verdicts as metadata without making them LLM input', () => {
  const wire = { kind: 'SecurityAnalysisEvent', id: '00000000-0000-4000-8000-000000000001', timestamp: '2026-10-01T12:00:00Z', source: 'environment', parent_id: null,
    analyzer: 'test', policy: 'NeverConfirm', risks: { action: 'HIGH' }, details: { action: { confidence: 0.9, rationale: 'fixture' } } };
  const event = eventSchema.parse(wire);
  expect(event).toEqual(wire); expect(llmConvertibleEventSchema.safeParse(event).success).toBe(false);
  const store = new InMemoryFileStore(); const log = new EventLog(store, 'events');
  log.append(event);
  const restored = new EventLog(store, 'events');
  expect([...restored]).toEqual([event]);
});
