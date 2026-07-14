import type { BaseMessage } from '@langchain/core/messages';
import { OpenRouterService } from '../services/open_router.ts';
import { McpClientService } from '../services/mcp_client.ts';
import { getMcpLangChainTools } from '../services/mcp_tools.ts';

const SYSTEM_PROMPT = JSON.stringify({
    role: "Personal finance assistant with direct access to the user's finance tools.",
    task: 'Answer the user\'s question or perform the requested action by calling tools as many times as needed. Inspect each tool result before deciding the next call.',
    rules: [
        'Resolve category/subcategory/location NAMES to numeric IDs by calling the relevant list tools first — never pass a name where an ID is expected.',
        "Today's date is {date} — compute relative ranges (this month, last month) from it.",
        'If an image or audio attachment is present, extract the transaction details from it before creating anything.',
        'Only state numbers that came from tool results — never invent data.',
        'If a tool returns an error, adjust the arguments and retry once; if it still fails, tell the user plainly what went wrong without leaking internal error details.',
        'Final reply: short, friendly, same language as the user. 1-4 sentences unless listing data.',
    ],
});

export type AskAgentResult = {
    answer: string;
    toolsUsed: string[];
    error?: string;
};

export async function runAskAgent(
    llmClient: OpenRouterService,
    mcpClient: McpClientService,
    input: { messages: BaseMessage[]; userId?: string; sessionId?: string },
): Promise<AskAgentResult> {
    console.log('🤖 Running ask agent...');

    let tools;
    try {
        tools = await getMcpLangChainTools(mcpClient);
    } catch (error) {
        console.error('❌ Failed to discover MCP tools:', error);
        return {
            answer: "Sorry, I can't reach the finance service right now.",
            toolsUsed: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }

    const result = await llmClient.runAgent({
        systemPrompt: SYSTEM_PROMPT.replace('{date}', new Date().toISOString().slice(0, 10)),
        messages: input.messages,
        tools,
        userId: input.userId,
        sessionId: input.sessionId,
        tags: ['ask-endpoint', 'agent'],
    });

    if (!result.success) {
        console.warn('⚠️  Ask agent failed:', result.error);
        return {
            answer: result.answer || 'Sorry, something went wrong while answering.',
            toolsUsed: [],
            error: result.error,
        };
    }

    console.log(`✅ Ask agent done (tools used: ${result.toolsUsed.join(', ') || 'none'})`);
    return { answer: result.answer, toolsUsed: result.toolsUsed };
}
