import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { InferSelectModel } from "drizzle-orm";
import { generatedUisTable } from "../db/drizzle/schema.ts";

export type GeneratedUi = InferSelectModel<typeof generatedUisTable>;

// A history entry for the rewind menu: everything needed to list and label a
// previously generated UI, WITHOUT its (potentially large) html payload.
export type GeneratedUiSummary = Omit<GeneratedUi, "html">;

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

  // Lists a user's previously generated UIs for the rewind menu, most recent
  // first. The html is intentionally omitted so the payload stays small — the
  // full page is fetched only when a specific UI is selected (setEnabledById).
  async listByUser(
    userId: string,
    params?: { limit?: number },
  ): Promise<GeneratedUiSummary[]> {
    return this.db
      .select({
        id: generatedUisTable.id,
        userId: generatedUisTable.userId,
        question: generatedUisTable.question,
        enabled: generatedUisTable.enabled,
        metadata: generatedUisTable.metadata,
        createdAt: generatedUisTable.createdAt,
      })
      .from(generatedUisTable)
      .where(eq(generatedUisTable.userId, userId))
      .orderBy(desc(generatedUisTable.createdAt))
      .limit(params?.limit ?? 20);
  }

  // Rewind: make a previously generated UI the user's single enabled one. Flips
  // every other enabled row off and turns the target on, mirroring saveEnabled.
  // Returns the now-enabled row (with html), or null if it doesn't exist or
  // doesn't belong to this user.
  async setEnabledById(userId: string, id: string): Promise<GeneratedUi | null> {
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(generatedUisTable)
        .where(
          and(
            eq(generatedUisTable.id, id),
            eq(generatedUisTable.userId, userId),
          ),
        )
        .limit(1);

      if (!target) return null;

      await tx
        .update(generatedUisTable)
        .set({ enabled: false })
        .where(
          and(
            eq(generatedUisTable.userId, userId),
            eq(generatedUisTable.enabled, true),
          ),
        );

      const [ui] = await tx
        .update(generatedUisTable)
        .set({ enabled: true })
        .where(eq(generatedUisTable.id, id))
        .returning();

      return ui;
    });
  }
}
