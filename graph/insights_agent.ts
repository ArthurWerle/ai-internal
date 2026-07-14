import { HumanMessage } from '@langchain/core/messages';
import { OpenRouterService } from '../services/open_router.ts';
import { McpClientService } from '../services/mcp_client.ts';
import { getMcpLangChainTools } from '../services/mcp_tools.ts';

const SYSTEM_PROMPT = JSON.stringify({
    role: "Sharp personal-finance analyst with direct access to the user's finance tools.",
    task: 'Investigate the current month spendings by calling tools, then write ONE short insight for the app header.',
    method: [
        "Today's date is {date} — compute relative ranges (this month, last month, last 6 months) from it.",
        'Gather at least: the month overview (current vs last month), expenses by category for the current AND previous month, and monthly averages per category over the last 6 months. Look at the biggest transactions of the month if a category spike needs explaining.',
        'Compare: current month vs same point of last month (the month is not over — never compare a partial month against a full one without saying so), category totals vs last month, and category totals vs their 6-month average.',
        'Pick the SINGLE most meaningful finding: the biggest saving, the most unusual spike, or the overall pace of the month. Prefer specific categories over generic totals when the change is notable.',
    ],
    output_rules: [
        'Return ONLY the insight text — no preamble, no markdown, no quotes around it.',
        '1-2 sentences, maximum ~45 words. It must fit in a slim app header.',
        'Cite concrete percentages/numbers that came from tool results — never invent data.',
        'Be an analyst, not a reporter: say what changed, why it matters, and (when negative) a short nudge to pay attention.',
        'Warm, direct tone. Examples of the expected style: "Good work! You reduced your grocery spending by 23% compared to last month!" / "Your car costs are 15% above their 6-month average. Did anything happen? Keep an eye on it."',
        'Keep category names exactly as they appear in the data (do not translate them).',
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
                `Analyze my spendings for the month of ${today.slice(0, 7)} and give me the single most valuable insight.`,
            ),
        ],
        tools,
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
