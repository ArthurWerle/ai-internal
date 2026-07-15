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
            const item = state.items![i];
            if (result.status === 'fulfilled') {
                // The API wraps the created transaction in an envelope:
                // { message: "Transaction created successfully", transaction: {...} }.
                // Flatten it (falling back to the extracted item's data) so
                // downstream consumers see description/amount at the top level.
                const value = result.value as Record<string, unknown>;
                const transaction = (value.transaction ?? value) as Record<string, unknown>;
                return {
                    id: transaction.id as string | number | undefined,
                    amount: (transaction.amount as number | undefined) ?? item.value,
                    type: (transaction.type as string | undefined) ?? item.type ?? 'expense',
                    description: (transaction.description as string | undefined) ?? item.description,
                    date: (transaction.date as string | undefined) ?? item.datetime,
                    location: item.location,
                };
            }
            console.error(`❌ Failed to create transaction for "${item.description}":`, result.reason);
            return {
                description: item.description,
                amount: item.value,
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            };
        });

        const failed = createdTransactions.filter(t => 'error' in t);
        console.log(`✅ Created ${createdTransactions.length - failed.length}/${state.items!.length} transaction(s)`);
        if (failed.length > 0) {
            console.warn(`⚠️  ${failed.length} transaction(s) failed: ${failed.map(f => `"${f.description}"`).join(', ')}`);
        }

        return { createdTransactions };
    };
}
