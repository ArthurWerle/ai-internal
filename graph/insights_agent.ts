import { HumanMessage } from '@langchain/core/messages';
import { OpenRouterService } from '../services/open_router.ts';
import { McpClientService } from '../services/mcp_client.ts';
import { getMcpLangChainTools } from '../services/mcp_tools.ts';

const SYSTEM_PROMPT = JSON.stringify({
    role: "Personal-finance advisor helping a couple improve their spending, with direct access to their finance tools. Your job is to give them visibility into what they are doing well and where they are going wrong.",
    task: 'Investigate the current month spendings by calling tools, then write a detailed spending review for the couple.',
    method: [
        "Today's date is {date} — compute relative ranges (this month, last month, last 6 months) from it.",
        'Gather at least: the month overview (current vs last month), expenses by category for the current AND previous month, monthly averages per category over the last 6 months, and the biggest transactions of the month.',
        'Drill down: for the categories that moved the most, use subcategory data and individual transactions to explain WHAT drove the change — a review that names the subcategory or purchase behind a spike is far more useful than one that only cites the category total.',
        'Compare: current month vs same point of last month (the month is not over — never compare a partial month against a full one without saying so), category totals vs last month, and category totals vs their 6-month average.',
        'Select the findings that matter most: the clearest wins (real savings, categories under control) AND the clearest problems (spikes, categories creeping above their average). Both sides must appear in the review.',
    ],
    output_rules: [
        'Return ONLY the review in Markdown — no preamble, no code fences, no quotes around it.',
        'Structure: one short bold headline summarizing the pace of the month, then 3-5 bullet points, then one closing line with a single concrete suggestion for the rest of the month.',
        'Cover at least 3 different categories across the bullets, each with concrete numbers/percentages from tool results and, where it explains the movement, the subcategory or transaction behind it.',
        'Include at least one thing the couple is doing well and at least one concern.',
        'Total length around 120-180 words.',
        'Cite only numbers that came from tool results — never invent data.',
        'Warm, direct tone, addressed to the couple ("you"). Be an advisor, not a reporter: say what changed, why it matters, and what to do about it.',
        'Keep category and subcategory names exactly as they appear in the data (do not translate them).',
        'Write in this language: {language}.',
    ],
});

export type InsightsAgentResult = {
    insight: string;
    toolsUsed: string[];
    error?: string;
};

export async function runInsightsAgent(
    llmClient: OpenRouterService,
    mcpClient: McpClientService,
    options?: { language?: string; sessionId?: string },
): Promise<InsightsAgentResult> {
    console.log('📊 Running spending insights agent...');

    let tools;
    try {
        tools = await getMcpLangChainTools(mcpClient);
    } catch (error) {
        console.error('❌ Failed to discover MCP tools:', error);
        return {
            insight: '',
            toolsUsed: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }

    const today = new Date().toISOString().slice(0, 10);
    const language = options?.language ?? 'en';

    const result = await llmClient.runAgent({
        systemPrompt: SYSTEM_PROMPT.replace('{date}', today).replace('{language}', language),
        messages: [
            new HumanMessage(
                `Analyze our spendings for the month of ${today.slice(0, 7)} and write our detailed spending review.`,
            ),
        ],
        tools,
        name: 'spending-insights-agent',
        sessionId: options?.sessionId,
        tags: ['insights-endpoint', 'agent'],
    });

    if (!result.success || !result.answer.trim()) {
        console.warn('⚠️  Insights agent failed:', result.error);
        return {
            insight: '',
            toolsUsed: result.toolsUsed,
            error: result.error ?? 'agent returned an empty insight',
        };
    }

    console.log(`✅ Insights agent done (tools used: ${result.toolsUsed.join(', ') || 'none'})`);
    return { insight: result.answer.trim(), toolsUsed: result.toolsUsed };
}
