import { McpClientService } from "../../../services/mcp_client.ts";
import { GraphState } from "../../receipt_scanner.ts";

export function createCreateTransactionsNode(mcpClient: McpClientService) {
    return async (state: GraphState): Promise<Partial<GraphState>> => {
        console.log(`💳 Creating ${state.items!.length} transaction(s) via MCP...`);

        const results = await Promise.allSettled(
            state.items!.map(item =>
                mcpClient.createTransaction({
                    amount: item.value,
                    type: item.type ?? 'expense',
                    category_id: item.categoryId,
                    subcategory_id: item.subcategoryId,
                    description: item.description,
                    date: item.datetime,
                    location: item.location,
                })
            )
        );

        const createdTransactions = results.map((result, i) => {
            if (result.status === 'fulfilled') {
                return result.value as Record<string, unknown>;
            }
            console.error(`❌ Failed to create transaction for "${state.items![i].description}":`, result.reason);
            return {
                description: state.items![i].description,
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            };
        });

        const succeeded = createdTransactions.filter(t => !t.error).length;
        console.log(`✅ Created ${succeeded}/${state.items!.length} transaction(s)`);

        return { createdTransactions };
    };
}
