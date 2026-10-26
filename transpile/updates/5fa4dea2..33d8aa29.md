# OpenHands upstream drift

- **Repository:** `OpenHands/software-agent-sdk`
- **Pinned:** `5fa4dea24c52fe3ac53fa4e3e67a1376b72189e2` (2026-10-15T21:58:41-04:00)
- **Candidate:** `33d8aa29c3078d074799e2fbf5e847aeb2d71360` (2026-10-19T09:32:16-04:00)
- **Commits:** 61 total; 61 first-parent review units

## Scope summary

| Target | Commit units | Files | Tests | Examples | Modules | Policy hints |
|---|---:|---:|---:|---:|---|---|
| sdk | 17 | 63 | 33 | 0 | `agent`, `child_conversation`, `conversation`, `dependencies`, `git`, `launch`, `llm`, `marketplace`, `persisted_settings_baselines`, `profiles`, `pyproject`, `settings`, `skills`, `terminal`, `test-infrastructure`, `test_apply_agent_settings_diff`, `test_settings`, `tool`, `utils`, `workspace` | `DEV-SDK-004`, `DEV-SDK-006`, `DEV-SDK-008`, `DEV-SDK-009`, `DEV-SDK-010`, `DEV-SDK-011`, `DEV-SDK-012`, `EXC-SDK-002` |
| server | 43 | 105 | 53 | 0 | `agent_profiles`, `api`, `bash`, `canvas_extensions`, `config`, `conftest`, `conversation`, `dependencies`, `docker_runtime`, `env_parser`, `event`, `file`, `init`, `mcp`, `models`, `openai`, `persistence`, `profiles`, `pyproject`, `settings`, `telemetry`, `test-infrastructure`, `test_agent_profiles`, `test_agent_secrets_integration`, `test_api`, `test_auto_title_span_metadata`, `test_bash`, `test_check_persisted_settings_compat`, `test_config`, `test_conversation`, `test_conversation_response`, `test_event`, `test_event_loss_repro`, `test_file`, `test_goal_loop`, `test_init`, `test_mcp`, `test_openai_gateway_reused_wait`, `test_openapi_discriminator`, `test_parent_child_conversations`, `test_profiles`, `test_remote_conversation_live_server`, `test_run_admission`, `test_runtime`, `test_settings`, `test_skills`, `test_switch_llm_survives_reload`, `test_unhandled_exception_error_id`, `test_vscode`, `test_webhook_subscriber`, `test_workspaces`, `tool`, `vscode` | `DEV-SERVER-004`, `DEV-SERVER-005`, `DEV-SERVER-007`, `DEV-SERVER-008`, `DEV-SERVER-009`, `DEV-SERVER-010` |

## First-parent changes

| Commit | Date | Subject | Target | Modules | Files | Disposition |
|---|---|---|---|---|---:|---|
| `12e967664c23` | 2026-10-16 | ci: defer PR artifact cleanup until after merge (#5998) | — | — | 0 | ignored/unmapped |
| `6530325e9dd0` | 2026-10-16 | fix(marketplace): load skills from registered repositories without a manifest (#6009) | sdk | `conversation`, `marketplace` | 4 | NO_TARGET_CHANGE |
| `6530325e9dd0` | 2026-10-16 | fix(marketplace): load skills from registered repositories without a manifest (#6009) | server | `test_skills` | 1 | DELEGATED |
| `4a5f5a09096a` | 2026-10-17 | fix(agent-server): reserve the run slot before a gateway turn saves its message (#5955) | server | `event`, `openai`, `test_run_admission` | 3 | DELEGATED |
| `304ea67a7993` | 2026-10-17 | fix(agent-server): apply bash order__gt filter before paging (#5842) | server | `bash`, `test_bash` | 2 | DELEGATED |
| `60c6f62133e0` | 2026-10-17 | fix(agent-server): log failed runs without rendering a rich traceback on the loop (#5780) | server | `event`, `test_event` | 2 | DELEGATED |
| `a6c7bf5591f6` | 2026-10-17 | fix(sdk): install the posted LLM when switch_llm targets a registered usage_id (#5779) | sdk | `conversation` | 2 | NO_TARGET_CHANGE |
| `a6c7bf5591f6` | 2026-10-17 | fix(sdk): install the posted LLM when switch_llm targets a registered usage_id (#5779) | server | `test_switch_llm_survives_reload` | 1 | DELEGATED |
| `8ba8ccbeb1a5` | 2026-10-17 | fix(agent-server): mark a goal loop left active at restart as interrupted (#5772) | server | `event`, `test_goal_loop` | 2 | DELEGATED |
| `c87fddb623f0` | 2026-10-17 | fix(typescript): use the global WebSocket in the callback socket clients (#5769) | — | — | 0 | ignored/unmapped |
| `76055f697a5e` | 2026-10-17 | fix(agent-server): bound profile pre-flight and reject exhausted quotas (#5768) | server | `profiles`, `test_profiles` | 2 | DELEGATED |
| `c73ec79e3fd1` | 2026-10-17 | fix(agent-server): return the whole output from execute_bash_command (#5778) | server | `bash`, `test_bash` | 2 | DELEGATED |
| `bf9b6057b00e` | 2026-10-16 | test: guard Linux-only Canvas backend cases on macOS (#6036) | server | `canvas_extensions` | 1 | DELEGATED |
| `6235a41b5b84` | 2026-10-17 | fix(agent-server): let OH_*_IS_NONE=1 clear a config file value (#5951) | server | `config`, `env_parser`, `test_config` | 3 | DELEGATED |
| `8869bcd914af` | 2026-10-17 | fix(agent-server): answer 422 for a malformed id on scoped bash routes (#5840) | server | `dependencies`, `test_runtime` | 2 | DELEGATED |
| `cab7bb4b2947` | 2026-10-17 | fix(sdk): reject skill installs with unparsable frontmatter as invalid (#5901) | sdk | `skills` | 2 | DEFERRED |
| `acf55bcd2672` | 2026-10-17 | fix(sdk): drop Bedrock-only ids from the supported model list (#5885) | sdk | `llm` | 2 | DEFERRED |
| `3adf42f6377b` | 2026-10-17 | fix(sdk): expand ~ in OH_PERSISTENCE_DIR for the meta-profile store (#5884) | sdk | `llm` | 2 | PORT |
| `e5a1602e3bbc` | 2026-10-17 | fix(agent-server): reject MCP OAuth callback URLs with a bad port as 400 (#5867) | server | `mcp`, `test_mcp` | 2 | DELEGATED |
| `7abcd3bab78f` | 2026-10-17 | fix(agent-server): drop upstream Date and Server from proxied responses (#5916) | server | `docker_runtime` | 2 | DELEGATED |
| `079d410db4fe` | 2026-10-17 | fix(agent-server): read agent_final_response from the active branch (#5826) | server | `event`, `test_conversation_response` | 2 | DELEGATED |
| `9ad70fedddc4` | 2026-10-17 | docs(typescript): describe the pre-run 200-and-defer switchAcpModel behaviour (#5812) | — | — | 0 | ignored/unmapped |
| `f676088d7a46` | 2026-10-17 | fix(agent-server): reject a whitespace-only conversation title on PATCH (#5802) | server | `models`, `test_conversation` | 2 | DELEGATED |
| `478a6f9caebc` | 2026-10-17 | fix(agent-server): skip the workspaces save when a write changes nothing (#5864) | server | `persistence`, `test_workspaces` | 2 | DELEGATED |
| `07e6e059afd8` | 2026-10-17 | fix(agent-server): document 422 for an invalid secret name (#5851) | server | `settings`, `test_settings` | 2 | DELEGATED |
| `fd96074269ce` | 2026-10-17 | fix(agent-server): describe the real materialize report in the seed docstring (#5874) | server | `agent_profiles`, `test_agent_profiles` | 2 | DELEGATED |
| `8d2c996de5bf` | 2026-10-17 | fix(sdk): keep streamed deltas out of RemoteConversation.state.events (#5966) | sdk | `conversation` | 2 | NO_TARGET_CHANGE |
| `57c71706e83c` | 2026-10-17 | fix(agent-server): refuse a non-gzip canvas backend artifact with 409 (#5917) | server | `canvas_extensions` | 2 | DELEGATED |
| `1396fa7ff651` | 2026-10-17 | fix(agent-server): map profile-store errors in scoped secrets list (#5898) | server | `settings`, `test_settings` | 2 | DELEGATED |
| `75dec1d3ef1c` | 2026-10-17 | fix(agent-server): honor UTC offsets in bash event timestamp filters (#5875) | server | `bash`, `test_bash` | 2 | DELEGATED |
| `5f2185ed6333` | 2026-10-17 | fix(typescript-client): type GitChange.status with the server's wire values (#5957) | — | — | 0 | ignored/unmapped |
| `47c50f7e5c68` | 2026-10-16 | fix: use short tmux sockets for overlong paths (#6038) | sdk | `terminal` | 2 | NO_TARGET_CHANGE |
| `47c50f7e5c68` | 2026-10-16 | fix: use short tmux sockets for overlong paths (#6038) | server | `test_api` | 1 | DELEGATED |
| `f621dab57be8` | 2026-10-17 | fix(agent-server): answer 409 and keep state when a write loses ownership (#5973) | server | `api`, `conversation`, `event`, `test_auto_title_span_metadata`, `test_conversation`, `test_unhandled_exception_error_id` | 6 | DELEGATED |
| `8cfff960ff3b` | 2026-10-17 | fix(typescript): resolve updateConversation with the updated conversation (#5956) | — | — | 0 | ignored/unmapped |
| `804498a61126` | 2026-10-17 | fix(agent-server): answer 409 when a continued gateway run waits for confirmation (#5968) | server | `openai`, `test_openai_gateway_reused_wait` | 2 | DELEGATED |
| `b301ee008178` | 2026-10-17 | fix(sdk): deliver streamed deltas to RemoteConversation token_callbacks (#5965) | sdk | `conversation` | 2 | DEFERRED |
| `4fedb7e2b524` | 2026-10-17 | fix(ts-client): match agent-profile payload types to the server models (#5877) | — | — | 0 | ignored/unmapped |
| `8ee5cba234d1` | 2026-10-17 | fix(agent-server): guard LLM profile delete through the .json alias (#5868) | sdk | `llm`, `profiles` | 3 | DEFERRED |
| `8ee5cba234d1` | 2026-10-17 | fix(agent-server): guard LLM profile delete through the .json alias (#5868) | server | `profiles`, `test_profiles` | 2 | DELEGATED |
| `e785defbf652` | 2026-10-17 | fix(agent-server): post webhook events that fill the buffer during an in-flight batch (#5953) | server | `conversation`, `test_webhook_subscriber` | 2 | DELEGATED |
| `14f821bb2af5` | 2026-10-17 | fix(sdk): list git changes of a repository subdirectory relative to it (#5848) | sdk | `git` | 2 | PORT |
| `9af99982a125` | 2026-10-17 | fix(agent-server): report real usage buckets in telemetry outcome events (#5967) | server | `telemetry` | 2 | DELEGATED |
| `7d459bcb1111` | 2026-10-17 | fix(agent-server): describe the secret-key fallback of TelemetrySpec.salt (#5964) | server | `config`, `telemetry` | 2 | DELEGATED |
| `615759cc3497` | 2026-10-17 | fix(agent-server): reject a create whose agent tool module cannot be imported (#5958) | server | `conversation`, `test_conversation` | 4 | DELEGATED |
| `eac3ee16cc98` | 2026-10-17 | fix(agent-server): URL-encode the VS Code URL's folder and token (#5859) | server | `test_vscode`, `vscode` | 2 | DELEGATED |
| `af05c8b46a8a` | 2026-10-17 | fix(agent-server): report the uploaded file_size in the upload response (#5856) | server | `file`, `models`, `test_file` | 3 | DELEGATED |
| `501d27323cf3` | 2026-10-17 | fix(agent-server): page search_subdirs past names that differ only by case (#5853) | server | `file`, `test_file` | 2 | DELEGATED |
| `e98b95654fdf` | 2026-10-17 | fix(agent-server): return 404 from ask_agent for an unknown conversation (#5819) | server | `conversation`, `test_conversation` | 2 | DELEGATED |
| `7f41284acefd` | 2026-10-17 | fix(sdk): refuse a blank ACP model before the first run (#5811) | sdk | `conversation` | 2 | DEVIATION |
| `9d07c6d55d1b` | 2026-10-17 | fix(agent-server): refuse more than 99 batch-get ids with a 422 (#5795) | server | `conversation`, `test_conversation` | 2 | DELEGATED |
| `75abe1eb3f5f` | 2026-10-17 | fix(agent-server): accept short event kinds in events search and count (#5773) | server | `event`, `test_event` | 2 | DELEGATED |
| `1fbfd37f6fb2` | 2026-10-17 | fix(ts): honor maxIterations and stuckDetection in ConversationManager.createConversation (#5783) | — | — | 0 | ignored/unmapped |
| `5966c781ed01` | 2026-10-17 | feat(agent-server): add start_child_conversation tool with a pluggable launcher (#5126) | sdk | `child_conversation`, `conversation` | 5 | DEFERRED |
| `5966c781ed01` | 2026-10-17 | feat(agent-server): add start_child_conversation tool with a pluggable launcher (#5126) | server | `api`, `config`, `conftest`, `conversation`, `init`, `models`, `test_config`, `test_init`, `test_parent_child_conversations`, `tool` | 11 | DELEGATED |
| `10b9b5a9242f` | 2026-10-17 | test: isolate live servers from inherited Canvas environment (#6061) | server | `test_event_loss_repro`, `test_remote_conversation_live_server` | 2 | DELEGATED |
| `e642683a1af3` | 2026-10-17 | ci: add opt-in macOS test suite workflow (#6039) | — | — | 0 | ignored/unmapped |
| `fd268089e257` | 2026-10-18 | docs(verify): use existing OpenHands profiles for critic checks (#6065) | — | — | 0 | ignored/unmapped |
| `7a714f41db5c` | 2026-10-17 | fix(agent-server): honor create_app config for the conversation service (#5686) | sdk | `test-infrastructure` | 1 | NO_TARGET_CHANGE |
| `7a714f41db5c` | 2026-10-17 | fix(agent-server): honor create_app config for the conversation service (#5686) | server | `api`, `test-infrastructure`, `test_api` | 3 | DELEGATED |
| `3f26a0570e96` | 2026-10-17 | test: keep the full macOS suite free of order-dependent failures (#6070) | server | `test_agent_secrets_integration`, `test_file`, `test_openapi_discriminator` | 3 | DELEGATED |
| `0b51554da5ba` | 2026-10-18 | fix(agent-server): re-arm the webhook flush timer after a failed batch (#6046) | server | `conversation`, `test_webhook_subscriber` | 2 | DELEGATED |
| `59b2831c17fb` | 2026-10-18 | fix(agent-server): answer /run 409 without waiting for the state lock (#5954) | server | `event`, `test_event` | 2 | DELEGATED |
| `6ae64079cfd3` | 2026-10-18 | fix(sdk): add ghu_/ghs_/gho_ GitHub token patterns to redact_api_key_literals (#6072) | sdk | `utils` | 1 | PORT |
| `3f3294581ebf` | 2026-10-19 | fix(sdk): pass events missed during a WebSocket reconnect to RemoteConversation callbacks (#5950) | sdk | `conversation` | 2 | DEFERRED |
| `3e8e17bee854` | 2026-10-19 | Cap litellm below 1.106 until the SDK can use mcp 2.x (#6089) | sdk | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |
| `3e8e17bee854` | 2026-10-19 | Cap litellm below 1.106 until the SDK can use mcp 2.x (#6089) | server | `dependencies` | 1 | DELEGATED |
| `33d8aa29c307` | 2026-10-19 | Release v1.56.0 (#6091) | sdk | `agent`, `conversation`, `dependencies`, `launch`, `persisted_settings_baselines`, `profiles`, `pyproject`, `settings`, `test_apply_agent_settings_diff`, `test_settings`, `tool`, `utils`, `workspace` | 27 | DEFERRED |
| `33d8aa29c307` | 2026-10-19 | Release v1.56.0 (#6091) | server | `dependencies`, `persistence`, `pyproject`, `test_agent_profiles`, `test_check_persisted_settings_compat`, `test_settings` | 6 | DELEGATED |

## Explicitly ignored repository paths

- .agents/skills/pr-design-doc/SKILL.md
- .agents/skills/pr-design-doc/references/html-craft.md
- .agents/skills/verify-agent-server/SKILL.md
- .agents/skills/verify-agent-server/references/feature-map/F04-conversation-lifecycle.md
- .agents/skills/verify-agent-server/references/feature-map/F05-run-pause-interrupt.md
- .agents/skills/verify-agent-server/references/feature-map/F06-conversation-events.md
- .agents/skills/verify-agent-server/references/feature-map/F08-confirmation-security-secrets.md
- .agents/skills/verify-agent-server/references/feature-map/F09-model-switching-plugins.md
- .agents/skills/verify-agent-server/references/feature-map/F10-fork-navigate-condense-ask.md
- .agents/skills/verify-agent-server/references/feature-map/F11-goals.md
- .agents/skills/verify-agent-server/references/feature-map/F13-bash.md
- .agents/skills/verify-agent-server/references/feature-map/F14-files.md
- .agents/skills/verify-agent-server/references/feature-map/F15-git.md
- .agents/skills/verify-agent-server/references/feature-map/F16-workspace-serving-and-vscode.md
- .agents/skills/verify-agent-server/references/feature-map/F17-workspaces-registry.md
- .agents/skills/verify-agent-server/references/feature-map/F18-settings-and-secrets.md
- .agents/skills/verify-agent-server/references/feature-map/F19-mcp.md
- .agents/skills/verify-agent-server/references/feature-map/F20-llm-profiles.md
- .agents/skills/verify-agent-server/references/feature-map/F21-agent-profiles.md
- .agents/skills/verify-agent-server/references/feature-map/F22-meta-profiles.md
- .agents/skills/verify-agent-server/references/feature-map/F23-llm-catalog-and-connections.md
- .agents/skills/verify-agent-server/references/feature-map/F25-skills.md
- .agents/skills/verify-agent-server/references/feature-map/F27-hooks-subagents-tools.md
- .agents/skills/verify-agent-server/references/feature-map/F28-canvas-extensions.md
- .agents/skills/verify-agent-server/references/feature-map/F29-app-backend-bridge.md
- .agents/skills/verify-agent-server/references/feature-map/F30-openai-gateway.md
- .agents/skills/verify-agent-server/references/feature-map/F31-persistence-and-limits.md
- .agents/skills/verify-agent-server/references/feature-map/F32-webhooks-and-telemetry.md
- .agents/skills/verify-agent-server/references/feature-map/F33-sdk-remote-client.md
- .agents/skills/verify-agent-server/references/feature-map/F34-typescript-client.md
- .github/PULL_REQUEST_TEMPLATE.md
- .github/workflows/pr-artifacts.yml
- .github/workflows/precommit.yml
- .github/workflows/tests-macos.yml
- AGENTS.md
- CONTRIBUTING.md
- clients/typescript/README.md
- clients/typescript/config/public-type-budget.json
- clients/typescript/package-lock.json
- clients/typescript/package.json
- clients/typescript/src/__tests__/agent-server-contract-types.test.ts
- clients/typescript/src/__tests__/api-clients.test.ts
- clients/typescript/src/__tests__/conversation-create-options.test.ts
- clients/typescript/src/__tests__/derive-switch-plan.test.ts
- clients/typescript/src/__tests__/package-import.test.ts
- clients/typescript/src/__tests__/remote-workspace-execute.test.ts
- clients/typescript/src/__tests__/remote-workspace-git.test.ts
- clients/typescript/src/__tests__/websocket-callback-client.test.ts
- clients/typescript/src/client/conversation-client.ts
- clients/typescript/src/conversation/base.ts
- clients/typescript/src/conversation/conversation-manager.ts
- clients/typescript/src/conversation/remote-conversation.ts
- clients/typescript/src/events/bash-websocket-client.ts
- clients/typescript/src/events/global-websocket.ts
- clients/typescript/src/events/websocket-client.ts
- clients/typescript/src/generated/agent-server-schema.ts
- clients/typescript/src/index.ts
- clients/typescript/src/models/agent-profile.ts
- clients/typescript/src/models/workspace.ts
- clients/typescript/src/workspace/remote-workspace.ts

## Review summary

- **PORT:** 3
- **NO_TARGET_CHANGE:** 6
- **DEVIATION:** 1
- **EXCLUDED:** 0
- **DEFERRED:** 7
- **DELEGATED:** 43
- **UNREVIEWED:** 0
