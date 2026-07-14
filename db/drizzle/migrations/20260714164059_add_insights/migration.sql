CREATE TYPE "insight_kind" AS ENUM('spending');--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"kind" "insight_kind" DEFAULT 'spending'::"insight_kind" NOT NULL,
	"period_key" varchar(7) NOT NULL,
	"content" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "insights_kind_period_active_idx" ON "insights" ("kind","period_key","active");