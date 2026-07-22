import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSumTransactionsTool, buildAnalyzeSpendingTool } from '../services/local_tools.ts';
import type { McpClientService, McpTransaction } from '../services/mcp_client.ts';
import { addMonths, monthKey, nowInReportingTz } from '../lib/transactions.ts';

// A minimal in-memory MCP client. It honours the start_date/end_date filters
// (plain YYYY-MM-DD string compares, which is how the real service buckets
// dates) so fetchAllTransactions returns the right window for each period the
// tools ask for. Type filtering also happens in the tools' own code.
function fakeMcp(transactions: McpTransaction[], categories: { id: number; name: string }[]): McpClientService {
    return {
        async listTransactions(params: { start_date?: string; end_date?: string } = {}) {
            return transactions.filter((t) => {
                const date = (t as any).date as string | undefined;
                if (params.start_date && (!date || date < params.start_date)) return false;
                if (params.end_date && (!date || date > params.end_date)) return false;
                return true;
            });
        },
        async listCategories() {
            return categories;
        },
    } as unknown as McpClientService;
}

const CATS = [{ id: 5, name: 'Carro' }];

test('sum_transactions filters by description_query (case-insensitive substring)', async () => {
    const tx: McpTransaction[] = [
        { id: 1, type: 'expense', amount: 100, category_id: 5, description: 'Gasolina posto', date: '2026-07-18' },
        { id: 2, type: 'expense', amount: 50, category_id: 5, description: 'Lavagem no Chokito', date: '2026-07-10' },
        { id: 3, type: 'expense', amount: 30, category_id: 5, description: 'GASOLINA na volta', date: '2026-07-12' },
    ];
    const tool = buildSumTransactionsTool(fakeMcp(tx, CATS));

    const res = JSON.parse(
        (await tool.invoke({ start_date: '2026-07-01', end_date: '2026-07-31', description_query: 'gasolina' })) as string,
    );

    assert.equal(res.total, 130);
    assert.equal(res.transaction_count, 2);
    assert.equal(res.description_query, 'gasolina');
});

test('sum_transactions filters by subcategory_ids', async () => {
    const tx: McpTransaction[] = [
        { id: 1, type: 'expense', amount: 100, category_id: 5, subcategory_id: 9, description: 'a', date: '2026-07-18' },
        { id: 2, type: 'expense', amount: 40, category_id: 5, subcategory_id: 7, description: 'b', date: '2026-07-10' },
        { id: 3, type: 'expense', amount: 25, category_id: 5, subcategory_id: 9, description: 'c', date: '2026-07-12' },
    ];
    const tool = buildSumTransactionsTool(fakeMcp(tx, CATS));

    const res = JSON.parse(
        (await tool.invoke({ start_date: '2026-07-01', end_date: '2026-07-31', subcategory_ids: [9] })) as string,
    );

    assert.equal(res.total, 125);
    assert.equal(res.transaction_count, 2);
});

test('sum_transactions ignores income when summing expenses', async () => {
    const tx: McpTransaction[] = [
        { id: 1, type: 'expense', amount: 100, category_id: 5, description: 'gasolina', date: '2026-07-18' },
        { id: 2, type: 'income', amount: 999, category_id: 5, description: 'gasolina refund', date: '2026-07-19' },
    ];
    const tool = buildSumTransactionsTool(fakeMcp(tx, CATS));

    const res = JSON.parse(
        (await tool.invoke({ start_date: '2026-07-01', end_date: '2026-07-31', description_query: 'gasolina' })) as string,
    );

    assert.equal(res.total, 100);
    assert.equal(res.transaction_count, 1);
});

test('analyze_spending compares the current month against the last full month', async () => {
    // Build dates relative to "now" so the tool's current/previous month math
    // lines up regardless of when the test runs.
    const today = nowInReportingTz(new Date());
    const cur = monthKey({ year: today.year, month: today.month });
    const prev = monthKey(addMonths({ year: today.year, month: today.month }, -1));

    const tx: McpTransaction[] = [
        { id: 1, type: 'expense', amount: 200, category_id: 5, description: 'x', date: `${cur}-01` },
        { id: 2, type: 'expense', amount: 100, category_id: 5, description: 'y', date: `${prev}-15` },
    ];
    const tool = buildAnalyzeSpendingTool(fakeMcp(tx, CATS));

    const res = JSON.parse((await tool.invoke({})) as string);

    assert.equal(res.current_month.total, 200);
    assert.equal(res.current_month.partial, true);
    assert.equal(res.last_full_month.month, prev);
    assert.equal(res.last_full_month.total, 100);

    const carro = res.by_category.find((c: { category_id: number }) => c.category_id === 5);
    assert.ok(carro, 'Carro row should be present');
    assert.equal(carro.current_month, 200);
    assert.equal(carro.last_full_month, 100);
    assert.equal(carro.pct_vs_last_month, '+100%');

    // Run-rate projection over a partial month can only be >= what is spent.
    assert.ok(res.current_month.projected_total >= res.current_month.total);
});
