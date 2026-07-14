import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../config/config.ts';

export type McpCategory = { id: number; name: string };
export type McpSubcategory = { id: number; name: string };
export type McpLocation = { id: number; name: string };

export type CreateTransactionPayload = {
  amount: number;
  type: 'income' | 'expense';
  category_id?: number;
  subcategory_id?: number;
  description?: string;
  date?: string;
  location?: string;
};

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export class McpClientService {
  private _client: Client | null = null;

  private async getClient(): Promise<Client> {
    if (this._client) return this._client;
    const client = new Client({ name: 'ai-internal', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${config.mcpApiUrl}/mcp`)
    );
    await client.connect(transport);
    this._client = client;
    return client;
  }

  async listTools(): Promise<McpToolInfo[]> {
    let client: Client;
    try {
      client = await this.getClient();
    } catch (error) {
      this._client = null;
      console.error('❌ Failed to connect to MCP:', error);
      throw new Error(error instanceof Error ? error.message : `Failed to connect to MCP server at ${config.mcpApiUrl}`);
    }
    try {
      const result = await client.listTools();
      return result.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    } catch (err) {
      this._client = null;
      throw err;
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    let client: Client;
    try {
      client = await this.getClient();
    } catch (error) {
      this._client = null;
      console.error('❌ Failed to fetch context from MCP:', error);
      throw new Error(error instanceof Error ? error.message : `Failed to connect to MCP server at ${config.mcpApiUrl}`);
    }
    try {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text?: string }>;
      const textContent = content.find(c => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error(`Tool ${name} returned no text content`);
      }

      // Try to parse the response as JSON
      try {
        return JSON.parse(textContent.text);
      } catch (parseError) {
        // If JSON parsing fails, check if it's an error message from the MCP server
        const text = textContent.text;

        // Check for upstream error pattern
        const upstreamErrorMatch = text.match(/upstream error response.*?body=({.*})/);
        if (upstreamErrorMatch) {
          try {
            const errorBody = JSON.parse(upstreamErrorMatch[1]);
            throw new Error(`MCP tool '${name}' failed: ${errorBody.error || errorBody.details || 'Unknown error'}`);
          } catch {
            // If we can't parse the error body, fall through
          }
        }

        // Check if the entire response looks like an error message
        if (text.includes('error') || text.includes('Error') || text.includes('upstream')) {
          throw new Error(`MCP tool '${name}' returned an error: ${text.substring(0, 200)}`);
        }

        // Otherwise, it's just invalid JSON
        throw new Error(`MCP tool '${name}' returned invalid JSON: ${text.substring(0, 100)}...`);
      }
    } catch (err) {
      this._client = null;
      throw err;
    }
  }

  async listCategories(): Promise<McpCategory[]> {
    const data = await this.callTool('list_categories') as any;
    return Array.isArray(data) ? data : (data.categories ?? data.data ?? []);
  }

  async listSubcategories(): Promise<McpSubcategory[]> {
    const data = await this.callTool('list_subcategories') as any;
    return Array.isArray(data) ? data : (data.subcategories ?? data.data ?? []);
  }

  async listLocations(): Promise<McpLocation[]> {
    const data = await this.callTool('list_locations') as any;
    return Array.isArray(data) ? data : (data.locations ?? data.data ?? []);
  }

  async createTransaction(payload: CreateTransactionPayload): Promise<unknown> {
    return this.callTool('create_transaction', payload as Record<string, unknown>);
  }

}
