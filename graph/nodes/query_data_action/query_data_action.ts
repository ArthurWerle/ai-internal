import z from "zod/v3";
import { OpenRouterService } from "../../../services/open_router.ts";
import { McpClientService, type McpCategory } from "../../../services/mcp_client.ts";
import type { AskGraphState } from "../../ask_graph.ts";
import { PROMPTS } from './prompts.ts';

const QueryToolSchema = z.enum([
    'list_transactions',
    'get_transaction',
    'get_latest_transactions',
    'get_biggest_transactions',
    'get_average_by_type',
    'get_average_by_category',
]);

const QuerySelectionSchema = z.object({
    tool: QueryToolSchema,
    current_month: z.boolean().optional(),
    category: z.string().optional(),
    query: z.string().optional(),
    type: z.enum(['income', 'expense']).optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
    id: z.union([z.string(), z.number()]).optional(),
    month: z.number().optional(),
    year: z.number().optional(),
    category_id: z.number().optional(),
});

// Resolve the planner's category selection to a numeric category ID. The
// transactions service only accepts numeric IDs and 400s on a raw name
// ("Cannot parse category ID: grocery"), so we must never forward a name:
//   - trust the LLM's category_id only when it's a real id,
//   - otherwise resolve the category name against the fetched list,
//   - and if neither matches, return undefined (drop the filter).
function resolveCategoryId(
    params: { category_id?: number; category?: string },
    categories: McpCategory[],
): number | undefined {
    const validIds = new Set(categories.map(c => c.id));
    if (params.category_id !== undefined && validIds.has(params.category_id)) {
        return params.category_id;
    }
    if (params.category) {
        const target = params.category.trim().toLowerCase();
        const match = categories.find(c => c.name.trim().toLowerCase() === target);
        if (match) return match.id;
    }
    return undefined;
}

export function createQueryDataActionNode(llmClient: OpenRouterService, mcpClient: McpClientService) {
    return async (state: AskGraphState): Promise<Partial<AskGraphState>> => {
        console.log('🔎 Running query-data action...');

        const lastMessage = state.messages.at(-1);
        if (!lastMessage) {
            return { error: 'No messages in state.' };
        }

        try {
            // Fetch categories so the planner can resolve names → IDs (mirrors the
            // receipt-scanner fetch_context pattern). Degrade gracefully if the list
            // can't be fetched: the deterministic resolver simply drops the filter.
            let categories: McpCategory[] = [];
            try {
                categories = await mcpClient.listCategories();
            } catch (error) {
                console.warn('⚠️  Failed to fetch categories for query planner:', error);
            }

            const selection = await llmClient.generateStructured(
                PROMPTS.getSystemPrompt(categories),
                lastMessage,
                QuerySelectionSchema,
                {
                    userId: state.userId,
                    sessionId: state.sessionId,
                    tags: ['ask-endpoint', 'query-data'],
                    history: state.messages.slice(0, -1),
                },
            );

            if (!selection.success) {
                console.warn('⚠️  Query selection failed:', selection.error);
                return { error: selection.error };
            }

            const params = selection.data!;
            const categoryId = resolveCategoryId(params, categories);
            let queryResult: unknown;

            switch (params.tool) {
                case 'list_transactions':
                    queryResult = await mcpClient.listTransactions({
                        current_month: params.current_month,
                        category_id: categoryId,
                        query: params.query,
                        type: params.type,
                        start_date: params.start_date,
                        end_date: params.end_date,
                        limit: params.limit,
                        offset: params.offset,
                    });
                    break;
                case 'get_transaction':
                    if (params.id === undefined) {
                        return { error: 'No transaction id provided.' };
                    }
                    queryResult = await mcpClient.getTransaction(params.id);
                    break;
                case 'get_latest_transactions':
                    queryResult = await mcpClient.getLatestTransactions(params.limit);
                    break;
                case 'get_biggest_transactions':
                    queryResult = await mcpClient.getBiggestTransactions({ month: params.month, year: params.year });
                    break;
                case 'get_average_by_type':
                    queryResult = await mcpClient.getAverageByType();
                    break;
                case 'get_average_by_category':
                    queryResult = await mcpClient.getAverageByCategory({
                        category_id: categoryId,
                        start_date: params.start_date,
                        end_date: params.end_date,
                    });
                    break;
            }

            console.log(`✅ Query complete: ${params.tool}`);
            return { queryResult, queryTool: params.tool };
        } catch (error) {
            console.error('❌ Error in queryDataAction node:', error);
            return {
                error: error instanceof Error ? error.message : 'Query failed',
            };
        }
    };
}
