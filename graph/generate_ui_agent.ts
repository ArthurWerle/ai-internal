import type { BaseMessage } from '@langchain/core/messages';
import { OpenRouterService } from '../services/open_router.ts';
import {
    McpClientService,
    type McpCategory,
    type McpSubcategory,
    type McpLocation,
} from '../services/mcp_client.ts';
import { getMcpLangChainTools } from '../services/mcp_tools.ts';
import { buildSumTransactionsTool, buildAnalyzeSpendingTool } from '../services/local_tools.ts';
import { config } from '../config/config.ts';
import { extractHtml } from './shared/html.ts';

// System prompt for the /generate-ui agent. It merges two responsibilities that
// used to live in separate nodes: (1) the data-authority rules from the /ask
// agent — the model fetches its OWN data with the tools and never does the
// arithmetic itself — and (2) the single-file HTML output rules that used to be
// in nodes/generate_html/prompts.ts. Preloaded category/subcategory/location
// lists let the model resolve names to ids without extra list-tool round-trips.
export const buildSystemPrompt = (
    date: string,
    categories: McpCategory[],
    subcategories: McpSubcategory[],
    locations: McpLocation[],
) => JSON.stringify({
    role:
        "Expert front-end engineer, designer, and personal finance analyst with direct access to the user's finance tools. You build a single self-contained HTML page that answers the request using ONLY real data you fetch yourself with those tools.",
    task:
        'Understand which page the user wants, call tools to gather the EXACT data needed (inspect each result before deciding the next call), then produce ONE complete, standalone HTML5 document that presents it in the design style the user asked for.',
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    sub_categories: subcategories.map((s) => ({ id: s.id, name: s.name })),
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
    tools_guidance: [
        'sum_transactions — authoritative EXACT total for a date range, overall and per category (also accepts subcategory_ids and description_query). Use it for any "how much / total / spending by category" figure. Never add up list_transactions rows yourself.',
        'analyze_spending — pre-computed comparison of the current (PARTIAL) month vs the last full month vs the trailing N-month monthly average, overall and per category, plus a run-rate projection. Use it for a breakdown of the current month, comparisons, trends, and projections.',
        'list_transactions — use only to show or inspect the individual rows behind a number; never total its rows yourself.',
        'The remaining MCP tools (list_categories, list_locations, get_biggest_transactions, etc.) are available for any other data the page needs.',
    ],
    data_rules: [
        `Today's date is ${date} — compute relative ranges (this month, last month) from it.`,
        'Date filters are ALWAYS explicit start_date/end_date in YYYY-MM-DD: "this month" means day 01 through the last day of the current month. There is no current-month shortcut flag.',
        'For ANY total or amount spent/earned — overall, per category, per subcategory, or per period — call sum_transactions or analyze_spending. Their numbers are computed in code and are authoritative. NEVER sum list_transactions rows yourself, and never invent, estimate, or compute a figure in your head.',
        'For a breakdown of the CURRENT month by category, prefer analyze_spending (its by_category current_month figures) or sum_transactions with this month\'s start/end dates.',
        'Resolve category/subcategory NAMES to numeric ids using the lists above (or the list tools) before filtering — never pass a name where an id is expected.',
        'Values ending in _formatted in tool results are already formatted — reproduce them verbatim.',
        'If a tool returns an error, adjust the arguments and retry once; if it still fails, render a small notice for that section instead of faking data.',
    ],
    output_rules: [
        'After gathering the data, your FINAL message must be ONLY the raw HTML document, starting with <!DOCTYPE html>. No markdown fences, no commentary before or after.',
        'The page must be fully self-contained: all CSS in <style>, all JS in <script>. No build steps.',
        'You MAY load libraries from CDN via <script src=...> or <link>: Chart.js (https://cdn.jsdelivr.net/npm/chart.js), anime.js, d3, Google Fonts. Nothing that requires a bundler. No external data fetches.',
        'Embed the data you fetched as a const DATA = {...} object in a script tag and render everything from it. Use ONLY the numbers and names present in that data — never invent, extrapolate, or fake data.',
        'Extract the visual/design style from the user request (e.g. "modern layout", "late 90s website", "animated", "brutalist", "colorful") and commit to it fully in layout, typography, colors, and any animations. A user-specified style ALWAYS takes priority over the default below and must be followed faithfully, even if it is loud or unconventional.',
        'If the user does NOT specify a style, default to a refined, modern product aesthetic inspired by Vercel, Langfuse, Apple, Linear and Stripe: clean sans-serif typography with clear hierarchy, generous whitespace and consistent spacing, restrained and tasteful use of color (mostly neutrals with a single accent), subtle depth (soft borders/shadows) and gentle microinteractions. Prefer a polished dark theme by default, but keep it legible and accessible. Keep it simple and elegant — never silly, cluttered, or gratuitously colorful.',
        'The page must render correctly inside an iframe: no top-level navigation, no external form posts, responsive to its container.',
        "Format ALL monetary values as Brazilian Reais with pt-BR formatting and the R$ prefix (e.g. R$ 1.234,56) — use new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }) in the generated JS. Never use $ or any other currency.",
        'Give the page a <title> derived from the request. Focus a lot on design and UX: the page should be easy to use and navigate, but also visually appealing and engaging.',
    ],
    refinement_rule:
        'If an earlier assistant turn in this conversation already produced a page (it appears as a full HTML document), treat the new request as an EDIT of that page: keep everything else identical — same data, layout, and styling — and change only what is asked (e.g. "make the title green"). Re-fetch data only if the new request needs different numbers. If the request clearly asks for a different page, build a new one from scratch.',
});

export type GenerateUiAgentResult = {
    html?: string;
    toolsUsed: string[];
    error?: string;
};

// Runs the agentic UI generation loop: the model calls the finance tools itself
// to fetch authoritative data, then emits a single self-contained HTML document
// as its final message. Mirrors graph/ask_agent.ts, but runs on the strong UI
// generation model and extracts an HTML document from the answer.
export async function runGenerateUiAgent(
    llmClient: OpenRouterService,
    mcpClient: McpClientService,
    input: { messages: BaseMessage[]; userId?: string; sessionId?: string },
): Promise<GenerateUiAgentResult> {
    console.log('🎨 Running generate-ui agent...');

    let tools;
    try {
        // sum_transactions and analyze_spending are local tools: every total,
        // comparison and projection is computed in code, never by the model.
        tools = [
            ...await getMcpLangChainTools(mcpClient),
            buildSumTransactionsTool(mcpClient),
            buildAnalyzeSpendingTool(mcpClient),
        ];
    } catch (error) {
        console.error('❌ Failed to discover MCP tools:', error);
        return {
            toolsUsed: [],
            error: "Sorry, I can't reach the finance service right now.",
        };
    }

    // Preload the lists so the model can resolve category/subcategory/location
    // names to ids without spending tool rounds on the list endpoints.
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
        // The UI page wants the strongest coding/design model and enough output
        // room for a full HTML document. A mid temperature keeps the design
        // lively (the old HTML step ran at 0.7) without hurting tool-arg
        // reliability, which the low agent default (0.2) would flatten.
        model: config.uiGenerationModel,
        maxTokens: 32000,
        temperature: 0.6,
        userId: input.userId,
        sessionId: input.sessionId,
        tags: ['generate-ui', 'agent'],
    });

    if (!result.success) {
        console.warn('⚠️  Generate-ui agent failed:', result.error);
        return { toolsUsed: result.toolsUsed, error: result.error };
    }

    const html = extractHtml(result.answer);
    if (!html) {
        console.warn('⚠️  Agent did not return an HTML document.');
        return { toolsUsed: result.toolsUsed, error: 'Model did not return an HTML document.' };
    }

    console.log(`✅ Generate-ui agent done (tools used: ${result.toolsUsed.join(', ') || 'none'})`);
    return { html, toolsUsed: result.toolsUsed };
}
