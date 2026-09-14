export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@anthropic-ai/claude-agent-sdk") return { url: new URL("mock-claude.mjs", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
