export type MessagePart =
    | { type: 'text'; content: string }
    | { type: 'image'; content: string }   // base64-encoded
    | { type: 'audio'; content: string };  // base64-encoded

export function buildMultimodalContentParts(messages: MessagePart[]) {
    return messages.map(msg => {
        if (msg.type === 'text') {
            return { type: 'text' as const, text: msg.content };
        }
        if (msg.type === 'image') {
            return {
                type: 'image_url' as const,
                image_url: { url: `data:image/jpeg;base64,${msg.content}` },
            };
        }
        // audio — passed as input_audio; model support depends on OpenRouter provider
        return {
            type: 'input_audio' as const,
            input_audio: { data: msg.content, format: 'mp3' },
        };
    });
}
