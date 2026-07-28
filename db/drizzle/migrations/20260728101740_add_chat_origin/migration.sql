ALTER TABLE "chats" ADD COLUMN "origin" varchar(255);--> statement-breakpoint
CREATE INDEX "chats_user_origin_idx" ON "chats" ("user_id","origin");--> statement-breakpoint
-- Backfill origin for pre-existing chats: a chat referenced by a generated_uis
-- row was created by /generate-ui (the uiless-financer flow); everything else
-- came from /ask (the financer flow). Compare id::text to the jsonb text to
-- avoid uuid-cast failures on any malformed metadata value.
UPDATE "chats" SET "origin" = 'uiless-financer'
WHERE "id"::text IN (
  SELECT "metadata"->>'chatId' FROM "generated_uis"
  WHERE "metadata"->>'chatId' IS NOT NULL
);--> statement-breakpoint
UPDATE "chats" SET "origin" = 'financer' WHERE "origin" IS NULL;