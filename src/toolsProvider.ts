import type { MemorySeed } from "./memoryStore";
import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { getCurrentConversationHistory } from "./conversationHistoryCache";
import { associateAssistantResponse } from "./memoryAssociation";
import { memoryStore } from "./memoryStore";
import { getMemorySeedsPool } from "./memorySession";
import { deleteMemorySeedFile } from "./deleteMemorySeedFiles"
import { maybeCreateACoordinationReadyFileAndAcquireLockFile } from "./promptPreprocessor";
import { cleanUserInput } from "./conversationReader";
import { join } from "node:path";
import { readFile } from "fs/promises";
import { z } from "zod";

import {
  configSchematics,
  getSaveMemoryNumber,
  resetSaveMemoryParameters,
  getSaveMemoryCategory,
  getSaveMemoryName,
  getSaveMemoryNumberEndRange,
  getConversationFileName,
  getNameExtractRegex,
  getCategoryExtractRegex,
  getExitSaveMemoryRegex
} from "./config";

/**
* ToolsProvider does not have much responsibility. Just to interpret when the user
* requests to save a memory. The plugin's heavy lifting is in prompt preprocessor
*/
export async function toolsProvider(
  ctl: ToolsProviderController
): Promise<Tool[]> {
  const tools: Tool[] = [];
  const config = ctl.getPluginConfig(configSchematics);
  const memoryFileToDelete = config.get("deleteMemorySeedsFile") as string;

  /**
  * Deletion logic is handled here because tools can get the real-time state
  * of the deleteMemorySeedsFile config field.
  * Prompt preprocessor would have only caught it after a message is sent.
  */
  const normalizedMemoryFileToDelete = memoryFileToDelete.trim()

  const wildcardMatch =
    normalizedMemoryFileToDelete.match(
        /^([^/]+)\/\*\.json$/i,
    );

  if (
    wildcardMatch &&
    normalizedMemoryFileToDelete !== ""
  ) {
      // Handle wildcard deletion
      const category = wildcardMatch[1];

      const memorySeedsToDelete =
          getMemorySeedsPool().filter(
              (memorySeed) =>
                  memorySeed.startsWith(
                      `${category}/`,
                  ),
          );
        
      // Category does not exist in the memory pool → do nothing
      if (memorySeedsToDelete.length !== 0) {
        for (const memorySeed of memorySeedsToDelete) {
            await deleteMemorySeedFile(memorySeed);
            
            console.log("deleted ", memorySeed);
        }
      }

  } else if (
      // Normal file deletion
      normalizedMemoryFileToDelete !== "" &&
      getMemorySeedsPool().includes(normalizedMemoryFileToDelete)
  ) {
      await deleteMemorySeedFile(normalizedMemoryFileToDelete);

      console.log("deleted ", normalizedMemoryFileToDelete);
  }

  /**
   * ------------------------------------------------------------------------
   * persistingMemoriesTool
   * ------------------------------------------------------------------------
   */
  const persistingMemoriesTool = tool({
    name: "persist_seed",

    description:
      `The user must have exactly said, 'save memory <message Number>; category <category>; name <name>;' to have called for this tool to save an individual message. ` +
      `If the user said "through or to" and any of it's variations and the user provided a <message End Number> it dictates that the user wants to save a range of messages, use the optional messageEndNumber parameter.`,
      
    parameters: {
      messageNumber: z
        .number()
        .int()
        .min(1)
        .describe(
          "Exact <message Number> provided by the user during a save memory command."
        ),
      category: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Exact <category> provided by the user during a save memory command."
        ),
      name: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Exact <name> provided by the user during a save memory command."
        ),
      messageEndNumber: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Exact <message End Number> IF provided by the user during a save memory command. User may provide this to save a range of messages."
        ),
    },

    implementation: async (
      params: {
        messageNumber: number;
        category: string;
        name: string;
        messageEndNumber?: number;
      },
      { signal }
    ) => {
      // Create lockfile so current history isn't overwritten while saving
      const conversationDirectory = join(
          await memoryStore.getRootDirectory(),
          "conversations"
      );

      const conversationFileName = getConversationFileName();

      const conversationFile = join(
          conversationDirectory,
          conversationFileName,
      );

      try {
        const saveMemoryNumber = getSaveMemoryNumber();
        const saveMemoryEndNumber = getSaveMemoryNumberEndRange();
        const saveMemoryCategory = getSaveMemoryCategory();
        const saveMemoryName = getSaveMemoryName();

        // Not checking against params.messageNumber because
        // I nip the model trying to hallucinate it's own number
        // when we're clearly not during a save memory command.
        if (saveMemoryNumber === null || saveMemoryCategory === null || saveMemoryName === null) {
            throw new InvalidSaveMemoryRequestError(saveMemoryNumber, saveMemoryCategory, saveMemoryName);
        }

        if (signal.aborted) {
          return "Memory Seed operation was aborted.";
        }
        const conversationJson = await readFile(conversationFile, "utf-8");

        const conversation = JSON.parse(conversationJson);

        //await acquireLock(lockFile, "toolsProvider");
      
        // If we coordinate we acquire a lock + create a ready file + have a 2000ms timeout before we release our lockfile. 
        // If we do not coordinate we do not need a timeout of 2 seconds at all.
        await maybeCreateACoordinationReadyFileAndAcquireLockFile(
          conversation, 
          conversationFile, 
          "toolsProvider"
        );

        const history = await getCurrentConversationHistory();

        if (signal.aborted) {
          return "Memory Seed operation was aborted.";
        }

        let memorySavedStatus = false;

        // SINGLE MESSAGE SAVE
        if (saveMemoryEndNumber === null) {

          // Start the memory saving
          const association = await associateAssistantResponse(
            ctl.client,
            history,
            params.messageNumber,
          );

          // Added some tolerance because users technically could delete all
          // their user messages before asking the model to save a memory
          const cleanedRootInput = cleanUserInput(association.rootInput?.trim());

          const rootInput = cleanedRootInput !== ""
            ? cleanedRootInput 
            : "original user intention/topic was fully scrubbed";

          const cleanedDirectInput = cleanUserInput(association.directInput?.trim());

          const directInput = cleanedDirectInput !== ""
            ? cleanedDirectInput
            : "original user message was fully scrubbed";
          
          // The reason I did not fully scrub the inputs unlike what I do for multi-message saves
          // is because the user is acting as the person who is demanding this specific assistant message be saved.
          // So if that is linked to a save memory command, so be it. We just scrubbed the save memory # portion so
          // that there is no exceptional case where the tool hallucinates a tool call.
          memorySavedStatus =
            await memoryStore.saveSeed(
                params.category,
                params.name,
                {
                  date: new Date().toISOString(),
                  root_input: rootInput,
                  direct_input: directInput,
                  output: association.assistantResponse,
                },
            );

        } else {

          // MULTI MESSAGE SAVE
          const seeds: MemorySeed[] = [];

          for (
              let memoryNumber = saveMemoryNumber;
              memoryNumber <= saveMemoryEndNumber;
              memoryNumber++
          ) {
              const association = await associateAssistantResponse(
                  ctl.client,
                  history,
                  memoryNumber,
              );

              const cleanedRootInput = cleanUserInput(association.rootInput?.trim());

              const cleanedDirectInput = cleanUserInput(association.directInput?.trim());

              if (
                  isMetadataOnlyInput(cleanedDirectInput)
              ) {
                  continue;
              }

              // Only save seeds that have both root and direct inputs
              if (
                cleanedRootInput !== "" && 
                cleanedDirectInput !== ""
              ) {
                seeds.push({
                  date: new Date().toISOString(),
                  root_input: cleanedRootInput,
                  direct_input: cleanedDirectInput,
                  output: association.assistantResponse,
                });
              }

              // Root Input fully scrubbed but direct input is still usable
              // Just use DirectInput to be a placeholder for RootInput
              if (
                cleanedRootInput === "" &&
                cleanedDirectInput !== ""
              ) {
                seeds.push({
                  date: new Date().toISOString(),
                  root_input: cleanedDirectInput,
                  direct_input: cleanedDirectInput,
                  output: association.assistantResponse,
                });
              }

              // UserInput unusable, skip the save
          }

          // All seeds go into the same file in one read/write operation.
          // startMemoryNumber satisfies the existing save-memory-number check.
          memorySavedStatus = await memoryStore.saveMultipleSeeds(
              saveMemoryCategory,
              saveMemoryName,
              seeds,
              saveMemoryNumber,
          );
        }

        if (signal.aborted) {
          return "Memory Seed operation was aborted.";
        }

        // Reset states for new tool calls
        resetSaveMemoryParameters();

        if(memorySavedStatus){
          return (
            `Memory Seed ${params.category}/${params.name} of msg ${params.messageNumber}${saveMemoryEndNumber !== null? ` through ${params.messageEndNumber}` : ""} has been saved.`
          );
        } else{
          return (
            `Memory Seed ${params.category}/${params.name} of msg ${params.messageNumber}${saveMemoryEndNumber !== null? ` through ${params.messageEndNumber}` : ""} failed to save.`
          );
        }

      } catch (error) {
        if (error instanceof InvalidSaveMemoryRequestError) {
            throw error;
        }

        if (error instanceof Error && error.name === "AbortError") {
            return "Memory Seed operation was aborted.";
        }

        return (
          "Error creating Memory Seed: " +
          `${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  });

  tools.push(persistingMemoriesTool);

  return tools;
}

class InvalidSaveMemoryRequestError extends Error {
    constructor(
        saveMemoryNumber: number | null,
        saveMemoryCategory: string | null,
        saveMemoryName: string | null,
    ) {
        const reasons: string[] = [];

        if (saveMemoryNumber === null) {
            reasons.push(`the user did not explicitly call the tool because an expected message number was not provided alongside their request. Do not call this tool again unless explicitly asked for.`);
        }

        if (saveMemoryCategory === null) {
            reasons.push(`the memory category was not explicitly specified by the user. Must be provided with the prefix 'category', such as category <category_name>.`);
        }

        if (saveMemoryName === null) {
            reasons.push(`the memory name was not explicitly specified by the user. Must be provided with the prefix 'name', such as name <seed_name>.`);
        }

        super(
            `Invalid save memory request.\n\n` +
            "The user must explicitly say 'save memory' with all required parameters.\n\n" +
            `Problems Listed:\n\n${reasons.join("\n\n")}.\n\n` +
            `Or if the user wishes to cancel their request, they may say 'exit save memory'.`
        );

        this.name = "InvalidSaveMemoryNumberError";
    }
}

function isMetadataOnlyInput(input: string): boolean {

    // Regexes unified at config.ts
    const CATEGORY_EXTRACT_REGEX = getCategoryExtractRegex();

    const NAME_EXTRACT_REGEX = getNameExtractRegex();

    const EXIT_SAVE_MEMORY_REGEX = getExitSaveMemoryRegex();

    const normalized = input.trim();

    if (EXIT_SAVE_MEMORY_REGEX.test(normalized)) {
        return true;
    }

    const segments = normalized
        .split(/[;,\.]/)
        .map((segment) => segment.trim())
        .filter(Boolean);

    if (segments.length === 0) {
        return false;
    }

    return segments.every(
        (segment) =>
            CATEGORY_EXTRACT_REGEX.test(segment) ||
            NAME_EXTRACT_REGEX.test(segment),
    );
}