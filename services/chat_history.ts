import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { buildMultimodalContentParts, type MessagePart } from "../lib/multimodal_message.ts";
import type { ChatMessageWithAttachments } from "./chats.ts";

export function toBaseMessages(messages: ChatMessageWithAttachments[]): BaseMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      // Surface the ids of transactions created in that turn to the model
      // (they are stored in metadata, never shown to the user), so a
      // follow-up like answering the location question can update them.
      const createdIds = (message.metadata as Record<string, unknown> | null)
        ?.createdTransactionIds;
      const internalNote = Array.isArray(createdIds) && createdIds.length > 0
        ? `\n\n[internal note — not visible to the user: this turn created transaction ids ${createdIds.join(", ")}]`
        : "";
      return new AIMessage(message.content + internalNote);
    }

    if (message.attachments.length === 0) {
      return new HumanMessage(message.content);
    }

    const parts: MessagePart[] = [
      { type: "text", content: message.content },
      ...message.attachments.map((attachment): MessagePart => ({
        type: attachment.type,
        content: attachment.content,
      })),
    ];

    return new HumanMessage({ content: buildMultimodalContentParts(parts) });
  });
}

// History builder for /generate-ui. Its assistant turns are full HTML documents,
// so replaying every one would bloat the agent context with stale markup. Keep
// all user questions verbatim (so the model sees the full request sequence) but
// include only the MOST RECENT assistant page in full — the one a follow-up like
// "make the title green" edits; earlier pages become a short placeholder.
export function buildUiHistory(messages: ChatMessageWithAttachments[]): BaseMessage[] {
  let lastAssistantIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "assistant") lastAssistantIndex = index;
  });

  return messages.map((message, index) => {
    if (message.role === "assistant") {
      return index === lastAssistantIndex
        ? new AIMessage(message.content)
        : new AIMessage("[previous version of the page omitted]");
    }
    return new HumanMessage(message.content);
  });
}
