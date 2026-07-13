CREATE TYPE "chat_attachment_type" AS ENUM('image', 'audio');--> statement-breakpoint
CREATE TYPE "chat_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TABLE "chat_message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"message_id" uuid NOT NULL,
	"type" "chat_attachment_type" NOT NULL,
	"content" text NOT NULL,
	"mime_type" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"chat_id" uuid NOT NULL,
	"role" "chat_message_role" NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" varchar(255),
	"title" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "chat_message_attachments_message_id_idx" ON "chat_message_attachments" ("message_id");--> statement-breakpoint
CREATE INDEX "chat_messages_chat_id_idx" ON "chat_messages" ("chat_id");--> statement-breakpoint
ALTER TABLE "chat_message_attachments" ADD CONSTRAINT "chat_message_attachments_message_id_chat_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_id_chats_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE;