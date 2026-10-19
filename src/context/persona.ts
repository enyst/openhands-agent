import type { ToolDefinition } from '../tool/index.js';
import * as text from './static-prompt-text.js';

export interface StaticSystemPromptOptions {
  readonly systemPrompt?: string | null;
  readonly persona?: string | null;
  readonly tools?: readonly ToolDefinition[];
  readonly model?: string;
  readonly preset?: 'default' | 'planning';
  readonly planStructure?: string;
}

export function toolPromptGuidance(tools: readonly ToolDefinition[]): string[] {
  return [...new Set(tools.map(tool => tool.promptGuidance).filter((guidance): guidance is string => Boolean(guidance)))];
}

export function renderStaticSystemPrompt(options: StaticSystemPromptOptions = {}): string {
  const guidance = toolPromptGuidance(options.tools ?? []);
  if (options.systemPrompt !== null && options.systemPrompt !== undefined) return [options.systemPrompt, ...guidance].join('\n\n');
  const persona = options.persona?.trim() ? options.persona : null;
  if (options.preset === 'planning') return [persona, text.PlanningSection_BODY.replace('{plan_structure}', options.planStructure ?? '')].filter(value => value !== null).join('\n\n');
  const identity = persona === null;
  const sections = [
    persona,
    identity ? `<SOUL>\n${text.SoulSection__DEFAULT_SOUL}\n</SOUL>` : null,
    identity ? text.RoleSection_body : null,
    `<MEMORY>\n${text.MemorySection__AGENTS_MD_GUIDANCE}\n</MEMORY>`,
    ...(identity ? [text.EfficiencySection_body, text.FileSystemSection_body, text.CodeQualitySection_body,
      text.VersionControlSection_body, text.PullRequestsSection_body, text.ProblemSolvingSection_body, text.SelfDocumentationSection_body] : []),
    text.SecuritySection_body,
    ...guidance,
    text.ExternalServicesSection_body,
    ...(identity ? [text.EnvironmentSetupSection_body, text.TroubleshootingSection_body] : []),
    text.ProcessManagementSection_body,
    modelGuidance(options.model ?? ''),
  ];
  return sections.filter(section => section !== null && section !== '').join('\n\n');
}

function modelGuidance(model: string): string | null {
  const name = model.toLowerCase().trim();
  const openai = ['gpt-', 'o1', 'o3', 'o4'].some(pattern => name.includes(pattern));
  const family = !openai && name.includes('claude') ? 'anthropic_claude' : !openai && name.includes('gemini') ? 'google_gemini' : null;
  const variant = ['gpt-5-codex', 'gpt-5.1-codex', 'gpt-5.2-codex', 'gpt-5.3-codex', 'gpt-5.5-codex'].some(value => name.includes(value))
    ? 'gpt-5-codex' : name.includes('gpt-5') ? 'gpt-5' : null;
  const body = ((family === null ? '' : text.ModelSpecificSection__IMPORTANT_BY_FAMILY[family])
    + (variant === null ? '' : text.ModelSpecificSection__IMPORTANT_BY_VARIANT[variant])).trim();
  return body ? `<IMPORTANT>\n${body}\n</IMPORTANT>` : null;
}
