/**
 * Test-only stand-in for the host-provided `@deepseek-ai/dsh-tools`.
 *
 * The plugin imports the host package at module load, and a fresh clone has no host install, so the
 * suite redirects that specifier here (see register-stubs.mjs). `defineTool` is an identity function
 * in the real package too -- it carries types and validates the definition shape.
 */
export function defineTool(definition) {
  if (definition == null || typeof definition !== 'object') {
    throw new TypeError('defineTool: expected a tool definition object');
  }
  if (typeof definition.name !== 'string' || definition.name.length === 0) {
    throw new TypeError('defineTool: a tool needs a name');
  }
  if (typeof definition.execute !== 'function') {
    throw new TypeError(`defineTool: ${definition.name} needs an execute function`);
  }
  return definition;
}

export default { defineTool };
