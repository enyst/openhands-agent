# Input arriving during an LLM response

Classification: **DEVIATION / DEV-SDK-009**, at the unchanged pin in `upstream.json`.

The September 17 SmolPaws failure is a different boundary from a user message interrupting a
completed tool exchange. Request A was already in flight when input B arrived. The durable log
correctly recorded `A, B, reply(A)`. The server correctly requested another completion for B, but
chronological conversion merged A and B and ended with an assistant reply. Anthropic rejected that
request as unsupported assistant prefill. Suppressing the follow-up would leave B unanswered.

`src/llm/request-history.ts` supplies the missing evidence. The Agent captures a watermark with its
request snapshot, then persists a versioned `llm_request_boundary` metadata event with the explicit
locally assigned response event IDs. The marker precedes the response in the append batch. EventLog
serializes the batch against concurrent appends, but individual disk writes are not transactional;
an orphan or incomplete marker cannot establish a response boundary. Usage accounting remains
separate, and absent or reused provider response IDs do not determine ordering.

For later requests, retained genuine user arrivals after the watermark and before the response are
projected after that response: `A, reply(A), B`. This happens after condensation using full-history
indices. It does not restore dropped events, reposition synthetic summaries, rewrite stored history,
duplicate input, insert a fake continuation, or re-execute a tool. Profile-origin projection retains
its existing evidence; completed tool-result adjacency remains owned by
[`tool-result-order.ts`](../src/llm/tool-result-order.ts).

The public event schemas and `eventsToMessages` conversion are unchanged. Provenance uses the
existing state-update envelope and survives disk restore. The server continues to own scheduling
the next run; bridge-specific or model-specific suppression is not a remedy.
Steps sharing one conversation state must be serialized, as `LocalConversation` and the server
already do. Overlapping direct `Agent.step` calls on one state are outside this ordering contract.

## Upstream comparison

At Python commit `50080b58d35b4824fda25fca2345d80bcd08aeff`,
`conversation/impl/local_conversation.py::arun` checks for user arrivals after `astep`, and
`agent/agent.py` releases the state lock during LLM I/O. Ordinary response emission appends the
response and `event/base.py::events_to_messages` follows the selected view. Source inspection did
not establish an equivalent durable watermark and plain-response projection. This is deliberate
target behavior; no live Python differential result is claimed. Future source changes to those
surfaces and `context/condenser` must be reviewed against DEV-SDK-009.

## Evidence and rollout limits

`src/agent/__tests__/concurrent-history.test.ts` exercises request and append timing, restored
history, multimodal input and tool continuation. Projection tests cover the pure transformation.
Server regressions exercise REST append, idempotency, follow-up execution, profile switching and
restart. The original regression fails with a request ending in `assistant`; it must finish with
the unseen user's input while preserving the original durable prefix.

Unannotated historical turns remain in their recorded order. The fix prevents future occurrences
and can replay newly recorded boundaries after restart; it cannot infer whether an old reply saw an
earlier-arriving message. A real subsequent user message can resume such a conversation. Deployment
does not automatically run conversations, rewrite old events or manufacture historical provenance.
