import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { InferSelectModel } from "drizzle-orm";
import { insightsTable } from "../db/drizzle/schema.ts";

export type Insight = InferSelectModel<typeof insightsTable>;
export type InsightKind = Insight["kind"];

// Calendar month the insight covers, e.g. "2026-07". Computed in the
// reporting timezone so late-night transactions land in the same month the
// transactions service puts them in.
export function currentPeriodKey(date: Date = new Date()): string {
  const timeZone = process.env.REPORTING_TIMEZONE ?? "America/Sao_Paulo";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).format(date);
}

export class InsightsService {
  constructor(private db: NodePgDatabase<any>) {}

  async getActive(kind: InsightKind, periodKey: string): Promise<Insight | null> {
    const [insight] = await this.db
      .select()
      .from(insightsTable)
      .where(
        and(
          eq(insightsTable.kind, kind),
          eq(insightsTable.periodKey, periodKey),
          eq(insightsTable.active, true),
        ),
      )
      .orderBy(desc(insightsTable.createdAt))
      .limit(1);
    return insight ?? null;
  }

  // Deactivates every previous insight of this kind (any period) and inserts
  // the new one as the single active row.
  async saveActive(params: {
    kind: InsightKind;
    periodKey: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<Insight> {
    return this.db.transaction(async (tx) => {
      await tx
        .update(insightsTable)
        .set({ active: false })
        .where(and(eq(insightsTable.kind, params.kind), eq(insightsTable.active, true)));

      const [insight] = await tx
        .insert(insightsTable)
        .values({
          kind: params.kind,
          periodKey: params.periodKey,
          content: params.content,
          active: true,
          metadata: params.metadata,
        })
        .returning();

      return insight;
    });
  }
}
