import { McpClientService } from "../../../services/mcp_client.ts";
import { GraphState } from "../../receipt_scanner.ts";

export function createFetchContextNode(mcpClient: McpClientService) {
    return async (_state: GraphState): Promise<Partial<GraphState>> => {
        console.log('📋 Fetching context from MCP...');
        try {
            const [categories, subcategories, locations] = await Promise.all([
                mcpClient.listCategories(),
                mcpClient.listSubcategories(),
                mcpClient.listLocations(),
            ]);

            console.log(`✅ Context fetched: ${categories.length} categories, ${subcategories.length} subcategories, ${locations.length} locations`);
            return { categories, subcategories, locations };
        } catch (error) {
            console.error('❌ Failed to fetch context from MCP:', error);
            return {
                error: error instanceof Error ? error.message : 'Failed to fetch context from MCP',
            };
        }
    };
}
