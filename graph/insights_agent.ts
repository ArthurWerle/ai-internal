import { OpenRouterService } from '../services/open_router.ts';
import { McpClientService, type McpTransaction } from '../services/mcp_client.ts';
import { formatBRL } from '../lib/currency.ts';
import {
    type YearMonth,
    addMonths,
    categoryIdOf,
    expenseAmount,
    fetchAllTransactions,
    monthEnd,
    monthKey,
    monthStart,
    nowInReportingTz,
    sumByCategory,
} from '../lib/transactions.ts';

// The insight text is short and the numbers are already computed in code, so
// the model only has to CHOOSE the most meaningful finding and phrase it — it
// must never do arithmetic. Delegating the math to the model is exactly what
// caused wildly wrong figures (e.g. a ~7-month Travel total reported as "this
// month"); see api/rest/report_insights.ts for the same compute-then-narrate
// pattern.
const SYSTEM_PROMPT = JSON.stringify({
    role: 'Sharp personal-finance analyst writing ONE insight for a slim app header.',
    task: 'Pick the SINGLE most meaningful finding from the pre-computed figures in the user message and phrase it as one short insight. You only choose and phrase — every number is already computed for you.',
    method: [
        'The figures are authoritative and already scoped to the correct periods. NEVER recompute, re-add, estimate, or invent any number.',
        'All monetary values are pre-formatted as Brazilian Reais (R$) — reproduce them exactly as written, character for character (e.g. "R$ 906,47").',
        'The current month is PARTIAL. Never present it as a full month, and when you compare it against a full month or the 6-month average, make the partial nature clear.',
        'Prefer a specific category with a notable change (a spike or a saving) over a generic total. Use a biggest-transaction detail only to explain a spike.',
    ],
    output_rules: [
        'Return ONLY the insight text — no preamble, no markdown, no surrounding quotes.',
        '1-2 sentences, maximum ~45 words. It must fit in a slim app header.',
        'Cite concrete R$ values and/or percentages taken verbatim from the figures.',
        'Be an analyst, not a reporter: say what changed, why it matters, and (when negative) a short nudge to pay attention.',
        'Warm, direct tone. Examples of the expected style: "Nice work — Groceries are down 23% vs last month, about R$ 420,00 saved." / "Heads up: Car costs are 15% above their 6-month average. Anything unusual? Keep an eye on it."',
        'Keep category names exactly as they appear in the figures (do not translate them).',
        'Write in this language: {language}.',
    ],
});

export type InsightsAgentResult = {
    insight: string;
    toolsUsed: string[];
    error?: string;
};

const MAX_CATEGORY_ROWS = 10;
const BASELINE_MONTHS = 6;

function monthKeyOf(t: McpTransaction): string | null {
    const raw = (t as any).date ?? (t as any).created_at;
    return typeof raw === 'string' && raw.length >= 7 ? raw.slice(0, 7) : null;
}

function descriptionOf(t: McpTransaction): string {
    const raw = (t as any).description;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : '(no description)';
}

// { monthKey -> { categoryId -> total } }
function sumByMonthAndCategory(transactions: McpTransaction[]): Map<string, Map<number, number>> {
    const byMonth = new Map<string, Map<number, number>>();
    for (const t of transactions) {
        const amount = expenseAmount(t);
        if (amount === 0) continue;
        const cid = categoryIdOf(t);
        const mk = monthKeyOf(t);
        if (cid == null || mk == null) continue;
        const bucket = byMonth.get(mk) ?? new Map<number, number>();
        bucket.set(cid, (bucket.get(cid) ?? 0) + amount);
        byMonth.set(mk, bucket);
    }
    return byMonth;
}

function pctChange(current: number, base: number): string {
    if (base <= 0) return current > 0 ? 'new (no baseline)' : 'no change';
    const pct = Math.round(((current - base) / base) * 100);
    return `${pct > 0 ? '+' : ''}${pct}%`;
}

type SpendingFacts = { text: string; hasData: boolean };

async function buildSpendingFacts(mcpClient: McpClientService, now: Date): Promise<SpendingFacts> {
    const today = nowInReportingTz(now);
    const current: YearMonth = { year: today.year, month: today.month };
    const previous = addMonths(current, -1);

    // The 6 completed months before the current one form the baseline window.
    const baselineKeys: string[] = [];
    for (let i = BASELINE_MONTHS; i >= 1; i--) {
        baselineKeys.push(monthKey(addMonths(current, -i)));
    }
    const historyStart = monthStart(addMonths(current, -BASELINE_MONTHS));
    const historyEnd = monthEnd(previous);

    // Fetch with explicit start/end dates — never the current_month flag: the
    // backend silently ignored it, returning the ENTIRE history as "this
    // month" (e.g. Moradia at R$ 115k / +2320%).
    const [currentTx, historyTx, categories] = await Promise.all([
        fetchAllTransactions(mcpClient, { type: 'expense', start_date: monthStart(current), end_date: monthEnd(current) }),
        fetchAllTransactions(mcpClient, { type: 'expense', start_date: historyStart, end_date: historyEnd }),
        mcpClient.listCategories(),
    ]);

    const categoryName = new Map<number, string>();
    for (const c of categories) categoryName.set(c.id, c.name);
    const nameOf = (cid: number) => categoryName.get(cid) ?? `Category ${cid}`;

    const currentByCat = sumByCategory(currentTx);
    const historyByMonthCat = sumByMonthAndCategory(historyTx);
    const lastMonthByCat = historyByMonthCat.get(monthKey(previous)) ?? new Map<number, number>();

    // 6-month monthly average per category: total over the window / 6 (months
    // with no spend count as zero, which is what a monthly average should do).
    const baselineByCat = new Map<number, number>();
    for (const key of baselineKeys) {
        const bucket = historyByMonthCat.get(key);
        if (!bucket) continue;
        for (const [cid, total] of bucket) {
            baselineByCat.set(cid, (baselineByCat.get(cid) ?? 0) + total);
        }
    }
    for (const [cid, total] of baselineByCat) {
        baselineByCat.set(cid, total / BASELINE_MONTHS);
    }

    const currentTotal = [...currentByCat.values()].reduce((a, b) => a + b, 0);
    const lastMonthTotal = [...lastMonthByCat.values()].reduce((a, b) => a + b, 0);
    const baselineTotal = baselineKeys.reduce((acc, key) => {
        const bucket = historyByMonthCat.get(key);
        if (!bucket) return acc;
        return acc + [...bucket.values()].reduce((a, b) => a + b, 0);
    }, 0) / BASELINE_MONTHS;

    if (currentByCat.size === 0 && lastMonthByCat.size === 0 && baselineByCat.size === 0) {
        return { text: '', hasData: false };
    }

    const catIds = new Set<number>([
        ...currentByCat.keys(),
        ...lastMonthByCat.keys(),
        ...baselineByCat.keys(),
    ]);
    const rows = [...catIds]
        .map((cid) => ({
            name: nameOf(cid),
            current: currentByCat.get(cid) ?? 0,
            lastMonth: lastMonthByCat.get(cid) ?? 0,
            baseline: baselineByCat.get(cid) ?? 0,
        }))
        // Rank by whichever of current/baseline is larger, so both spikes and
        // stopped-spending categories can surface as the notable finding.
        .sort((a, b) => Math.max(b.current, b.baseline) - Math.max(a.current, a.baseline))
        .slice(0, MAX_CATEGORY_ROWS);

    const biggest = [...currentTx]
        .filter((t) => expenseAmount(t) > 0)
        .sort((a, b) => expenseAmount(b) - expenseAmount(a))
        .slice(0, 3);

    const lines: string[] = [];
    lines.push(
        `Reporting period: ${monthKey(current)} — the CURRENT month, still PARTIAL (${today.day} day(s) elapsed).`,
    );
    lines.push('All amounts are in Brazilian Reais (R$) and already formatted. Reproduce them verbatim.');
    lines.push('');
    lines.push('OVERALL EXPENSES');
    lines.push(`- This month so far: ${formatBRL(currentTotal)}`);
    lines.push(`- Last full month (${monthKey(previous)}): ${formatBRL(lastMonthTotal)}`);
    lines.push(`- 6-month monthly average: ${formatBRL(baselineTotal)}`);
    lines.push('');
    lines.push('BY CATEGORY (this month so far vs last full month vs 6-month monthly average)');
    for (const r of rows) {
        lines.push(
            `- ${r.name}: this month ${formatBRL(r.current)}` +
                ` | last month ${formatBRL(r.lastMonth)}` +
                ` | 6-mo avg ${formatBRL(r.baseline)}` +
                ` | vs 6-mo avg ${pctChange(r.current, r.baseline)}` +
                ` | vs last month ${pctChange(r.current, r.lastMonth)}`,
        );
    }
    if (biggest.length > 0) {
        lines.push('');
        lines.push('BIGGEST TRANSACTIONS THIS MONTH');
        for (const t of biggest) {
            const cid = categoryIdOf(t);
            const cat = cid != null ? ` [${nameOf(cid)}]` : '';
            lines.push(`- ${descriptionOf(t)}: ${formatBRL(expenseAmount(t))}${cat}`);
        }
    }

    return { text: lines.join('\n'), hasData: true };
}

export async function runInsightsAgent(
    llmClient: OpenRouterService,
    mcpClient: McpClientService,
    options?: { language?: string; sessionId?: string },
): Promise<InsightsAgentResult> {
    console.log('📊 Building spending insight from computed figures...');

    const language = options?.language ?? 'en';
    const toolsUsed = ['list_transactions', 'list_categories'];

    let facts: SpendingFacts;
    try {
        facts = await buildSpendingFacts(mcpClient, new Date());
    } catch (error) {
        console.error('❌ Failed to gather spending data:', error);
        return {
            insight: '',
            toolsUsed,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    if (!facts.hasData) {
        console.warn('⚠️  No spending data available for the insight.');
        return { insight: '', toolsUsed, error: 'no spending data available' };
    }

    const result = await llmClient.generateText(
        SYSTEM_PROMPT.replace('{language}', language),
        facts.text,
        { sessionId: options?.sessionId, tags: ['insights-endpoint', 'compute-then-phrase'] },
    );

    if (!result.success || !result.data.trim()) {
        console.warn('⚠️  Insight phrasing failed:', result.success ? 'empty response' : result.error);
        return {
            insight: '',
            toolsUsed,
            error: (result.success ? undefined : result.error) ?? 'insight generation returned empty text',
        };
    }

    console.log('✅ Insight ready.');
    return { insight: result.data.trim(), toolsUsed };
}
