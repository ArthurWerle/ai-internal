import type { McpClientService, McpTransaction } from '../services/mcp_client.ts';

// Shared transaction math used by the insights agent and the ask agent's
// sum_transactions tool. Totals must always be computed here, in code — never
// by the model (see graph/insights_agent.ts for the incident that rule comes
// from).

export const REPORTING_TIMEZONE = process.env.REPORTING_TIMEZONE ?? 'America/Sao_Paulo';
export const PAGE_SIZE = 1000;

export type YearMonth = { year: number; month: number };

// Today's calendar date as seen in the reporting timezone, so month edges line
// up with how the transactions service buckets dates.
export function nowInReportingTz(date: Date): { year: number; month: number; day: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: REPORTING_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return { year: get('year'), month: get('month'), day: get('day') };
}

export function monthKey({ year, month }: YearMonth): string {
    return `${year}-${String(month).padStart(2, '0')}`;
}

export function monthStart(ym: YearMonth): string {
    return `${monthKey(ym)}-01`;
}

export function monthEnd(ym: YearMonth): string {
    // Day 0 of the next month is the last day of this month (month is 1-based).
    const lastDay = new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
    return `${monthKey(ym)}-${String(lastDay).padStart(2, '0')}`;
}

export function addMonths(ym: YearMonth, delta: number): YearMonth {
    const index = ym.year * 12 + (ym.month - 1) + delta;
    return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

// Absolute amount of a transaction when it matches the given side, 0 otherwise
// — refunds/income can never silently shift an expense total (and vice versa).
export function amountForType(t: McpTransaction, type: 'income' | 'expense'): number {
    if (String(t.type) !== type) return 0;
    const n = Number(t.amount);
    return Number.isFinite(n) ? Math.abs(n) : 0;
}

export function expenseAmount(t: McpTransaction): number {
    return amountForType(t, 'expense');
}

export function categoryIdOf(t: McpTransaction): number | null {
    const raw = (t as any).category_id ?? (t as any).categoryId ?? (t as any).category?.id;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

export function subcategoryIdOf(t: McpTransaction): number | null {
    const raw = (t as any).subcategory_id ?? (t as any).subcategoryId ?? (t as any).subcategory?.id;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

// Raw description text (empty string when absent) — used for text-substring
// filters like summing only rows whose description mentions "gasolina".
export function descriptionOf(t: McpTransaction): string {
    const raw = (t as any).description;
    return typeof raw === 'string' ? raw : '';
}

// Month bucket ("YYYY-MM") a transaction belongs to, from its date. Matches how
// the transactions service buckets months for reporting.
export function monthKeyOf(t: McpTransaction): string | null {
    const raw = (t as any).date ?? (t as any).created_at;
    return typeof raw === 'string' && raw.length >= 7 ? raw.slice(0, 7) : null;
}

// Pulls every transaction matching the filter, paging through offsets so a
// busy window is never silently truncated at the page limit. Date filtering is
// ALWAYS by explicit start_date/end_date — the backend's current_month flag is
// silently ignored server-side and returns the entire history.
export async function fetchAllTransactions(
    mcpClient: McpClientService,
    params: { type?: 'income' | 'expense'; start_date?: string; end_date?: string },
): Promise<McpTransaction[]> {
    const all: McpTransaction[] = [];
    let offset = 0;
    for (;;) {
        const page = await mcpClient.listTransactions({
            ...params,
            limit: PAGE_SIZE,
            offset,
        });
        all.push(...page);
        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
        if (offset > 100_000) break; // hard safety valve
    }
    return all;
}

export function sumByCategory(transactions: McpTransaction[]): Map<number, number> {
    const totals = new Map<number, number>();
    for (const t of transactions) {
        const amount = expenseAmount(t);
        if (amount === 0) continue;
        const cid = categoryIdOf(t);
        if (cid == null) continue;
        totals.set(cid, (totals.get(cid) ?? 0) + amount);
    }
    return totals;
}
