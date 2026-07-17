import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSumTransactionsTool } from '../services/local_tools.ts';
import type { McpClientService, McpTransaction } from '../services/mcp_client.ts';

const CATEGORIES = [
    { id: 1, name: 'Food' },
    { id: 2, name: 'Grocery' },
    { id: 3, name: 'Housing' },
];

type ListParams = Record<string, unknown>;

// Pages are keyed by offset/1000, mirroring how the tool walks the offsets.
function mockClient(pages: McpTransaction[][]) {
    const calls: ListParams[] = [];
    const client = {
        listTransactions: (params: ListParams) => {
            calls.push(params);
            const page = pages[Math.floor(Number(params.offset ?? 0) / 1000)] ?? [];
            return Promise.resolve(page);
        },
        listCategories: () => Promise.resolve(CATEGORIES),
    } as unknown as McpClientService;
    return { client, calls };
}

function tx(amount: number, categoryId: number | null, type = 'expense'): McpTransaction {
    return { id: Math.random(), amount, type, category_id: categoryId } as McpTransaction;
}

test('sums expenses per category and overall', async () => {
    const { client, calls } = mockClient([[
        tx(100, 1),
        tx(50.5, 1),
        tx(200, 2),
        tx(999, 3),
        tx(10, null),
    ]]);
    const tool = buildSumTransactionsTool(client);
    const result = JSON.parse(await tool.invoke({ start_date: '2026-07-01', end_date: '2026-07-31' }));

    assert.equal(result.total, 100 + 50.5 + 200 + 999 + 10);
    assert.equal(result.transaction_count, 5);
    assert.equal(result.total_formatted, 'R$ 1.359,50');
    const byId = Object.fromEntries(result.by_category.map((c: any) => [String(c.category_id), c]));
    assert.equal(byId['1'].total, 150.5);
    assert.equal(byId['1'].category_name, 'Food');
    assert.equal(byId['2'].total, 200);
    assert.equal(byId['null'].category_name, '(uncategorized)');
    // The backend must receive the explicit date filter, never current_month.
    assert.equal(calls[0].start_date, '2026-07-01');
    assert.equal(calls[0].end_date, '2026-07-31');
    assert.equal('current_month' in calls[0], false);
});

test('filters by category_ids in code (Food + Grocery)', async () => {
    const { client } = mockClient([[
        tx(100, 1),
        tx(200, 2),
        tx(999, 3),
        tx(10, null),
    ]]);
    const tool = buildSumTransactionsTool(client);
    const result = JSON.parse(
        await tool.invoke({ start_date: '2026-07-01', end_date: '2026-07-31', category_ids: [1, 2] }),
    );

    assert.equal(result.total, 300);
    assert.equal(result.transaction_count, 2);
    assert.deepEqual(
        result.by_category.map((c: any) => c.category_id).sort(),
        [1, 2],
    );
});

test('ignores income rows and uses absolute values for expenses', async () => {
    const { client } = mockClient([[
        tx(-80, 1), // signed expense
        tx(500, 1, 'income'), // must never inflate an expense total
        tx(20, 2),
    ]]);
    const tool = buildSumTransactionsTool(client);
    const result = JSON.parse(await tool.invoke({ start_date: '2026-07-01', end_date: '2026-07-31' }));

    assert.equal(result.total, 100);
    assert.equal(result.transaction_count, 2);
});

test('pages through all offsets so totals are never truncated', async () => {
    const fullPage = Array.from({ length: 1000 }, () => tx(1, 1));
    const secondPage = Array.from({ length: 500 }, () => tx(1, 2));
    const { client, calls } = mockClient([fullPage, secondPage]);
    const tool = buildSumTransactionsTool(client);
    const result = JSON.parse(await tool.invoke({ start_date: '2026-01-01', end_date: '2026-12-31' }));

    assert.equal(result.total, 1500);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].offset, 0);
    assert.equal(calls[1].offset, 1000);
});

test('feeds fetch errors back as a tool message instead of throwing', async () => {
    const client = {
        listTransactions: () => Promise.reject(new Error('mcp down')),
        listCategories: () => Promise.resolve(CATEGORIES),
    } as unknown as McpClientService;
    const tool = buildSumTransactionsTool(client);
    const result = await tool.invoke({ start_date: '2026-07-01', end_date: '2026-07-31' });

    assert.match(result, /Error calling sum_transactions: mcp down/);
});
