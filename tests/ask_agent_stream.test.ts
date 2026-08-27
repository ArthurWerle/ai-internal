import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAskAgentStream, type AskAgentStreamEvent } from '../graph/ask_agent.ts';
import type { McpClientService } from '../services/mcp_client.ts';
import type { OpenRouterService } from '../services/open_router.ts';

// Drains the streaming generator into an array so we can assert on the events
// it emitted, in order.
async function collect(
    stream: AsyncGenerator<AskAgentStreamEvent>,
): Promise<AskAgentStreamEvent[]> {
    const events: AskAgentStreamEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}

test('runAskAgentStream yields a single failure result when tool discovery fails', async () => {
    // listTools rejects, so getMcpLangChainTools throws before the agent (and
    // OpenRouter) is ever touched — the LLM client is never used here.
    const mcpClient = {
        async listTools() {
            throw new Error('mcp unreachable');
        },
    } as unknown as McpClientService;
    const llmClient = {} as OpenRouterService;

    const events = await collect(
        runAskAgentStream(llmClient, mcpClient, { messages: [] }),
    );

    // No tokens or tool activity — just the terminal result carrying the
    // user-facing fallback and the underlying error.
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.type, 'result');
    if (event.type !== 'result') return;
    assert.equal(event.result.answer, "Sorry, I can't reach the finance service right now.");
    assert.equal(event.result.toolsUsed.length, 0);
    assert.deepEqual(event.result.createdTransactionIds, []);
    assert.match(event.result.error ?? '', /mcp unreachable/);
});
