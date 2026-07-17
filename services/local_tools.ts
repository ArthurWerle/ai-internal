import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod/v3';
import type { McpClientService } from './mcp_client.ts';
import { formatBRL } from '../lib/currency.ts';
import { amountForType, categoryIdOf, fetchAllTransactions } from '../lib/transactions.ts';

// Local (non-MCP) tool that computes transaction totals in code. The model
// must never sum list_transactions rows itself — LLM arithmetic over dozens of
// rows produced wildly different totals for the same question (see
// graph/insights_agent.ts for the same compute-then-narrate rule).

const SumTransactionsSchema = z.object({
    start_date: z.string().describe('Inclusive period start, YYYY-MM-DD. "This month" starts on day 01 of the current month.'),
    end_date: z.string().describe('Inclusive period end, YYYY-MM-DD. "This month" ends on the last day of the current month.'),
    category_ids: z
        .array(z.number())
        .optional()
        .describe('Numeric category ids to include (resolve names via the categories list). Omit to include ALL categories.'),
    type: z.enum(['expense', 'income']).optional().describe("Which side to sum. Defaults to 'expense'."),
});

export function buildSumTransactionsTool(mcpClient: McpClientService): StructuredToolInterface {
    return tool(
        async (input) => {
            const args = input as z.infer<typeof SumTransactionsSchema>;
            const type = args.type ?? 'expense';
            try {
                const [transactions, categories] = await Promise.all([
                    fetchAllTransactions(mcpClient, {
                        type,
                        start_date: args.start_date,
                        end_date: args.end_date,
                    }),
                    mcpClient.listCategories(),
                ]);

                const wanted = args.category_ids?.length ? new Set(args.category_ids) : null;
                const byCategory = new Map<number | null, { total: number; count: number }>();
                let total = 0;
                let count = 0;
                for (const t of transactions) {
                    const amount = amountForType(t, type);
                    if (amount === 0) continue;
                    const cid = categoryIdOf(t);
                    if (wanted && (cid == null || !wanted.has(cid))) continue;
                    total += amount;
                    count += 1;
                    const entry = byCategory.get(cid) ?? { total: 0, count: 0 };
                    entry.total += amount;
                    entry.count += 1;
                    byCategory.set(cid, entry);
                }

                const categoryName = new Map(categories.map((c) => [c.id, c.name]));
                const by_category = [...byCategory.entries()]
                    .map(([cid, entry]) => ({
                        category_id: cid,
                        category_name: cid == null ? '(uncategorized)' : categoryName.get(cid) ?? `Category ${cid}`,
                        total: entry.total,
                        total_formatted: formatBRL(entry.total),
                        transaction_count: entry.count,
                    }))
                    .sort((a, b) => b.total - a.total);

                return JSON.stringify({
                    type,
                    start_date: args.start_date,
                    end_date: args.end_date,
                    total,
                    total_formatted: formatBRL(total),
                    transaction_count: count,
                    by_category,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return `Error calling sum_transactions: ${message.substring(0, 300)}`;
            }
        },
        {
            name: 'sum_transactions',
            description:
                'Compute the EXACT total of transactions for a date range, overall and per category. Pages through every matching transaction and sums in code, so the returned numbers are authoritative. ALWAYS use this for any question about totals or amounts spent/earned ("how much", "total", "sum", "spending by category"). Never add up list_transactions rows yourself.',
            schema: SumTransactionsSchema,
        },
    );
}
