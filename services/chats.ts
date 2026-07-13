import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { InferSelectModel } from "drizzle-orm";
import {
  chatsTable,
  chatMessagesTable,
  chatMessageAttachmentsTable,
} from "../db/drizzle/schema.ts";

export type Chat = InferSelectModel<typeof chatsTable>;
export type ChatMessage = InferSelectModel<typeof chatMessagesTable>;
export type ChatMessageAttachment = InferSelectModel<typeof chatMessageAttachmentsTable>;

export type ChatMessageWithAttachments = ChatMessage & {
  attachments: ChatMessageAttachment[];
};

export type NewAttachment = {
  type: "image" | "audio";
  content: string;
  mimeType?: string;
};

export class ChatsService {
  constructor(private db: NodePgDatabase<any>) {}

  async createChat(params: { userId?: string; title?: string }): Promise<Chat> {
    const [chat] = await this.db
      .insert(chatsTable)
      .values({ userId: params.userId, title: params.title })
      .returning();
    return chat;
  }

  async getChat(chatId: string): Promise<Chat | null> {
    const [chat] = await this.db
      .select()
      .from(chatsTable)
      .where(and(eq(chatsTable.id, chatId), isNull(chatsTable.deletedAt)));
    return chat ?? null;
  }

  async listChats(params?: { userId?: string; limit?: number; offset?: number }): Promise<Chat[]> {
    const conditions = [isNull(chatsTable.deletedAt)];
    if (params?.userId) conditions.push(eq(chatsTable.userId, params.userId));

    return this.db
      .select()
      .from(chatsTable)
      .where(and(...conditions))
      .orderBy(desc(chatsTable.updatedAt))
      .limit(params?.limit ?? 50)
      .offset(params?.offset ?? 0);
  }

  async updateChat(chatId: string, params: { title: string }): Promise<Chat | null> {
    const [chat] = await this.db
      .update(chatsTable)
      .set({ title: params.title, updatedAt: new Date() })
      .where(and(eq(chatsTable.id, chatId), isNull(chatsTable.deletedAt)))
      .returning();
    return chat ?? null;
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const [chat] = await this.db
      .update(chatsTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(chatsTable.id, chatId), isNull(chatsTable.deletedAt)))
      .returning();
    return chat != null;
  }

  async addMessage(params: {
    chatId: string;
    role: "user" | "assistant";
    content: string;
    metadata?: Record<string, unknown>;
    attachments?: NewAttachment[];
  }): Promise<ChatMessageWithAttachments> {
    const [message] = await this.db
      .insert(chatMessagesTable)
      .values({
        chatId: params.chatId,
        role: params.role,
        content: params.content,
        metadata: params.metadata,
      })
      .returning();

    let attachments: ChatMessageAttachment[] = [];
    if (params.attachments && params.attachments.length > 0) {
      attachments = await this.db
        .insert(chatMessageAttachmentsTable)
        .values(
          params.attachments.map((attachment) => ({
            messageId: message.id,
            type: attachment.type,
            content: attachment.content,
            mimeType: attachment.mimeType,
          })),
        )
        .returning();
    }

    await this.db
      .update(chatsTable)
      .set({ updatedAt: new Date() })
      .where(eq(chatsTable.id, params.chatId));

    return { ...message, attachments };
  }

  async listMessages(chatId: string): Promise<ChatMessageWithAttachments[]> {
    const messages = await this.db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.chatId, chatId))
      .orderBy(chatMessagesTable.createdAt);

    if (messages.length === 0) return [];

    const attachments = await this.db
      .select()
      .from(chatMessageAttachmentsTable)
      .where(
        inArray(
          chatMessageAttachmentsTable.messageId,
          messages.map((message) => message.id),
        ),
      );

    const attachmentsByMessageId = new Map<string, ChatMessageAttachment[]>();
    for (const attachment of attachments) {
      const list = attachmentsByMessageId.get(attachment.messageId) ?? [];
      list.push(attachment);
      attachmentsByMessageId.set(attachment.messageId, list);
    }

    return messages.map((message) => ({
      ...message,
      attachments: attachmentsByMessageId.get(message.id) ?? [],
    }));
  }

  async getChatWithMessages(
    chatId: string,
  ): Promise<{ chat: Chat; messages: ChatMessageWithAttachments[] } | null> {
    const chat = await this.getChat(chatId);
    if (!chat) return null;

    const messages = await this.listMessages(chatId);
    return { chat, messages };
  }
}
