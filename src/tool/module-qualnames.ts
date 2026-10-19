/**
 * Verified Python definition modules for the corresponding native tools.
 * These are protocol provenance, never dynamic imports or capability claims.
 * Hosts must explicitly attach a value to the actual implementation they register;
 * matching a registration's name alone does not establish this provenance.
 */
export const NATIVE_TOOL_MODULE_QUALNAMES = Object.freeze({
  terminal: 'openhands.tools.terminal.definition',
  file_editor: 'openhands.tools.file_editor.definition',
  task_tracker: 'openhands.tools.task_tracker.definition',
  glob: 'openhands.tools.glob.definition',
  grep: 'openhands.tools.grep.definition',
  finish: 'openhands.sdk.tool.builtins.finish',
  think: 'openhands.sdk.tool.builtins.think',
  switch_llm: 'openhands.sdk.tool.builtins.switch_llm',
  route_task_to_model: 'openhands.sdk.tool.builtins.classify_and_switch_llm',
} as const);
