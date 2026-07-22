import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import { buildReceiptScannerGraph } from '../graph/receipt_scanner.ts';
import { config } from '../config/config.ts';
import type { OpenRouterService } from '../services/open_router.ts';
import type { McpClientService } from '../services/mcp_client.ts';

const CATEGORIES = [
    { id: 1, name: 'Food' },
    { id: 2, name: 'Grocery' },
    { id: 3, name: 'Health' },
];
const SUBCATEGORIES = [
    { id: 2, name: 'Bebidas' },
    { id: 5, name: 'Doces e snacks' },
    { id: 6, name: 'Limpeza' },
];
const LOCATIONS = [{ id: 1, name: 'Mercado 1' }];

// Records every createTransaction payload so tests can assert what (if anything)
// was created. listCategories/etc. feed the fetchContext node.
function mockMcp() {
    const created: Array<Record<string, unknown>> = [];
    const client = {
        listCategories: () => Promise.resolve(CATEGORIES),
        listSubcategories: () => Promise.resolve(SUBCATEGORIES),
        listLocations: () => Promise.resolve(LOCATIONS),
        createTransaction: (payload: Record<string, unknown>) => {
            created.push(payload);
            return Promise.resolve({ transaction: { id: created.length, ...payload } });
        },
    } as unknown as McpClientService;
    return { client, created };
}

// The identify call passes options.model (the scan model); the summary call does
// not. That lets one mock answer both generateStructured calls the graph makes.
function mockLlm(identifyData: unknown) {
    const identifyOptions: Array<Record<string, unknown> | undefined> = [];
    const client = {
        generateStructured: (
            _system: string,
            _input: unknown,
            _schema: unknown,
            options?: Record<string, unknown>,
        ) => {
            if (options?.model) {
                identifyOptions.push(options);
                return Promise.resolve({ success: true, data: identifyData });
            }
            return Promise.resolve({ success: true, data: { summary: 'ok' } });
        },
    } as unknown as OpenRouterService;
    return { client, identifyOptions };
}

test('creates all items and never blocks when the classifier is confident', async () => {
    const { client: mcp, created } = mockMcp();
    const { client: llm, identifyOptions } = mockLlm({
        items: [
            { categoryId: 2, subcategoryId: 5, datetime: '2026-05-12T16:00:00.000Z', value: 8.9, description: 'Coxinha', location: 'Mercado 1' },
            { categoryId: 2, subcategoryId: 6, datetime: '2026-05-12T16:00:00.000Z', value: 12.5, description: 'Detergente', location: 'Mercado 1' },
        ],
    });

    const graph = buildReceiptScannerGraph(llm, mcp);
    const result = await graph.invoke({ messages: [new HumanMessage('receipt')] });

    // Every item was created, and every one is Grocery (category 2) — a food item
    // (coxinha) on a supermarket receipt must not become Food.
    assert.equal(created.length, 2);
    assert.deepEqual(created.map((c) => c.category_id), [2, 2]);
    assert.equal(result.createdTransactions?.length, 2);
    assert.ok(!result.needsClarification);
    // Classification must run on the dedicated scan model, not the cheap default.
    assert.equal(identifyOptions[0]?.model, config.scanModel);
});

test('asks and creates nothing when the classifier is unsure', async () => {
    const { client: mcp, created } = mockMcp();
    const { client: llm } = mockLlm({
        items: [],
        needsClarification: true,
        clarificationQuestion: 'Onde foi essa compra?',
    });

    const graph = buildReceiptScannerGraph(llm, mcp);
    const result = await graph.invoke({ messages: [new HumanMessage('blurry photo')] });

    assert.equal(result.needsClarification, true);
    assert.equal(result.clarificationQuestion, 'Onde foi essa compra?');
    // Nothing is persisted until the user answers.
    assert.equal(created.length, 0);
    assert.equal(result.createdTransactions, undefined);
});
