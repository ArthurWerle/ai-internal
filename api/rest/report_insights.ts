import type { FastifyInstance } from "fastify";
import { z } from "zod/v3";

export const ReportInsightsSchema = z.object({
  headline: z
    .string()
    .describe(
      "1-2 sentence month summary for the report header, warm and direct, mention the most notable change with its percentage",
    ),
  highlights: z
    .array(z.string())
    .min(1)
    .max(5)
    .describe("Short bullet points: notable wins and changes"),
  concerns: z
    .array(z.string())
    .max(3)
    .describe("Short bullet points: biggest spending concerns"),
  closing: z
    .string()
    .describe(
      "Encouraging closing paragraph with one concrete suggestion for next month",
    ),
});

type OverviewSide = {
  currentMonth?: number;
  lastMonth?: number;
  percentageVariation?: number | null;
};

type NamedTotal = { name?: string; total?: number };

type ReportInsightsBody = {
  month: number;
  year: number;
  language?: string;
  overview: { income?: OverviewSide; expense?: OverviewSide };
  expensesByCategory: NamedTotal[];
  expensesBySubcategory?: NamedTotal[];
  expensesByLocation?: NamedTotal[];
  monthlyHistory?: { month?: string; income?: number; expense?: number }[];
  biggestTransactions?: {
    description?: string;
    amount?: number;
    category?: string;
  }[];
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(month: number, year: number): string {
  const name = MONTH_NAMES[month - 1] ?? `Month ${month}`;
  return `${name} ${year}`;
}

function fmtSide(label: string, side?: OverviewSide): string {
  if (!side) return `${label}: (no data)`;
  const current = side.currentMonth ?? 0;
  const last = side.lastMonth ?? 0;
  const pct =
    side.percentageVariation === null || side.percentageVariation === undefined
      ? "n/a"
      : `${side.percentageVariation.toFixed(1)}%`;
  return `${label}: ${current} this month vs ${last} last month (${pct} month-over-month)`;
}

function fmtNamedTotals(rows?: NamedTotal[]): string {
  if (!rows || rows.length === 0) return "  (none)";
  return rows
    .map((r) => `  - ${r.name ?? "(none)"}: ${r.total ?? 0}`)
    .join("\n");
}

function buildPrompt(body: ReportInsightsBody): string {
  const period = monthLabel(body.month, body.year);
  const lines: string[] = [];
  lines.push(`Financial report data for ${period}.`);
  lines.push("");
  lines.push("Overview:");
  lines.push(`  ${fmtSide("Income", body.overview?.income)}`);
  lines.push(`  ${fmtSide("Expenses", body.overview?.expense)}`);
  lines.push("");
  lines.push("Expenses by category (largest first):");
  lines.push(fmtNamedTotals(body.expensesByCategory));
  if (body.expensesBySubcategory && body.expensesBySubcategory.length > 0) {
    lines.push("");
    lines.push("Expenses by subcategory (largest first):");
    lines.push(fmtNamedTotals(body.expensesBySubcategory));
  }
  if (body.expensesByLocation && body.expensesByLocation.length > 0) {
    lines.push("");
    lines.push("Expenses by location (largest first):");
    lines.push(fmtNamedTotals(body.expensesByLocation));
  }
  if (body.monthlyHistory && body.monthlyHistory.length > 0) {
    lines.push("");
    lines.push("Last months (income / expense):");
    lines.push(
      body.monthlyHistory
        .map(
          (h) => `  - ${h.month ?? "?"}: income ${h.income ?? 0}, expense ${h.expense ?? 0}`,
        )
        .join("\n"),
    );
  }
  if (body.biggestTransactions && body.biggestTransactions.length > 0) {
    lines.push("");
    lines.push("Biggest single expenses:");
    lines.push(
      body.biggestTransactions
        .map(
          (b) =>
            `  - ${b.description ?? "(no description)"}: ${b.amount ?? 0}${b.category ? ` [${b.category}]` : ""}`,
        )
        .join("\n"),
    );
  }
  return lines.join("\n");
}

async function routes(fastify: FastifyInstance) {
  fastify.post("/report-insights", {
    schema: {
      body: {
        type: "object",
        required: ["month", "year", "overview", "expensesByCategory"],
        properties: {
          month: { type: "integer", minimum: 1, maximum: 12 },
          year: { type: "integer" },
          language: { type: "string" },
          overview: {
            type: "object",
            properties: {
              income: { type: "object" },
              expense: { type: "object" },
            },
          },
          expensesByCategory: { type: "array" },
          expensesBySubcategory: { type: "array" },
          expensesByLocation: { type: "array" },
          monthlyHistory: { type: "array" },
          biggestTransactions: { type: "array" },
        },
      },
    },
  }, async (request) => {
    const body = request.body as ReportInsightsBody;
    const language = body.language && body.language.trim() !== "" ? body.language : "en";
    const period = monthLabel(body.month, body.year);

    const system = [
      "You are a personal-finance analyst writing a monthly report for a 2-person household.",
      "Be concrete and specific. Cite numbers and percentages, but only from the data provided — never invent figures.",
      "Keep each highlight and concern to a single sentence.",
      `Write everything in this language: ${language}.`,
    ].join(" ");

    const prompt = buildPrompt(body);

    const response = await fastify.openRouterClient.generateStructured(
      system,
      prompt,
      ReportInsightsSchema,
      {
        tags: ["report-insights", "production"],
        metadata: {
          endpoint: "/report-insights",
          timestamp: new Date().toISOString(),
          period,
          language,
        },
      },
    );

    return {
      success: response.success,
      data: response.data,
    };
  });
}

export default routes;
