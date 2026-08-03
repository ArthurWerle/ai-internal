import { OpenRouterService } from '../services/open_router.ts';
import { McpClientService, type McpTransaction } from '../services/mcp_client.ts';
import { formatBRL } from '../lib/currency.ts';
import { config } from '../config/config.ts';
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
    role: 'Sharp personal-finance analyst writing a two-part spending insight: a one-line headline plus an expandable detailed breakdown.',
    task: 'From the pre-computed figures in the user message, write (1) a single headline stating the SINGLE most important finding, then (2) a short detailed analysis that surfaces the other notable, non-obvious findings the user would miss at a glance. You only choose, prioritise and phrase — every number is already computed for you.',
    method: [
        'The figures are authoritative and already scoped to the correct periods. NEVER recompute, re-add, estimate, or invent any number. Use only numbers that appear verbatim in the figures.',
        'All monetary values are pre-formatted as Brazilian Reais (R$) — reproduce them exactly as written, character for character (e.g. "R$ 906,47").',
        'The current month is PARTIAL. Never present it as a full month, and NEVER extrapolate, project, or guess a month-end / run-rate total — no projections of any kind.',
        'EARLY-MONTH RULE: when the figures carry an "early-month" notice (the current month just started), a category being low or unspent so far is EXPECTED simply because the month is young — this is obvious and must NEVER be reported as a finding (do not say things like "housing is low" or "no grocery spending yet"). Instead, base the insight on the LAST MONTH RETROSPECTIVE as a concrete, forward-looking heads-up (e.g. "Last month, {category} ran {X%} above its average — worth keeping an eye on it this month."). You may still call out a current-month item only if it is genuinely notable on its own, such as a large one-off purchase already made.',
        'Prioritise the finding with the biggest financial impact for the headline; put the supporting movers and any new / no-spend-yet categories in the details.',
        'Be an analyst, not a reporter: for each point say what changed, why it matters, and (when negative) a short, concrete nudge the user could not easily spot alone.',
    ],
    output_rules: [
        'Output format, EXACTLY: first line = the headline. Then ONE blank line. Then the detailed analysis as markdown. Nothing before the headline (no label, no quotes).',
        'Headline: one sentence, ~20 words max, plain text (no markdown), must stand alone in a slim header. Cite a concrete R$ value or percentage.',
        'Details: 2-5 short markdown bullets (each starting with "- "). Optionally a bold lead-in per bullet, e.g. "- **Groceries**: down 23% vs last month, about R$ 420,00 saved.". Keep each bullet to 1-2 sentences. No headings, no tables, no preamble.',
        'Cite concrete R$ values and/or percentages taken verbatim from the figures in both parts.',
        'Keep category names exactly as they appear in the figures (do not translate them).',
        'Warm, direct tone. Write everything (headline and details) in this language: {language}.',
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

export type SpendingFacts = { text: string; hasData: boolean; mode: 'early' | 'normal' };

export async function buildSpendingFacts(mcpClient: McpClientService, now: Date): Promise<SpendingFacts> {
    const today = nowInReportingTz(now);
    const current: YearMonth = { year: today.year, month: today.month };
    const previous = addMonths(current, -1);

    // The 6 completed months before the current one form the current-month
    // baseline. For the last-month retrospective we want an average that does
    // NOT include last month itself, so we also keep the 6 months before LAST
    // month — hence the history window reaches back one extra month.
    const baselineKeys: string[] = [];
    for (let i = BASELINE_MONTHS; i >= 1; i--) {
        baselineKeys.push(monthKey(addMonths(current, -i)));
    }
    const priorBaselineKeys: string[] = [];
    for (let i = BASELINE_MONTHS + 1; i >= 2; i--) {
        priorBaselineKeys.push(monthKey(addMonths(current, -i)));
    }
    const historyStart = monthStart(addMonths(current, -(BASELINE_MONTHS + 1)));
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

    // Monthly average per category over a set of month keys: total over the
    // window / number of months (months with no spend count as zero, which is
    // what a monthly average should do).
    const averageOver = (keys: string[]): Map<number, number> => {
        const acc = new Map<number, number>();
        for (const key of keys) {
            const bucket = historyByMonthCat.get(key);
            if (!bucket) continue;
            for (const [cid, total] of bucket) {
                acc.set(cid, (acc.get(cid) ?? 0) + total);
            }
        }
        for (const [cid, total] of acc) acc.set(cid, total / keys.length);
        return acc;
    };
    const totalAverageOver = (keys: string[]): number =>
        keys.reduce((sum, key) => {
            const bucket = historyByMonthCat.get(key);
            if (!bucket) return sum;
            return sum + [...bucket.values()].reduce((a, b) => a + b, 0);
        }, 0) / keys.length;

    const baselineByCat = averageOver(baselineKeys);
    const priorBaselineByCat = averageOver(priorBaselineKeys);

    const currentTotal = [...currentByCat.values()].reduce((a, b) => a + b, 0);
    const lastMonthTotal = [...lastMonthByCat.values()].reduce((a, b) => a + b, 0);
    const baselineTotal = totalAverageOver(baselineKeys);
    const priorBaselineTotal = totalAverageOver(priorBaselineKeys);

    if (currentByCat.size === 0 && lastMonthByCat.size === 0 && baselineByCat.size === 0) {
        return { text: '', hasData: false, mode: 'normal' };
    }

    // Right after a month rolls over there is nothing meaningful to say about
    // the current month: every category looks "low" or "unspent" simply because
    // the month just started, which is obvious rather than a finding. When it is
    // both early in the month AND little has been spent, pivot to a last-month
    // retrospective instead of judging the partial current month.
    const isEarlyMonth = today.day <= config.insightsEarlyMonthMaxDays &&
        currentTotal < config.insightsEarlyMonthSpendFraction * baselineTotal;

    const biggestTransactions = (txs: McpTransaction[], n: number): McpTransaction[] =>
        [...txs]
            .filter((t) => expenseAmount(t) > 0)
            .sort((a, b) => expenseAmount(b) - expenseAmount(a))
            .slice(0, n);
    const txLine = (t: McpTransaction): string => {
        const cid = categoryIdOf(t);
        const cat = cid != null ? ` [${nameOf(cid)}]` : '';
        return `${descriptionOf(t)}: ${formatBRL(expenseAmount(t))}${cat}`;
    };

    if (isEarlyMonth) {
        return buildEarlyMonthFacts({
            current,
            previous,
            dayOfMonth: today.day,
            currentTotal,
            lastMonthTotal,
            priorBaselineTotal,
            currentByCat,
            lastMonthByCat,
            baselineByCat,
            priorBaselineByCat,
            currentTx,
            historyTx,
            nameOf,
            biggestTransactions,
            txLine,
        });
    }

    const catIds = new Set<number>([
        ...currentByCat.keys(),
        ...lastMonthByCat.keys(),
        ...baselineByCat.keys(),
    ]);
    const allRows = [...catIds].map((cid) => ({
        name: nameOf(cid),
        current: currentByCat.get(cid) ?? 0,
        lastMonth: lastMonthByCat.get(cid) ?? 0,
        baseline: baselineByCat.get(cid) ?? 0,
    }));

    // Rank by whichever of current/baseline is larger, so both spikes and
    // stopped-spending categories can surface as the notable finding.
    const rows = [...allRows]
        .sort((a, b) => Math.max(b.current, b.baseline) - Math.max(a.current, a.baseline))
        .slice(0, MAX_CATEGORY_ROWS);

    // Pre-computed movers/new/no-spend lists so the model can surface non-obvious
    // changes WITHOUT doing any arithmetic itself (that rule exists for a reason —
    // see the note at the top of this file).
    const MOVER_ROWS = 3;
    const increases = allRows
        .filter((r) => r.current - r.lastMonth > 0.005)
        .sort((a, b) => b.current - b.lastMonth - (a.current - a.lastMonth))
        .slice(0, MOVER_ROWS);
    const decreases = allRows
        .filter((r) => r.current - r.lastMonth < -0.005)
        .sort((a, b) => a.current - a.lastMonth - (b.current - b.lastMonth))
        .slice(0, MOVER_ROWS);
    const newCategories = allRows.filter((r) => r.current > 0 && r.lastMonth === 0 && r.baseline === 0);
    const noSpendYet = allRows
        .filter((r) => r.current === 0 && r.baseline > 0)
        .sort((a, b) => b.baseline - a.baseline)
        .slice(0, MOVER_ROWS);

    const biggest = biggestTransactions(currentTx, 3);

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

    if (increases.length > 0) {
        lines.push('');
        lines.push('BIGGEST INCREASES VS LAST FULL MONTH');
        for (const r of increases) {
            lines.push(
                `- ${r.name}: this month ${formatBRL(r.current)} vs last month ${formatBRL(r.lastMonth)}` +
                    ` (${pctChange(r.current, r.lastMonth)})`,
            );
        }
    }
    if (decreases.length > 0) {
        lines.push('');
        lines.push('BIGGEST DECREASES VS LAST FULL MONTH (may partly reflect the partial month)');
        for (const r of decreases) {
            lines.push(
                `- ${r.name}: this month ${formatBRL(r.current)} vs last month ${formatBRL(r.lastMonth)}` +
                    ` (${pctChange(r.current, r.lastMonth)})`,
            );
        }
    }
    if (newCategories.length > 0) {
        lines.push('');
        lines.push('NEW THIS MONTH (spending with no last-month or 6-month-average history)');
        for (const r of newCategories) {
            lines.push(`- ${r.name}: ${formatBRL(r.current)}`);
        }
    }
    if (noSpendYet.length > 0) {
        lines.push('');
        lines.push('NO SPEND YET THIS MONTH (categories that usually have spend by their 6-month average)');
        for (const r of noSpendYet) {
            lines.push(`- ${r.name}: 6-mo avg ${formatBRL(r.baseline)}`);
        }
    }

    if (biggest.length > 0) {
        lines.push('');
        lines.push('BIGGEST TRANSACTIONS THIS MONTH');
        for (const t of biggest) {
            lines.push(`- ${txLine(t)}`);
        }
    }

    return { text: lines.join('\n'), hasData: true, mode: 'normal' };
}

type EarlyMonthArgs = {
    current: YearMonth;
    previous: YearMonth;
    dayOfMonth: number;
    currentTotal: number;
    lastMonthTotal: number;
    priorBaselineTotal: number;
    currentByCat: Map<number, number>;
    lastMonthByCat: Map<number, number>;
    baselineByCat: Map<number, number>;
    priorBaselineByCat: Map<number, number>;
    currentTx: McpTransaction[];
    historyTx: McpTransaction[];
    nameOf: (cid: number) => string;
    biggestTransactions: (txs: McpTransaction[], n: number) => McpTransaction[];
    txLine: (t: McpTransaction) => string;
};

// Early in the month there is nothing meaningful to judge about the current
// month, so the facts deliberately WITHHOLD the misleading partial-vs-full
// comparisons (no "% vs average", no "no spend yet") and instead hand the model
// a last-month retrospective to turn into a forward-looking heads-up. Any
// genuinely notable current-month item (a big one-off already made) still gets
// through as information.
function buildEarlyMonthFacts(a: EarlyMonthArgs): SpendingFacts {
    const RETRO_ROWS = 3;

    // Brand-new categories with real spend this month are worth flagging even
    // this early — they are concrete events, not an absence.
    const newThisMonth = [...a.currentByCat.entries()]
        .filter(([cid, total]) => total > 0 && !(a.lastMonthByCat.get(cid) ?? 0) && !(a.baselineByCat.get(cid) ?? 0))
        .map(([cid, total]) => ({ name: a.nameOf(cid), total }));

    // Categories where last month most exceeded its own 6-month average — the
    // basis for "watch out this month" guidance.
    const retroCatIds = new Set<number>([...a.lastMonthByCat.keys(), ...a.priorBaselineByCat.keys()]);
    const lastMonthVsAvg = [...retroCatIds]
        .map((cid) => ({
            name: a.nameOf(cid),
            lastMonth: a.lastMonthByCat.get(cid) ?? 0,
            avg: a.priorBaselineByCat.get(cid) ?? 0,
        }))
        .filter((r) => r.lastMonth > 0)
        .sort((x, y) => (y.lastMonth - y.avg) - (x.lastMonth - x.avg))
        .slice(0, RETRO_ROWS);

    const lines: string[] = [];
    lines.push(
        `Reporting period: ${monthKey(a.current)} — the CURRENT month, which has just BEGUN (${a.dayOfMonth} day(s) elapsed).`,
    );
    lines.push(
        'EARLY-MONTH NOTICE: it is too early to judge current-month spending. A category being low or unspent this early is EXPECTED and must NOT be reported as a finding. Base the insight on the LAST MONTH RETROSPECTIVE below as a heads-up for the month ahead; only mention a current-month item if it is genuinely notable on its own.',
    );
    lines.push('All amounts are in Brazilian Reais (R$) and already formatted. Reproduce them verbatim.');
    lines.push('');
    lines.push('CURRENT MONTH SO FAR (informational only — do NOT frame low or absent spend as a finding)');
    lines.push(`- Spent so far this month: ${formatBRL(a.currentTotal)}`);
    if (newThisMonth.length > 0) {
        lines.push('- New spending this month (no history):');
        for (const r of newThisMonth) lines.push(`  - ${r.name}: ${formatBRL(r.total)}`);
    }
    const currentBiggest = a.biggestTransactions(a.currentTx, 3);
    if (currentBiggest.length > 0) {
        lines.push('- Biggest transactions so far this month:');
        for (const t of currentBiggest) lines.push(`  - ${a.txLine(t)}`);
    }
    lines.push('');
    lines.push(
        `LAST MONTH RETROSPECTIVE (${monthKey(a.previous)} — the most recent COMPLETE month; use this as the basis for a forward-looking heads-up)`,
    );
    lines.push(
        `- Last month total: ${formatBRL(a.lastMonthTotal)} vs its 6-month average ${formatBRL(a.priorBaselineTotal)} (${pctChange(a.lastMonthTotal, a.priorBaselineTotal)})`,
    );
    if (lastMonthVsAvg.length > 0) {
        lines.push('- Categories last month vs their 6-month average (biggest gaps first):');
        for (const r of lastMonthVsAvg) {
            lines.push(`  - ${r.name}: ${formatBRL(r.lastMonth)} vs avg ${formatBRL(r.avg)} (${pctChange(r.lastMonth, r.avg)})`);
        }
    }
    const lastMonthTx = a.historyTx.filter((t) => monthKeyOf(t) === monthKey(a.previous));
    const lastMonthBiggest = a.biggestTransactions(lastMonthTx, 3);
    if (lastMonthBiggest.length > 0) {
        lines.push('- Biggest transactions last month:');
        for (const t of lastMonthBiggest) lines.push(`  - ${a.txLine(t)}`);
    }

    return { text: lines.join('\n'), hasData: true, mode: 'early' };
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
        {
            sessionId: options?.sessionId,
            tags: ['insights-endpoint', 'compute-then-phrase'],
            model: config.insightsModel,
            maxTokens: config.insightsMaxTokens,
        },
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
