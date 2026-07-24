import { boolean, integer, pgTable, varchar, uuid, text, timestamp, jsonb, index, pgEnum } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 255 }).notNull(),
  email: varchar({ length: 255 }).notNull().unique(),
});

export const chatMessageRoleEnum = pgEnum("chat_message_role", ["user", "assistant"]);
export const chatAttachmentTypeEnum = pgEnum("chat_attachment_type", ["image", "audio"]);

export const chatsTable = pgTable("chats", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: varchar("user_id", { length: 255 }),
  title: varchar("title", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const chatMessagesTable = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  chatId: uuid("chat_id").notNull().references(() => chatsTable.id, { onDelete: "cascade" }),
  role: chatMessageRoleEnum("role").notNull(),
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("chat_messages_chat_id_idx").on(table.chatId)]);

export const chatMessageAttachmentsTable = pgTable("chat_message_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id").notNull().references(() => chatMessagesTable.id, { onDelete: "cascade" }),
  type: chatAttachmentTypeEnum("type").notNull(),
  content: text("content").notNull(),
  mimeType: varchar("mime_type", { length: 100 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("chat_message_attachments_message_id_idx").on(table.messageId)]);

export const insightKindEnum = pgEnum("insight_kind", ["spending"]);

// Cached AI-generated analyses. Only one row per (kind, period_key) is
// active at a time: reads return the active row instead of re-generating,
// and a rebuild deactivates the previous row before inserting the new one.
export const insightsTable = pgTable("insights", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: insightKindEnum("kind").notNull().default("spending"),
  periodKey: varchar("period_key", { length: 7 }).notNull(),
  content: text("content").notNull(),
  active: boolean("active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("insights_kind_period_active_idx").on(table.kind, table.periodKey, table.active)]);

// AI-generated single-file HTML pages from /generate-ui. Only one row per
// user is enabled at a time: generating a new page for a user flips the
// previous enabled row to false, and GET /generated-ui returns the enabled one.
export const generatedUisTable = pgTable("generated_uis", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: varchar("user_id", { length: 255 }).notNull(),
  question: text("question"),
  html: text("html").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("generated_uis_user_enabled_idx").on(table.userId, table.enabled)]);
