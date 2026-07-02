import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../config/config.ts';

// If your mcp-go server uses SSE transport instead of StreamableHTTP,
// import SSEClientTransport from '@modelcontextprotocol/sdk/client/sse.js'
// and connect to `${config.mcpApiUrl}/sse` instead of `.../mcp`.

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

  private async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    let client: Client;
    try {
      client = await this.getClient();
    } catch {
      this._client = null;
      throw new Error(`Failed to connect to MCP server at ${config.mcpApiUrl}`);
    }
    try {
      const result = await client.callTool({ name, arguments: args });
      const textContent = result.content.find(c => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error(`Tool ${name} returned no text content`);
      }
      return JSON.parse(textContent.text);
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
