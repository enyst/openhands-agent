# OpenHands upstream drift

- **Repository:** `OpenHands/software-agent-sdk`
- **Pinned:** `dcf401af7a9a302ef92cb7d092e1df9bb659daa5` (2026-09-29T16:09:38-04:00)
- **Candidate:** `229b2b920d4541eab7a34b051a1f6f2bca5ebabf` (2026-10-05T00:09:55-04:00)
- **Commits:** 52 total; 52 first-parent review units

## Scope summary

| Target | Commit units | Files | Tests | Examples | Modules | Policy hints |
|---|---:|---:|---:|---:|---|---|
| sdk | 32 | 227 | 105 | 0 | `agent`, `ask_oracle`, `automation`, `browser_use`, `context`, `conversation`, `dependencies`, `file_editor`, `gemini`, `git`, `glob`, `grep`, `launch`, `llm`, `observability`, `persisted_settings_baselines`, `planning_file_editor`, `profiles`, `pyproject`, `repository`, `schemas`, `settings`, `subagent`, `task`, `task_tracker`, `terminal`, `test_apply_agent_settings_diff`, `test_automation_observability`, `test_docker_workspace`, `test_examples`, `test_settings`, `tool`, `utils`, `workflow`, `workspace` | `DEV-SDK-004`, `DEV-SDK-006`, `DEV-SDK-008`, `DEV-SDK-009`, `DEV-SDK-010`, `DEV-SDK-011`, `DEV-SDK-012` |
| server | 32 | 135 | 58 | 0 | `agent-server`, `agent_profiles`, `api`, `auth`, `bash`, `canvas_extensions`, `canvas_extensions_bridge`, `config`, `conftest`, `conversation`, `dependencies`, `docker_runtime`, `event`, `git`, `git_provider`, `init`, `launch`, `llm`, `models`, `openai`, `persistence`, `profile_launch`, `profiles`, `provider_connections`, `pyproject`, `repository`, `runtime`, `server_details`, `settings`, `stress`, `test_acp_skill_sourcing`, `test_agent_launch_additions`, `test_agent_profile_conv_start`, `test_agent_profiles`, `test_api`, `test_bash`, `test_canvas_extensions`, `test_check_persisted_settings_compat`, `test_conversation`, `test_conversation_info_model`, `test_default_tool_names`, `test_event`, `test_git`, `test_git_provider`, `test_goal_loop`, `test_init`, `test_launch_architecture`, `test_launch_parity`, `test_llm`, `test_managed_llm_key_http`, `test_openai_gateway_settings`, `test_persisted_settings_migration`, `test_persistence_secret_detection`, `test_profiles`, `test_remote_conversation_live_server`, `test_run_admission`, `test_server_details`, `test_server_workflow_binary_smoke`, `test_settings`, `test_tool`, `test_vscode`, `tool`, `vscode` | `DEV-SERVER-004`, `DEV-SERVER-005`, `DEV-SERVER-006`, `DEV-SERVER-007`, `DEV-SERVER-008`, `DEV-SERVER-009`, `DEV-SERVER-010` |

## First-parent changes

| Commit | Date | Subject | Target | Modules | Files | Disposition |
|---|---|---|---|---|---:|---|
| `2b9502cee3b7` | 2026-09-29 | test(agent-server): cover budget denial after managed-key refresh (#5378) | server | `test_managed_llm_key_http` | 1 | DELEGATED |
| `51149e76a886` | 2026-09-29 | fix(sdk): restore tool registrations on remote attach (#5069) | sdk | `conversation` | 2 | PORT |
| `51149e76a886` | 2026-09-29 | fix(sdk): restore tool registrations on remote attach (#5069) | server | `conversation`, `models`, `test_conversation`, `test_conversation_info_model` | 4 | DELEGATED |
| `2a4ef6379cf1` | 2026-09-29 | feat(apps): bridge authenticated app backends (#5272) | server | `api`, `auth`, `canvas_extensions`, `canvas_extensions_bridge`, `config`, `docker_runtime`, `server_details`, `test_canvas_extensions`, `test_server_details`, `test_server_workflow_binary_smoke` | 13 | DELEGATED |
| `898a2724ad10` | 2026-09-29 | chore(deps): bump eslint from 10.10.0 to 10.11.0 in /clients/typescript (#5302) | — | — | 0 | ignored/unmapped |
| `23fc50cd6d65` | 2026-09-29 | chore(deps): bump @types/node from 26.5.1 to 26.6.2 in /clients/typescript (#5301) | — | — | 0 | ignored/unmapped |
| `bcc14d666747` | 2026-09-29 | chore(deps): update httpx[socks] requirement from >=0.27.0 to >=0.28.1 (#5295) | sdk | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |
| `bcc14d666747` | 2026-09-29 | chore(deps): update httpx[socks] requirement from >=0.27.0 to >=0.28.1 (#5295) | server | `dependencies` | 1 | DELEGATED |
| `e1e8950ceb53` | 2026-09-29 | chore(deps): bump binaryornot from 0.4.4 to 0.6.0 (#5297) | sdk | `dependencies`, `file_editor`, `pyproject` | 5 | DEFERRED |
| `e1e8950ceb53` | 2026-09-29 | chore(deps): bump binaryornot from 0.4.4 to 0.6.0 (#5297) | server | `agent-server`, `dependencies` | 2 | DELEGATED |
| `79df4e896c19` | 2026-09-29 | chore(deps): bump @openrouter/sdk from 1.2.147 to 1.3.32 in /clients/typescript (#5305) | — | — | 0 | ignored/unmapped |
| `656a5c4794d0` | 2026-09-29 | fix(llm): time out hung async streams (#5000) | sdk | `llm` | 3 | PORT |
| `e5191f907626` | 2026-09-29 | fix(agent-server): reject excess conversation creation and runs with HTTP 429 (#5350) | server | `api`, `config`, `conversation`, `event`, `stress`, `test_event`, `test_goal_loop`, `test_run_admission` | 10 | DELEGATED |
| `01682f8c7d3c` | 2026-09-29 | chore(deps): bump google-cloud-aiplatform from 1.157.0 to 2.1.3 (#5296) | sdk | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |
| `01682f8c7d3c` | 2026-09-29 | chore(deps): bump google-cloud-aiplatform from 1.157.0 to 2.1.3 (#5296) | server | `dependencies` | 1 | DELEGATED |
| `5ffdd2933c51` | 2026-09-30 | fix(agent-server): refresh catalog after evicting idle Docker runtimes (#5369) | server | `docker_runtime` | 2 | DELEGATED |
| `230115adcf4b` | 2026-09-30 | fix(deps): bump PyJWT to 2.14.0 for security advisories (#5391) | sdk | `dependencies`, `repository` | 2 | NO_TARGET_CHANGE |
| `230115adcf4b` | 2026-09-30 | fix(deps): bump PyJWT to 2.14.0 for security advisories (#5391) | server | `dependencies`, `repository` | 2 | DELEGATED |
| `d0f9500590c1` | 2026-09-30 | fix(agent-server): use the session key as VSCode token on /api/init (#5282) | server | `init`, `test_init`, `test_vscode`, `vscode` | 4 | DELEGATED |
| `3c8be74ae1db` | 2026-09-30 | Add Agent Server git repository search API (#5393) | sdk | `git` | 1 | PORT |
| `3c8be74ae1db` | 2026-09-30 | Add Agent Server git repository search API (#5393) | server | `git`, `git_provider`, `runtime`, `test_git`, `test_git_provider` | 5 | DELEGATED |
| `1e1390acc878` | 2026-09-30 | Release v1.50.1 (#5410) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | NO_TARGET_CHANGE |
| `1e1390acc878` | 2026-09-30 | Release v1.50.1 (#5410) | server | `dependencies`, `pyproject` | 2 | DELEGATED |
| `411beb8c51be` | 2026-09-30 | fix(llm): resolve prompt_cache_key via real provider for proxied models (#5332) | sdk | `llm` | 2 | PORT |
| `7c4d3ad201c9` | 2026-09-30 | feat(llm): make OpenRouter a verified provider (#5274) | sdk | `llm` | 3 | PORT |
| `7c4d3ad201c9` | 2026-09-30 | feat(llm): make OpenRouter a verified provider (#5274) | server | `llm`, `test_llm` | 2 | DELEGATED |
| `dec243a14608` | 2026-09-30 | fix(ci): behavior test runs post "Behavior Tests Results" comment title (#4945) | sdk | `schemas`, `utils` | 3 | NO_TARGET_CHANGE |
| `fad637744591` | 2026-09-30 | fix(ci): surface version-bump-prs failures instead of always reporting success (#5415) | — | — | 0 | ignored/unmapped |
| `0a9abc87641a` | 2026-10-01 | fix(settings): deprecate ACPAgentSettings.llm so ACP agents keep their metrics LLM (#5434) | sdk | `conversation`, `persisted_settings_baselines`, `settings`, `test_settings`, `workspace` | 10 | PORT |
| `0a9abc87641a` | 2026-10-01 | fix(settings): deprecate ACPAgentSettings.llm so ACP agents keep their metrics LLM (#5434) | server | `openai`, `persistence`, `profiles`, `provider_connections`, `settings`, `test_check_persisted_settings_compat`, `test_conversation`, `test_openai_gateway_settings`, `test_persistence_secret_detection`, `test_profiles`, `test_settings` | 11 | DELEGATED |
| `af016a03a1ae` | 2026-10-01 | fix(agent-server): resolve provider connection in /switch_llm (#5417) | sdk | `llm` | 1 | DEFERRED |
| `af016a03a1ae` | 2026-10-01 | fix(agent-server): resolve provider connection in /switch_llm (#5417) | server | `conversation`, `test_conversation` | 2 | DELEGATED |
| `53a4bc501490` | 2026-10-01 | fix(router): send system+user classifier messages for direct-routing (#5412) | sdk | `tool` | 2 | PORT |
| `a2f051f4d6da` | 2026-10-02 | chore(deps): bump @typescript-eslint/parser from 8.70.0 to 8.70.1 in /clients/typescript (#5425) | — | — | 0 | ignored/unmapped |
| `b535c8ac19f3` | 2026-10-02 | chore(deps): bump @typescript-eslint/eslint-plugin from 8.70.0 to 8.70.1 in /clients/typescript (#5428) | — | — | 0 | ignored/unmapped |
| `cc97bf234ea6` | 2026-10-02 | chore(deps): bump pydantic from 2.12.5 to 2.13.5 (#5419) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | NO_TARGET_CHANGE |
| `cc97bf234ea6` | 2026-10-02 | chore(deps): bump pydantic from 2.12.5 to 2.13.5 (#5419) | server | `dependencies`, `pyproject` | 2 | DELEGATED |
| `1e2cc5d2fad3` | 2026-10-02 | Fix find_dotenv assertion error in local conversation (#1326) | sdk | `observability` | 4 | PORT |
| `41443fc14a8a` | 2026-10-02 | feat(agent-profiles): tools is the only tool control, selected from one server catalog (#5151) | sdk | `ask_oracle`, `browser_use`, `conversation`, `file_editor`, `gemini`, `glob`, `grep`, `persisted_settings_baselines`, `planning_file_editor`, `profiles`, `settings`, `task`, `task_tracker`, `terminal`, `test_settings`, `tool`, `workflow` | 58 | DEFERRED |
| `41443fc14a8a` | 2026-10-02 | feat(agent-profiles): tools is the only tool control, selected from one server catalog (#5151) | server | `agent_profiles`, `api`, `config`, `conversation`, `docker_runtime`, `persistence`, `profile_launch`, `server_details`, `test_agent_profile_conv_start`, `test_agent_profiles`, `test_check_persisted_settings_compat`, `test_conversation`, `test_persisted_settings_migration`, `test_remote_conversation_live_server`, `test_server_details`, `test_tool`, `tool` | 18 | DELEGATED |
| `048c9be7619b` | 2026-10-02 | feat(agent-profiles): let a profile replace the agent's persona (#5449) | sdk | `agent`, `context`, `profiles`, `settings`, `test_apply_agent_settings_diff`, `test_settings` | 15 | PORT |
| `048c9be7619b` | 2026-10-02 | feat(agent-profiles): let a profile replace the agent's persona (#5449) | server | `server_details`, `test_agent_profile_conv_start`, `test_server_details` | 3 | DELEGATED |
| `bec71283c15b` | 2026-10-02 | refactor(sdk): let loaded tools supply their system-prompt guidance (browser) (#5450) | sdk | `agent`, `browser_use`, `context`, `tool` | 41 | PORT |
| `8034b0dbc3f6` | 2026-10-02 | test(stress): leave a run slot for the reference conversation (#5397) | server | `stress` | 1 | DELEGATED |
| `9b66ae79c397` | 2026-10-02 | fix(agent-profiles): keep delegated sub-agents within the profile's tools and MCP servers (#5358) | sdk | `profiles`, `subagent`, `task`, `workflow` | 11 | DEFERRED |
| `9b66ae79c397` | 2026-10-02 | fix(agent-profiles): keep delegated sub-agents within the profile's tools and MCP servers (#5358) | server | `test_default_tool_names` | 1 | DELEGATED |
| `35410b3af87e` | 2026-10-02 | feat(agent-profiles): launch every agent through resolve and finalize (#5406) | sdk | `conversation`, `launch`, `profiles`, `settings` | 17 | DEFERRED |
| `35410b3af87e` | 2026-10-02 | feat(agent-profiles): launch every agent through resolve and finalize (#5406) | server | `agent_profiles`, `conversation`, `docker_runtime`, `launch`, `openai`, `profile_launch`, `test_acp_skill_sourcing`, `test_agent_launch_additions`, `test_agent_profile_conv_start`, `test_agent_profiles`, `test_conversation`, `test_launch_architecture`, `test_launch_parity`, `test_remote_conversation_live_server`, `tool` | 22 | DELEGATED |
| `a955aa5d3188` | 2026-10-03 | Release v1.51.0 (#5470) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | NO_TARGET_CHANGE |
| `a955aa5d3188` | 2026-10-03 | Release v1.51.0 (#5470) | server | `dependencies`, `pyproject` | 2 | DELEGATED |
| `84d4470acd85` | 2026-10-03 | chore(typescript): agent-server to v1.51.0 (#5472) | — | — | 0 | ignored/unmapped |
| `08af1d5aa3c7` | 2026-10-03 | fix(sdk): drop in-flight tool calls from ask_agent context (#4630) | sdk | `conversation` | 1 | DEFERRED |
| `28c3a2d59c67` | 2026-10-03 | fix(client): retry a lost create only where the server deduplicates (#5363) | — | — | 0 | ignored/unmapped |
| `8ac973c9ac7e` | 2026-10-03 | fix(server): dedupe concurrent conversation creates and forks (#5362) | server | `conversation`, `server_details`, `test_conversation` | 3 | DELEGATED |
| `1b2b5c850b6a` | 2026-10-03 | feat: propagate automation observability context (#5462) | sdk | `automation`, `conversation`, `observability`, `test_automation_observability`, `workspace` | 13 | PORT |
| `1b2b5c850b6a` | 2026-10-03 | feat: propagate automation observability context (#5462) | server | `conversation`, `event`, `openai`, `test_conversation` | 4 | DELEGATED |
| `30e90260c914` | 2026-10-03 | fix(terminal): isolate tmux sockets to prevent cross-conversation handle reuse (#5485) | sdk | `terminal` | 3 | DEVIATION |
| `30e90260c914` | 2026-10-03 | fix(terminal): isolate tmux sockets to prevent cross-conversation handle reuse (#5485) | server | `api`, `test_api` | 2 | DELEGATED |
| `7b66584ff889` | 2026-10-03 | fix(workspace): publish Docker ports on loopback (#5209) | sdk | `test_docker_workspace`, `workspace` | 2 | DEFERRED |
| `6fcb587bcf4a` | 2026-10-03 | fix(agent-server): release terminal run permits promptly (#5403) | server | `conftest`, `event`, `test_run_admission` | 3 | DELEGATED |
| `ca4efd75bba9` | 2026-10-03 | chore(deps): bump typescript-eslint from 8.70.1 to 8.71.0 in /clients/typescript (#5426) | — | — | 0 | ignored/unmapped |
| `739cbb6c67d7` | 2026-10-03 | chore(deps): bump prettier from 3.9.8 to 3.9.9 in /clients/typescript (#5424) | — | — | 0 | ignored/unmapped |
| `072e28b03d70` | 2026-10-03 | chore(deps): bump python-frontmatter from 1.1.0 to 1.3.0 (#5421) | sdk | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |
| `072e28b03d70` | 2026-10-03 | chore(deps): bump python-frontmatter from 1.1.0 to 1.3.0 (#5421) | server | `dependencies` | 1 | DELEGATED |
| `b347047e2dcd` | 2026-10-03 | chore(deps): bump uvicorn from 0.52.4 to 0.54.0 (#5420) | sdk | `dependencies` | 1 | NO_TARGET_CHANGE |
| `b347047e2dcd` | 2026-10-03 | chore(deps): bump uvicorn from 0.52.4 to 0.54.0 (#5420) | server | `dependencies`, `pyproject` | 2 | DELEGATED |
| `8b41a86de392` | 2026-10-04 | chore(deps): bump posthog from 6.7.7 to 7.60.0 (#5423) | sdk | `dependencies` | 1 | NO_TARGET_CHANGE |
| `8b41a86de392` | 2026-10-04 | chore(deps): bump posthog from 6.7.7 to 7.60.0 (#5423) | server | `dependencies`, `pyproject` | 2 | DELEGATED |
| `b66c72436157` | 2026-10-04 | feat(agent-server): add stop operation for a single BashCommand (#5348) | sdk | `workspace` | 3 | PORT |
| `b66c72436157` | 2026-10-04 | feat(agent-server): add stop operation for a single BashCommand (#5348) | server | `bash`, `test_bash`, `test_remote_conversation_live_server` | 4 | DELEGATED |
| `3ca6a14940a9` | 2026-10-04 | chore(deps): bump @types/node from 26.6.2 to 26.6.3 in /clients/typescript (#5427) | — | — | 0 | ignored/unmapped |
| `7999acfadc0a` | 2026-10-04 | chore(deps): bump actions/checkout from 4.4.0 to 7.0.1 (#5422) | server | `stress` | 1 | DELEGATED |
| `106ddf9a920e` | 2026-10-04 | Fix example tmux socket paths (#5494) | sdk | `test_examples` | 1 | DEVIATION |
| `229b2b920d45` | 2026-10-05 | Release v1.52.0 (#5490) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | NO_TARGET_CHANGE |
| `229b2b920d45` | 2026-10-05 | Release v1.52.0 (#5490) | server | `dependencies`, `pyproject` | 2 | DELEGATED |

## Explicitly ignored repository paths

- .github/workflows/agent-server-rest-api-breakage.yml
- .github/workflows/check-docstrings.yml
- .github/workflows/check-documented-examples.yml
- .github/workflows/check-duplicate-examples.yml
- .github/workflows/deprecation-check.yml
- .github/workflows/integration-runner.yml
- .github/workflows/issue-duplicate-checker.yml
- .github/workflows/issue-readiness-check.yml
- .github/workflows/persisted-settings-compat.yml
- .github/workflows/pr-artifacts.yml
- .github/workflows/pr-description-check.yml
- .github/workflows/precommit.yml
- .github/workflows/prepare-release.yml
- .github/workflows/pypi-release.yml
- .github/workflows/release-binaries.yml
- .github/workflows/run-eval.yml
- .github/workflows/run-examples.yml
- .github/workflows/security-scan.yml
- .github/workflows/server.yml
- .github/workflows/tests.yml
- .github/workflows/todo-management.yml
- .github/workflows/typescript-client-ci.yml
- .github/workflows/typescript-client-endpoint-audit.yml
- .github/workflows/typescript-client-github-packages-publish.yml
- .github/workflows/typescript-client-integration-tests.yml
- .github/workflows/typescript-client-npm-publish.yml
- .github/workflows/update-debian-snapshot.yml
- .github/workflows/version-bump-guard.yml
- .github/workflows/version-bump-prs.yml
- .pr/design.html
- .pr/stop-bash-evidence.md
- .pr/stop-bash-evidence.py
- AGENTS.md
- clients/typescript/package-lock.json
- clients/typescript/package.json
- clients/typescript/src/__tests__/api-clients.test.ts
- clients/typescript/src/__tests__/canvas-extensions-client.test.ts
- clients/typescript/src/__tests__/conversation-create-retry.test.ts
- clients/typescript/src/__tests__/derive-switch-plan.test.ts
- clients/typescript/src/client/agent-profiles-client.ts
- clients/typescript/src/client/agent-server-compatibility.ts
- clients/typescript/src/client/bash-client.ts
- clients/typescript/src/client/canvas-extensions-client.ts
- clients/typescript/src/client/conversation-client.ts
- clients/typescript/src/client/git-client.ts
- clients/typescript/src/client/http-client.ts
- clients/typescript/src/client/openhands-client.ts
- clients/typescript/src/client/tool-client.ts
- clients/typescript/src/clients.ts
- clients/typescript/src/generated/agent-server-schema.ts
- clients/typescript/src/index.ts
- clients/typescript/src/models/agent-profile.ts
- clients/typescript/src/models/agent-server-api.ts
- clients/typescript/src/models/api.ts
- clients/typescript/src/models/tool-catalog.ts
- clients/typescript/src/types/base.ts

## Review summary

- **PORT:** 12
- **NO_TARGET_CHANGE:** 11
- **DEVIATION:** 2
- **EXCLUDED:** 0
- **DEFERRED:** 7
- **DELEGATED:** 32
- **UNREVIEWED:** 0
