import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpendingFacts } from '../graph/insights_agent.ts';
import type { McpClientService, McpTransaction } from '../services/mcp_client.ts';

const CATEGORIES = [
    { id: 1, name: 'Food' },
    { id: 2, name: 'Grocery' },
    { id: 3, name: 'Housing' },
    { id: 4, name: 'Health' },
];

// Mocks the transactions backend the way buildSpendingFacts uses it: two
// fetchAllTransactions calls with explicit start_date/end_date (current month
// and the trailing history window). The mock filters by those dates so each
// call sees only its own period, and returns everything on the first page.
function mockClient(transactions: McpTransaction[]) {
    const client = {
        listTransactions: (params: Record<string, unknown>) => {
            if (Number(params.offset ?? 0) > 0) return Promise.resolve([]);
            const start = params.start_date as string | undefined;
            const end = params.end_date as string | undefined;
            const type = params.type as string | undefined;
            const rows = transactions.filter((t) => {
                if (type && String(t.type) !== type) return false;
                const d = String((t as { date?: string }).date ?? '');
                if (start && d < start) return false;
                if (end && d > end) return false;
                return true;
            });
            return Promise.resolve(rows);
        },
        listCategories: () => Promise.resolve(CATEGORIES),
    } as unknown as McpClientService;
    return client;
}

function tx(date: string, amount: number, categoryId: number): McpTransaction {
    return { id: Math.random(), amount, type: 'expense', category_id: categoryId, date } as McpTransaction;
}

// Feb–Jul each: Grocery 1000, Housing 5000, Food 1000. July grocery then spikes
// to 4000 (a +300% surge vs its average), and the current month (August) has
// only a single tiny Housing charge — the exact "first day of the month" shape.
function buildHistory(): McpTransaction[] {
    const rows: McpTransaction[] = [];
    for (const month of ['01', '02', '03', '04', '05', '06']) {
        rows.push(tx(`2026-${month}-10`, 1000, 2)); // Grocery
        rows.push(tx(`2026-${month}-10`, 5000, 3)); // Housing
        rows.push(tx(`2026-${month}-10`, 1000, 1)); // Food
    }
    // July: grocery surge
    rows.push(tx('2026-07-10', 4000, 2));
    rows.push(tx('2026-07-10', 5000, 3));
    rows.push(tx('2026-07-10', 1000, 1));
    return rows;
}

test('early in the month: pivots to a last-month retrospective, no projections or obvious-absence findings', async () => {
    const history = buildHistory();
    const current = [tx('2026-08-01', 149, 3)]; // tiny Housing charge on day 1
    const client = mockClient([...history, ...current]);

    // Aug 1st 2026, 12:00 in America/Sao_Paulo (15:00 UTC).
    const facts = await buildSpendingFacts(client, new Date(Date.UTC(2026, 7, 1, 15, 0, 0)));

    assert.equal(facts.hasData, true);
    assert.equal(facts.mode, 'early');
    assert.match(facts.text, /EARLY-MONTH NOTICE/);
    assert.match(facts.text, /LAST MONTH RETROSPECTIVE/);
    // The July grocery surge is surfaced as guidance for the month ahead.
    assert.match(facts.text, /Grocery.*\+300%/);

    // None of the things the user complained about early in the month.
    assert.doesNotMatch(facts.text, /Projected/);
    assert.doesNotMatch(facts.text, /NO SPEND YET/);
    assert.doesNotMatch(facts.text, /vs 6-mo avg/);
});

test('mid month: keeps the by-category analysis but never projects', async () => {
    const history = buildHistory();
    const current = [
        tx('2026-08-05', 3000, 2), // Grocery
        tx('2026-08-10', 4200, 3), // Housing
        tx('2026-08-12', 900, 1), // Food
    ];
    const client = mockClient([...history, ...current]);

    // Aug 20th 2026 — well past the early-month window.
    const facts = await buildSpendingFacts(client, new Date(Date.UTC(2026, 7, 20, 15, 0, 0)));

    assert.equal(facts.hasData, true);
    assert.equal(facts.mode, 'normal');
    assert.match(facts.text, /BY CATEGORY/);
    assert.doesNotMatch(facts.text, /Projected/);
    assert.doesNotMatch(facts.text, /EARLY-MONTH NOTICE/);
});

test('no history and no current spend yields no data', async () => {
    const client = mockClient([]);
    const facts = await buildSpendingFacts(client, new Date(Date.UTC(2026, 7, 1, 15, 0, 0)));
    assert.equal(facts.hasData, false);
});
