import { integer, pgTable, varchar, uuid, text, timestamp, jsonb, index, pgEnum } from "drizzle-orm/pg-core";

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
