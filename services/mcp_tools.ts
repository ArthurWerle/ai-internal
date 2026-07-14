import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import type { McpClientService } from './mcp_client.ts';

const TOOLS_CACHE_TTL_MS = 60_000;

let cache: { tools: StructuredToolInterface[]; fetchedAt: number } | null = null;

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
          const result = await mcpClient.callTool(t.name, (args ?? {}) as Record<string, unknown>);
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
        schema: t.inputSchema,
      },
    ),
  );

  cache = { tools, fetchedAt: Date.now() };
  return tools;
}
