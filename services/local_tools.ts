import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod/v3';
import type { McpClientService } from './mcp_client.ts';
import { formatBRL } from '../lib/currency.ts';
import {
    type YearMonth,
    addMonths,
    amountForType,
    categoryIdOf,
    descriptionOf,
    expenseAmount,
    fetchAllTransactions,
    monthEnd,
    monthKey,
    monthKeyOf,
    monthStart,
    nowInReportingTz,
    subcategoryIdOf,
    sumByCategory,
    REPORTING_TIMEZONE,
} from '../lib/transactions.ts';

// Local (non-MCP) tools that compute transaction math in code. The model must
// never do the arithmetic itself — LLM arithmetic over dozens of rows produced
// wildly different totals for the same question (see graph/insights_agent.ts for
// the same compute-then-narrate rule).

const SumTransactionsSchema = z.object({
    start_date: z.string().describe('Inclusive period start, YYYY-MM-DD. "This month" starts on day 01 of the current month.'),
    end_date: z.string().describe('Inclusive period end, YYYY-MM-DD. "This month" ends on the last day of the current month.'),
    category_ids: z
        .array(z.number())
        .optional()
        .describe('Numeric category ids to include (resolve names via the categories list). Omit to include ALL categories.'),
    subcategory_ids: z
        .array(z.number())
        .optional()
        .describe('Numeric subcategory ids to include (resolve names via the sub_categories list). Omit to include ALL subcategories.'),
    description_query: z
        .string()
        .optional()
        .describe('Case-insensitive substring matched against each transaction description. Use it to total a subset identified by wording rather than by category — e.g. description_query "gasolina" to sum only fuel rows inside the Carro category. The match and the sum are computed in code, so the total stays authoritative.'),
    type: z.enum(['expense', 'income']).optional().describe("Which side to sum. Defaults to 'expense'."),
});

export function buildSumTransactionsTool(mcpClient: McpClientService): StructuredToolInterface {
    return tool(
        async (input) => {
            const args = input as z.infer<typeof SumTransactionsSchema>;
            const type = args.type ?? 'expense';
            try {
                const [transactions, categories] = await Promise.all([
                    fetchAllTransactions(mcpClient, {
                        type,
                        start_date: args.start_date,
                        end_date: args.end_date,
                    }),
                    mcpClient.listCategories(),
                ]);

                const wanted = args.category_ids?.length ? new Set(args.category_ids) : null;
                const wantedSub = args.subcategory_ids?.length ? new Set(args.subcategory_ids) : null;
                const descNeedle = args.description_query?.trim().toLowerCase() || null;
                const byCategory = new Map<number | null, { total: number; count: number }>();
                let total = 0;
                let count = 0;
                for (const t of transactions) {
                    const amount = amountForType(t, type);
                    if (amount === 0) continue;
                    const cid = categoryIdOf(t);
                    if (wanted && (cid == null || !wanted.has(cid))) continue;
                    if (wantedSub) {
                        const sid = subcategoryIdOf(t);
                        if (sid == null || !wantedSub.has(sid)) continue;
                    }
                    if (descNeedle && !descriptionOf(t).toLowerCase().includes(descNeedle)) continue;
                    total += amount;
                    count += 1;
                    const entry = byCategory.get(cid) ?? { total: 0, count: 0 };
                    entry.total += amount;
                    entry.count += 1;
                    byCategory.set(cid, entry);
                }

                const categoryName = new Map(categories.map((c) => [c.id, c.name]));
                const by_category = [...byCategory.entries()]
                    .map(([cid, entry]) => ({
                        category_id: cid,
                        category_name: cid == null ? '(uncategorized)' : categoryName.get(cid) ?? `Category ${cid}`,
                        total: entry.total,
                        total_formatted: formatBRL(entry.total),
                        transaction_count: entry.count,
                    }))
                    .sort((a, b) => b.total - a.total);

                return JSON.stringify({
                    type,
                    start_date: args.start_date,
                    end_date: args.end_date,
                    ...(args.category_ids?.length ? { category_ids: args.category_ids } : {}),
                    ...(args.subcategory_ids?.length ? { subcategory_ids: args.subcategory_ids } : {}),
                    ...(descNeedle ? { description_query: args.description_query } : {}),
                    total,
                    total_formatted: formatBRL(total),
                    transaction_count: count,
                    by_category,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return `Error calling sum_transactions: ${message.substring(0, 300)}`;
            }
        },
        {
            name: 'sum_transactions',
            description:
                'Compute the EXACT total of transactions for a date range, overall and per category. Pages through every matching transaction and sums in code, so the returned numbers are authoritative. Optional filters, all applied in code: category_ids, subcategory_ids, and description_query (a case-insensitive substring on the description — e.g. "gasolina" to total only fuel rows). ALWAYS use this for any question about totals or amounts spent/earned ("how much", "total", "sum", "spending by category", "how much on X"). Never add up list_transactions rows yourself.',
            schema: SumTransactionsSchema,
        },
    );
}

const AnalyzeSpendingSchema = z.object({
    months_back: z
        .number()
        .int()
        .min(1)
        .max(24)
        .optional()
        .describe('How many COMPLETED months before the current (partial) month to include as the comparison baseline. Defaults to 6.'),
    category_ids: z
        .array(z.number())
        .optional()
        .describe('Restrict the analysis to these numeric category ids. Omit to analyze all categories.'),
});

function pctChange(current: number, base: number): string {
    if (base <= 0) return current > 0 ? 'new (no baseline)' : 'no change';
    const pct = Math.round(((current - base) / base) * 100);
    return `${pct > 0 ? '+' : ''}${pct}%`;
}

// Local tool: pre-computes a month-over-month spending comparison and a run-rate
// projection for the current (partial) month, overall and per category. Every
// number is summed in code from paged transactions, so the model only has to
// interpret the figures — it must never recompute or estimate them. Mirrors the
// compute-then-narrate approach of graph/insights_agent.ts.
export function buildAnalyzeSpendingTool(mcpClient: McpClientService): StructuredToolInterface {
    return tool(
        async (input) => {
            const args = input as z.infer<typeof AnalyzeSpendingSchema>;
            const monthsBack = args.months_back ?? 6;
            const wanted = args.category_ids?.length ? new Set(args.category_ids) : null;
            try {
                const today = nowInReportingTz(new Date());
                const current: YearMonth = { year: today.year, month: today.month };
                const previous = addMonths(current, -1);

                // The N completed months before the current one form the baseline.
                const baselineKeys: string[] = [];
                for (let i = monthsBack; i >= 1; i--) baselineKeys.push(monthKey(addMonths(current, -i)));
                const historyStart = monthStart(addMonths(current, -monthsBack));
                const historyEnd = monthEnd(previous);

                // Explicit start/end dates only — the backend ignores current_month
                // and returns the entire history (see lib/transactions.ts).
                const [currentTx, historyTx, categories] = await Promise.all([
                    fetchAllTransactions(mcpClient, { type: 'expense', start_date: monthStart(current), end_date: monthEnd(current) }),
                    fetchAllTransactions(mcpClient, { type: 'expense', start_date: historyStart, end_date: historyEnd }),
                    mcpClient.listCategories(),
                ]);

                const inScope = (t: (typeof currentTx)[number]) => {
                    if (!wanted) return true;
                    const cid = categoryIdOf(t);
                    return cid != null && wanted.has(cid);
                };
                const scopedCurrent = currentTx.filter(inScope);
                const scopedHistory = historyTx.filter(inScope);

                const categoryName = new Map(categories.map((c) => [c.id, c.name]));
                const nameOf = (cid: number) => categoryName.get(cid) ?? `Category ${cid}`;

                // Per-month, per-category totals across the baseline window.
                const byMonthCat = new Map<string, Map<number, number>>();
                for (const t of scopedHistory) {
                    const amount = expenseAmount(t);
                    if (amount === 0) continue;
                    const cid = categoryIdOf(t);
                    const mk = monthKeyOf(t);
                    if (cid == null || mk == null) continue;
                    const bucket = byMonthCat.get(mk) ?? new Map<number, number>();
                    bucket.set(cid, (bucket.get(cid) ?? 0) + amount);
                    byMonthCat.set(mk, bucket);
                }

                const currentByCat = sumByCategory(scopedCurrent);
                const lastMonthByCat = byMonthCat.get(monthKey(previous)) ?? new Map<number, number>();

                // 6-month monthly average per category: total over the window / N
                // (months with no spend count as zero, as a monthly average should).
                const baselineByCat = new Map<number, number>();
                for (const key of baselineKeys) {
                    const bucket = byMonthCat.get(key);
                    if (!bucket) continue;
                    for (const [cid, tot] of bucket) baselineByCat.set(cid, (baselineByCat.get(cid) ?? 0) + tot);
                }
                for (const [cid, tot] of baselineByCat) baselineByCat.set(cid, tot / monthsBack);

                const sumValues = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
                const currentTotal = sumValues(currentByCat);
                const lastMonthTotal = sumValues(lastMonthByCat);
                const baselineTotal = baselineKeys.reduce((acc, key) => acc + sumValues(byMonthCat.get(key) ?? new Map()), 0) / monthsBack;

                // Run-rate projection for the current partial month.
                const daysInMonth = new Date(Date.UTC(current.year, current.month, 0)).getUTCDate();
                const daysElapsed = Math.max(1, today.day);
                const projectedTotal = (currentTotal / daysElapsed) * daysInMonth;

                const monthlyTotals = [...baselineKeys, monthKey(current)].map((key) => {
                    const isCurrent = key === monthKey(current);
                    const total = isCurrent ? currentTotal : sumValues(byMonthCat.get(key) ?? new Map());
                    return { month: key, partial: isCurrent, total, total_formatted: formatBRL(total) };
                });

                const catIds = new Set<number>([...currentByCat.keys(), ...lastMonthByCat.keys(), ...baselineByCat.keys()]);
                const byCategory = [...catIds]
                    .map((cid) => {
                        const cur = currentByCat.get(cid) ?? 0;
                        const last = lastMonthByCat.get(cid) ?? 0;
                        const base = baselineByCat.get(cid) ?? 0;
                        return {
                            category_id: cid,
                            category_name: nameOf(cid),
                            current_month: cur,
                            current_month_formatted: formatBRL(cur),
                            last_full_month: last,
                            last_full_month_formatted: formatBRL(last),
                            baseline_monthly_avg: base,
                            baseline_monthly_avg_formatted: formatBRL(base),
                            pct_vs_last_month: pctChange(cur, last),
                            pct_vs_baseline: pctChange(cur, base),
                        };
                    })
                    .sort((a, b) => Math.max(b.current_month, b.baseline_monthly_avg) - Math.max(a.current_month, a.baseline_monthly_avg));

                return JSON.stringify({
                    reporting_timezone: REPORTING_TIMEZONE,
                    note: 'The current month is PARTIAL. projected_total is a run-rate estimate, not an actual figure.',
                    current_month: {
                        month: monthKey(current),
                        partial: true,
                        days_elapsed: daysElapsed,
                        days_in_month: daysInMonth,
                        total: currentTotal,
                        total_formatted: formatBRL(currentTotal),
                        projected_total: projectedTotal,
                        projected_total_formatted: formatBRL(projectedTotal),
                    },
                    last_full_month: {
                        month: monthKey(previous),
                        total: lastMonthTotal,
                        total_formatted: formatBRL(lastMonthTotal),
                    },
                    baseline: {
                        months: baselineKeys,
                        monthly_average_total: baselineTotal,
                        monthly_average_total_formatted: formatBRL(baselineTotal),
                    },
                    monthly_totals: monthlyTotals,
                    by_category: byCategory,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return `Error calling analyze_spending: ${message.substring(0, 300)}`;
            }
        },
        {
            name: 'analyze_spending',
            description:
                'Pre-computed spending analysis for the current (PARTIAL) month vs the last full month vs the trailing N-month monthly average, overall and per category, plus a run-rate projection for the current month. All figures are summed in code and authoritative — use this for comparisons across months, trends, spikes/savings, "where is my money going", and projections. Interpret the returned numbers; never recompute them.',
            schema: AnalyzeSpendingSchema,
        },
    );
}
