import type { BaseMessage } from '@langchain/core/messages';
import { OpenRouterService } from '../services/open_router.ts';
import { McpClientService, type McpCategory, type McpSubcategory, type McpLocation } from '../services/mcp_client.ts';
import { getMcpLangChainTools } from '../services/mcp_tools.ts';
import { buildSumTransactionsTool } from '../services/local_tools.ts';

export const buildSystemPrompt = (date: string, categories: McpCategory[], subcategories: McpSubcategory[], locations: McpLocation[]) => JSON.stringify({
    role: "Personal finance assistant with direct access to the user's finance tools.",
    task: 'Answer the user\'s question or perform the requested action by calling tools as many times as needed. Inspect each tool result before deciding the next call.',
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    sub_categories: subcategories.map((s) => ({ id: s.id, name: s.name })),
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
    rules: [
        'Resolve category/subcategory NAMES to numeric IDs using the categories/sub_categories lists above or the relevant list tools — never pass a name where an ID is expected. The location field on create_transaction/update_transaction is different: it takes the location NAME as free text, never an ID.',
        `Today's date is ${date} — compute relative ranges (this month, last month) from it.`,
        'For ANY question about totals or amounts spent/earned — overall, per category, or per period — call sum_transactions. Its numbers are computed in code and are authoritative. NEVER sum list_transactions rows yourself, and never answer a total from listed rows.',
        'Date filters are ALWAYS explicit start_date/end_date in YYYY-MM-DD: "this month" means day 01 through the last day of the current month. There is no current-month shortcut flag.',
        'Values ending in _formatted in tool results are already formatted — reproduce them verbatim, character for character.',
        'If an image or audio attachment is present, extract the transaction details from it before creating anything.',
        'A receipt is categorized by the ESTABLISHMENT, not item by item: EVERY item extracted from one receipt gets the SAME category_id. A supermarket receipt means every single item — food, cleaning supplies, hygiene, everything — gets the "Grocery" category. Item-level distinctions belong ONLY in subcategory_id.',
        'Every transaction you create — from a receipt image, audio, or text — MUST include both category_id and the best-matching subcategory_id from the sub_categories list, for EVERY item. Never skip subcategory_id when a plausible match exists.',
        'Only omit subcategory_id when no existing subcategory reasonably matches the item. NEVER create new subcategories yourself.',
        'Every transaction created from a receipt MUST include a location: the store/merchant name printed at the TOP of the receipt. First fuzzy-match it (case-insensitive) against the locations list above — receipts print full legal names, so "SUPERMERCADO BROMBATTI LTDA" refers to an existing location named "Brombatti". If an existing location plausibly refers to the same place, pass its name EXACTLY as it appears in the list. Only when nothing matches, pass a short human-friendly name (e.g. "Brombatti", not the full legal name) — it is created automatically. All items from the same receipt use the exact same location.',
        'If you create transactions but CANNOT infer the location, still create them (without location), and end your reply with exactly this question: "Não consegui identificar a location, qual seria?"',
        'If your previous message asked "Não consegui identificar a location, qual seria?" and the user replied with a location name: fuzzy-match that name against the locations list (or list_locations), reuse the existing name if one matches, and call update_transaction with that location (as text) for EVERY transaction id listed in the [internal note] of your previous message. Then confirm briefly.',
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
    createdTransactionIds: Array<string | number>;
    error?: string;
};

// Pulls the ids of transactions the agent created during this run out of the
// create_transaction tool results, so the endpoint can persist them with the
// assistant message (needed for the "qual seria a location?" follow-up turn).
function extractCreatedTransactionIds(toolResults: Array<{ name: string; content: string }>): Array<string | number> {
    const ids: Array<string | number> = [];
    for (const result of toolResults) {
        if (result.name !== 'create_transaction') continue;
        try {
            const parsed = JSON.parse(result.content) as Record<string, unknown>;
            const transaction = (parsed.transaction ?? parsed) as Record<string, unknown>;
            const id = transaction.id;
            if (typeof id === 'string' || typeof id === 'number') ids.push(id);
        } catch {
            // Non-JSON tool result (e.g. an error string) — nothing to extract.
        }
    }
    return ids;
}

export async function runAskAgent(
    llmClient: OpenRouterService,
    mcpClient: McpClientService,
    input: { messages: BaseMessage[]; userId?: string; sessionId?: string },
): Promise<AskAgentResult> {
    console.log('🤖 Running ask agent...');

    let tools;
    try {
        // sum_transactions is a local tool: totals are computed in code, never
        // by the model.
        tools = [...await getMcpLangChainTools(mcpClient), buildSumTransactionsTool(mcpClient)];
    } catch (error) {
        console.error('❌ Failed to discover MCP tools:', error);
        return {
            answer: "Sorry, I can't reach the finance service right now.",
            toolsUsed: [],
            createdTransactionIds: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }

    // Preload the lists so the model always sees the available options and can
    // assign category_id/subcategory_id/location without deciding to call the
    // list tools.
    let categories: McpCategory[] = [];
    let subcategories: McpSubcategory[] = [];
    let locations: McpLocation[] = [];
    try {
        [categories, subcategories, locations] = await Promise.all([
            mcpClient.listCategories(),
            mcpClient.listSubcategories(),
            mcpClient.listLocations(),
        ]);
    } catch (error) {
        console.warn('⚠️  Failed to preload categories/subcategories/locations, agent will fall back to list tools:', error);
    }

    const result = await llmClient.runAgent({
        systemPrompt: buildSystemPrompt(new Date().toISOString().slice(0, 10), categories, subcategories, locations),
        messages: input.messages,
        tools,
        userId: input.userId,
        sessionId: input.sessionId,
        tags: ['ask-endpoint', 'agent'],
    });

    const createdTransactionIds = extractCreatedTransactionIds(result.toolResults);

    if (!result.success) {
        console.warn('⚠️  Ask agent failed:', result.error);
        return {
            answer: result.answer || 'Sorry, something went wrong while answering.',
            toolsUsed: [],
            createdTransactionIds,
            error: result.error,
        };
    }

    console.log(`✅ Ask agent done (tools used: ${result.toolsUsed.join(', ') || 'none'})`);
    return { answer: result.answer, toolsUsed: result.toolsUsed, createdTransactionIds };
}
