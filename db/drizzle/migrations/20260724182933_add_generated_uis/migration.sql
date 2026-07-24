CREATE TABLE "generated_uis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" varchar(255) NOT NULL,
	"question" text,
	"html" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "generated_uis_user_enabled_idx" ON "generated_uis" ("user_id","enabled");