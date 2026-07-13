import { OpenRouterService } from "../../../services/open_router.ts";
import { McpClientService } from "../../../services/mcp_client.ts";
import type { AskGraphState } from "../../ask_graph.ts";
import { buildReceiptScannerGraph } from "../../receipt_scanner.ts";

export function createCreateTransactionActionNode(llmClient: OpenRouterService, mcpClient: McpClientService) {
    return async (state: AskGraphState): Promise<Partial<AskGraphState>> => {
        console.log('💳 Running create-transaction action...');

        const lastMessage = state.messages.at(-1);
        if (!lastMessage) {
            return { error: 'No messages in state.' };
        }

        try {
            const receiptScanner = buildReceiptScannerGraph(llmClient, mcpClient);
            const result = await receiptScanner.invoke({ messages: [lastMessage] });

            if (result.error) {
                console.warn('⚠️  Create-transaction action failed:', result.error);
                return { error: result.error };
            }

            console.log(`✅ Created ${result.createdTransactions?.length ?? 0} transaction(s)`);
            return {
                createdTransactions: result.createdTransactions,
                answer: result.summary,
            };
        } catch (error) {
            console.error('❌ Error in createTransactionAction node:', error);
            return {
                error: error instanceof Error ? error.message : 'Transaction creation failed',
            };
        }
    };
}
