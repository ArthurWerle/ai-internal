import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import type { McpClientService } from './mcp_client.ts';

const TOOLS_CACHE_TTL_MS = 60_000;

let cache: { tools: StructuredToolInterface[]; fetchedAt: number } | null = null;

// The MCP backend silently ignores the current_month flag and returns the
// ENTIRE transaction history as "this month" (see graph/insights_agent.ts).
// Hide the flag from the model and drop it from arguments so every date
// filter goes through explicit start_date/end_date.
const BROKEN_PARAMS = ['current_month'];

function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties || !BROKEN_PARAMS.some((p) => p in properties)) return schema;
  const cleaned = Object.fromEntries(
    Object.entries(properties).filter(([key]) => !BROKEN_PARAMS.includes(key)),
  );
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r) => !BROKEN_PARAMS.includes(r as string))
    : schema.required;
  return { ...schema, properties: cleaned, ...(required !== undefined ? { required } : {}) };
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => !BROKEN_PARAMS.includes(key)),
  );
}

// Wraps every tool exposed by the MCP server as a LangChain tool so the agent
// can call any of them. The MCP inputSchema is already JSON Schema, which
// tool() forwards verbatim to the model's tool definitions; argument
// validation happens server-side on the MCP end.
export async function getMcpLangChainTools(mcpClient: McpClientService): Promise<StructuredToolInterface[]> {
  if (cache && Date.now() - cache.fetchedAt < TOOLS_CACHE_TTL_MS) {
    return cache.tools;
  }

  const mcpTools = await mcpClient.listTools();
  const tools = mcpTools.map((t) =>
    tool(
      async (args) => {
        try {
          const result = await mcpClient.callTool(t.name, sanitizeArgs((args ?? {}) as Record<string, unknown>));
          return typeof result === 'string' ? result : JSON.stringify(result);
        } catch (error) {
          // Feed the error back to the model instead of aborting the loop, so
          // it can adjust its arguments and retry.
          const message = error instanceof Error ? error.message : String(error);
          return `Error calling ${t.name}: ${message.substring(0, 300)}`;
        }
      },
      {
        name: t.name,
        description: t.description ?? '',
        schema: sanitizeSchema(t.inputSchema),
      },
    ),
  );

  cache = { tools, fetchedAt: Date.now() };
  return tools;
}
