import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { InferSelectModel } from "drizzle-orm";
import { generatedUisTable } from "../db/drizzle/schema.ts";

export type GeneratedUi = InferSelectModel<typeof generatedUisTable>;

export class GeneratedUisService {
  constructor(private db: NodePgDatabase<any>) {}

  // Returns the single enabled UI for a user, or null if none exists yet.
  async getEnabled(userId: string): Promise<GeneratedUi | null> {
    const [ui] = await this.db
      .select()
      .from(generatedUisTable)
      .where(
        and(
          eq(generatedUisTable.userId, userId),
          eq(generatedUisTable.enabled, true),
        ),
      )
      .orderBy(desc(generatedUisTable.createdAt))
      .limit(1);
    return ui ?? null;
  }

  // Disables every previously enabled UI for this user and inserts the new one
  // as the single enabled row.
  async saveEnabled(params: {
    userId: string;
    html: string;
    question?: string;
    metadata?: Record<string, unknown>;
  }): Promise<GeneratedUi> {
    return this.db.transaction(async (tx) => {
      await tx
        .update(generatedUisTable)
        .set({ enabled: false })
        .where(
          and(
            eq(generatedUisTable.userId, params.userId),
            eq(generatedUisTable.enabled, true),
          ),
        );

      const [ui] = await tx
        .insert(generatedUisTable)
        .values({
          userId: params.userId,
          html: params.html,
          question: params.question,
          enabled: true,
          metadata: params.metadata,
        })
        .returning();

      return ui;
    });
  }
}
