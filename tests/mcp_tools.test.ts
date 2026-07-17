import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMcpLangChainTools } from '../services/mcp_tools.ts';
import type { McpClientService } from '../services/mcp_client.ts';

test('hides the broken current_month flag from the model and drops it from args', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
        listTools: () => Promise.resolve([
            {
                name: 'list_transactions',
                description: 'List transactions',
                inputSchema: {
                    type: 'object',
                    properties: {
                        current_month: { type: 'boolean' },
                        start_date: { type: 'string' },
                        end_date: { type: 'string' },
                    },
                    required: ['current_month'],
                },
            },
        ]),
        callTool: (name: string, args: Record<string, unknown>) => {
            calls.push({ name, args });
            return Promise.resolve([]);
        },
    } as unknown as McpClientService;

    const tools = await getMcpLangChainTools(client);
    const listTransactions = tools.find((t) => t.name === 'list_transactions')!;

    const schema = listTransactions.schema as { properties: Record<string, unknown>; required?: string[] };
    assert.equal('current_month' in schema.properties, false);
    assert.equal('start_date' in schema.properties, true);
    assert.equal(schema.required?.includes('current_month'), false);

    // Even if the model somehow still emits the flag, it never reaches the MCP.
    await listTransactions.invoke({ current_month: true, start_date: '2026-07-01' });
    assert.equal('current_month' in calls[0].args, false);
    assert.equal(calls[0].args.start_date, '2026-07-01');
});
