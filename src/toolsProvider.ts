import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { getCurrentConversationHistory } from "./conversationHistoryCache";
import { associateAssistantResponse } from "./memoryAssociation";
import { memoryStore } from "./memoryStore";
import { getMemorySeedsPool } from "./memorySession";
import { deleteMemorySeedFile } from "./deleteMemorySeedFiles"
import { normalizeJsonFileName, maybeCreateACoordinationReadyFileAndAcquireLockFile } from "./promptPreprocessor";
import { join } from "node:path";
import { readFile } from "fs/promises";
import { z } from "zod";

import {
  configSchematics,
  getSaveMemoryNumber,
  resetSaveMemoryParameters,
  getSaveMemoryCategory,
  getSaveMemoryName
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

  if (normalizedMemoryFileToDelete !== "" && 
      getMemorySeedsPool().includes(normalizedMemoryFileToDelete)
  ) {

    await deleteMemorySeedFile(normalizedMemoryFileToDelete);
    console.log("deleted ", normalizedMemoryFileToDelete)
  }

  /**
   * ------------------------------------------------------------------------
   * persistingMemoriesTool
   * ------------------------------------------------------------------------
   */
  const persistingMemoriesTool = tool({
    name: "persist_seed",

    description:
      `No guess work allowed for this tool. The user must have exactly said save memory <number>; category <category>; name <name>; to have called for this tool.`,

    parameters: {
      messageNumber: z
        .number()
        .int()
        .min(1)
        .describe(
          "Exact number <N> provided by the user during a save memory command."
        ),
      category: z
        .string()
        .trim()
        .min(1)
        .describe(
          "NON OPTIONAL: MUST BE USER PROVIDED. Memory Seed category/folder."
        ),
      name: z
        .string()
        .trim()
        .min(1)
        .describe(
          "NON OPTIONAL: MUST BE USER PROVIDED. Name for the Memory Seed."
        ),
    },

    implementation: async (
      params: {
        messageNumber: number;
        category: string;
        name: string;
      },
      { signal }
    ) => {
      // Create lockfile so current history isn't overwritten while saving
      const conversationDirectory = join(
          await memoryStore.getRootDirectory(),
          "conversations"
      );

      const conversationFileName = normalizeJsonFileName(config.get("conversationFileName") as string)

      const conversationFile = join(
          conversationDirectory,
          conversationFileName,
      );

      try {
        const saveMemoryNumber = getSaveMemoryNumber();
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

        // Start the memory saving
        const association = await associateAssistantResponse(
          ctl.client,
          history,
          params.messageNumber,
        );

        // Added some tolerance because users technically could delete all
        // their user messages before asking the model to save a memory
        const rootInput =
            association.rootInput?.trim() ||
            "original user intention/topic could not be found";

        const directInput =
            association.directInput?.trim() ||
            association.rootInput?.trim() ||
            "original user message could not be found";


        const memorySavedStatus =
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

        if (signal.aborted) {
          return "Memory Seed operation was aborted.";
        }

        // Reset states for new tool calls
        resetSaveMemoryParameters();

        if(memorySavedStatus){
          return (
            `Memory Seed ${params.category}/${params.name}" of msg ${params.messageNumber} has been saved.`
          );
        } else{
          return (
            `Memory Seed ${params.category}/${params.name}" of msg ${params.messageNumber} failed to save.`
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
            reasons.push("the user did not explicitly call the tool because an expected message number was not provided alongside their request. Do not call this tool again unless explicitly asked for");
        }

        if (saveMemoryCategory === null) {
            reasons.push("the memory category was not provided. Must be provided with the prefix 'category', such as category <category_name>");
        }

        if (saveMemoryName === null) {
            reasons.push("the memory name was not provided. Must be provided with the prefix 'name', such as name <seed_name>");
        }

        super(
            "Invalid save memory request. " +
            "The user must explicitly say 'save memory' with all required parameters. " +
            `Problems: ${reasons.join("; ")}. ` +
            `Or the user wishes to cancel their request, they may type 'exit save memory'.`
        );

        this.name = "InvalidSaveMemoryNumberError";
    }
}