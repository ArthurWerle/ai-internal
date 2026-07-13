import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { buildMultimodalContentParts, type MessagePart } from "../lib/multimodal_message.ts";
import type { ChatMessageWithAttachments } from "./chats.ts";

export function toBaseMessages(messages: ChatMessageWithAttachments[]): BaseMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return new AIMessage(message.content);
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
