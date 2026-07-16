import type { BaseMessage } from '@langchain/core/messages';
import { OpenRouterService } from '../services/open_router.ts';
import { McpClientService, type McpCategory, type McpSubcategory } from '../services/mcp_client.ts';
import { getMcpLangChainTools } from '../services/mcp_tools.ts';

export const buildSystemPrompt = (date: string, categories: McpCategory[], subcategories: McpSubcategory[]) => JSON.stringify({
    role: "Personal finance assistant with direct access to the user's finance tools.",
    task: 'Answer the user\'s question or perform the requested action by calling tools as many times as needed. Inspect each tool result before deciding the next call.',
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    sub_categories: subcategories.map((s) => ({ id: s.id, name: s.name })),
    rules: [
        'Resolve category/subcategory/location NAMES to numeric IDs using the categories/sub_categories lists above or the relevant list tools — never pass a name where an ID is expected.',
        `Today's date is ${date} — compute relative ranges (this month, last month) from it.`,
        'If an image or audio attachment is present, extract the transaction details from it before creating anything.',
        'Every transaction you create — from a receipt image, audio, or text — MUST include both category_id and the best-matching subcategory_id from the sub_categories list, for EVERY item. Never skip subcategory_id when a plausible match exists.',
        'Only omit subcategory_id when no existing subcategory reasonably matches the item. NEVER create new subcategories yourself.',
        'If the categories or sub_categories lists above are empty, call list_categories and list_subcategories before creating any transaction.',
        'Only state numbers that came from tool results — never invent data.',
        'Format every monetary value as Brazilian Reais with the R$ prefix and pt-BR formatting (e.g. R$ 906,47). Percentages and non-money numbers stay as they are.',
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

    // Preload the lists so the model always sees the available options and can
    // assign category_id/subcategory_id without deciding to call the list tools.
    let categories: McpCategory[] = [];
    let subcategories: McpSubcategory[] = [];
    try {
        [categories, subcategories] = await Promise.all([
            mcpClient.listCategories(),
            mcpClient.listSubcategories(),
        ]);
    } catch (error) {
        console.warn('⚠️  Failed to preload categories/subcategories, agent will fall back to list tools:', error);
    }

    const result = await llmClient.runAgent({
        systemPrompt: buildSystemPrompt(new Date().toISOString().slice(0, 10), categories, subcategories),
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
