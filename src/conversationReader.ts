import type { Chat, ChatMessage } from "@lmstudio/sdk";
import { getCleanUserInputSaveMemoryRegex } from "./config";

export interface ConversationMessage {
    /**
     * Human-facing conversation message number.
     *
     * Message 1 = first user request + its assistant response.
     * Message 2 = second user request + its assistant response.
     */
    messageNumber: number;

    /**
     * Index of the underlying ChatMessage returned by
     * history.getMessagesArray().
     */
    arrayIndex: number;

    role: "user" | "assistant" | "system" | "unknown";
    content: string;
    raw: ChatMessage;
}

export interface AssistantResponse {
    /**
     * Human-facing conversation message number.
     */
    messageNumber: number;

    /**
     * Index of the underlying assistant ChatMessage.
     */
    arrayIndex: number;

    /**
     * Visible assistant response.
     */
    content: string;

    raw: ChatMessage;
}

export interface UserIntentionCandidate {
    /**
     * Human-facing conversation message number.
     *
     * This corresponds to the user's request number.
     */
    messageNumber: number;

    /**
     * Index of the underlying user ChatMessage.
     */
    arrayIndex: number;

    content: string;
    raw: ChatMessage;
}

/**
 * Reads the active conversation and assigns message numbers
 * according to USER messages rather than raw array indexes.
 *
 * Example:
 *
 *   messages[0] = user "hi"
 *   messages[1] = assistant "hello"
 *   messages[2] = user "what is today's date?"
 *   messages[3] = assistant "..."
 *
 * becomes:
 *
 *   conversation message 1 = user "hi" + assistant "hello"
 *   conversation message 2 = user "what is today's date?" + assistant "..."
 *
 * We deliberately do not assume that the assistant is located
 * at userIndex + 1. LM Studio's SDK Chat representation may
 * contain additional entries.
 */
export function readConversation(
    history: Chat,
): ConversationMessage[] {
    const messages = history.getMessagesArray();

    const conversation: ConversationMessage[] = [];
    let messageNumber = 0;

    for (let index = 0; index < messages.length; index++) {
        const raw = messages[index];
        const role = normalizeRole(raw.getRole());

        if (role !== "user") {
            continue;
        }

        messageNumber += 1;

        conversation.push({
            messageNumber,
            arrayIndex: index,
            role,
            content: extractVisibleText(raw),
            raw,
        });

        const assistant = findNextAssistant(
            messages,
            index + 1,
        );

        if (assistant) {
            conversation.push({
                messageNumber,
                arrayIndex: assistant.arrayIndex,
                role: "assistant",
                content: assistant.content,
                raw: assistant.raw,
            });
        }
    }

    return conversation;
}

export function getAssistantResponse(
    history: Chat,
    messageNumber: number,
): AssistantResponse {
    validateMessageNumber(messageNumber);

    const messages = history.getMessagesArray();

    let assistantMessageNumber = 0;

    for (let arrayIndex = 0; arrayIndex < messages.length; arrayIndex++) {
        const message = messages[arrayIndex];

        if (!isEligibleAssistantMessage(message)) {
            continue;
        }

        assistantMessageNumber++;

        if (assistantMessageNumber !== messageNumber) {
            continue;
        }

        return {
            messageNumber,
            arrayIndex,
            content: message.getText(),
            raw: message,
        };
    }

    throw new Error(
        `Assistant response ${messageNumber} does not exist. ` +
        `The conversation contains ${assistantMessageNumber} eligible assistant response(s).`,
    );
}

export function isEligibleAssistantMessage(
    message: ChatMessage,
): boolean {
    if (!message.isAssistantMessage()) {
        return false;
    }

    const content = (message as any).data?.content ?? [];

    return !content.some(
        (item: any) => item.type === "toolCallRequest",
    );
}

export function getAssistantOutput(message: ChatMessage): string {
    const data = (message as any).data;

    if (data?.role !== "assistant") {
        throw new Error("Message is not an assistant message.");
    }

    const textContent = data.content
        ?.filter((item: any) => item.type === "text")
        ?.at(-1);

    if (!textContent?.text) {
        throw new Error("Assistant message output is empty.");
    }

    return textContent.text;
}

/**
 * Returns every earlier user request that could represent
 * the root intention behind the selected assistant response.
 */
export function getPriorUserMessages(
    history: Chat,
    assistantMessageNumber: number,
): UserIntentionCandidate[] {
    validateMessageNumber(assistantMessageNumber);

    const assistant = getAssistantResponse(
        history,
        assistantMessageNumber,
    );

    const messages = history.getMessagesArray();
    const candidates: UserIntentionCandidate[] = [];

    let userMessageNumber = 0;

    for (let index = 0; index < assistant.arrayIndex; index++) {
        const raw = messages[index];
        const role = normalizeRole(raw.getRole());

        if (role !== "user") {
            continue;
        }

        userMessageNumber += 1;

        candidates.push({
            messageNumber: userMessageNumber,
            arrayIndex: index,
            content: extractVisibleText(raw),
            raw,
        });
    }

    return candidates;
}

/**
 * Finds the first assistant message after a given array position.
 *
 * We intentionally do not assume it is immediately adjacent.
 */
function findNextAssistant(
    messages: ChatMessage[],
    startIndex: number,
): {
    arrayIndex: number;
    raw: ChatMessage;
    content: string;
} | null {
    for (
        let index = startIndex;
        index < messages.length;
        index++
    ) {
        const raw = messages[index];
        const role = normalizeRole(raw.getRole());

        if (role !== "assistant") {
            continue;
        }

        const content = extractVisibleText(raw).trim();

        if (!content) {
            continue;
        }

        return {
            arrayIndex: index,
            raw,
            content,
        };
    }

    return null;
}

/**
 * Extracts visible text from an LM Studio ChatMessage.
 *
 * getText() is used instead of manually reading internal
 * multi-step content blocks. This keeps thinking/reasoning
 * out of the Memory Seed.
 */
function extractVisibleText(
    message: ChatMessage,
): string {
    try {
        return message.getText();
    } catch {
        return "";
    }
}

function normalizeRole(
    role: string,
): "user" | "assistant" | "system" | "unknown" {
    switch (role) {
        case "user":
            return "user";

        case "assistant":
            return "assistant";

        case "system":
            return "system";

        default:
            return "unknown";
    }
}

function validateMessageNumber(
    messageNumber: number,
): void {
    if (
        !Number.isInteger(messageNumber) ||
        messageNumber < 0
    ) {
        throw new Error(
            `Invalid message number "${messageNumber}". ` +
            "Conversation message numbers start at 0.",
        );
    }
}

const SYNTHETIC_REASONING_END =
    /__LM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END_[0-9a-f]+__/g;

export function cleanAssistantResponse(text: string): string {
    const markerMatches = [...text.matchAll(SYNTHETIC_REASONING_END)];

    let cleaned = text;

    if (markerMatches.length > 0) {
        const lastMarker = markerMatches[markerMatches.length - 1];

        const endIndex =
            (lastMarker.index ?? 0) + lastMarker[0].length;

        cleaned = text.slice(endIndex);
    }

    cleaned = cleaned.replace(
        /\n+\*\*\*message \d+\*\*\*\s*$/,
        "",
    );

    return cleaned.trim();
}

export function cleanUserInput(text: string): string {
    return text
        .replace(
            /The user asked you to use the persist_seed tool\.[\s\S]*?:End of command\./g,
            "",
        )
        .replace(
            getCleanUserInputSaveMemoryRegex(),
            "",
        )
        .replace(
            /Formatting Instruction:.*?:End of Instruction.?/g,
            "",
        )
        .replace(
            /\[BEGINNING OF MEMORIES\][\s\S]*?\[END OF MEMORIES\]/g,
            "",
        )
        .replace(
            /\[ICID:\s*\d+\](?:\s+\.?)?\s*/g,
            "",
        )
        .replace(
            /Ignore this ICID tag\./,
            "",
        )
        .replace(
            /System:[\s\S]*?'pending save memory\.\.\.'/g,
            "",
        )
        .replace(
            /Your message number for this turn is \d+\./g,
            "",
        )
        .replace(
            /User no longer wishes to save a memory, all parameters currently gathered should be released\./g,
            "",
        )
        .trim();
}