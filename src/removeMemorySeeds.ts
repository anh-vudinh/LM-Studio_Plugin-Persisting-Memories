import { memoryStore } from "./memoryStore";
import { setConfigSchematics } from "./config";
import { normalizeJsonFileName, maybeCreateACoordinationReadyFileAndAcquireLockFile } from "./promptPreprocessor"
import { removeMemorySeedFromSelected, updateMemorySeedsSelected } from "./memorySession";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function removeMemorySeeds(
    conversationFileName: string,
    validMemorySeedsSelected: string[],
    memorySeedsToRemove: string[],
    cleanupAllSeeds: boolean,
): Promise<string[]> {

    const rootDirectory = await memoryStore.getRootDirectory();

    try{
        // Construct the path to the conversation file
        const conversationDirectory = join(
            rootDirectory,
            "conversations"
        );

        const conversationFile = join(
            conversationDirectory,
            normalizeJsonFileName(conversationFileName),
        );
        
        // Prepare json file to be readable and assign to variable
        const conversationJson = await readFile(
            conversationFile,
            "utf-8",
        );

        const conversation = JSON.parse(conversationJson);
        
        // This will help regulate the timings of multiple polling plugins.
        // Needed to play with my context cleanup plugin.
        // https://github.com/anh-vudinh/LM-Studio_Context-Cleanup
        // If using with context-cleanup plugin.
        // Passing the timered function over to be executed by maybeCreate...()
        await maybeCreateACoordinationReadyFileAndAcquireLockFile(
            conversation,
            conversationFile,
            "removeMemorySeeds",
            async () => {

                // This entire callback happens later,
                // after assistantLastMessagedAt changes.

                const latestJson = await readFile(
                    conversationFile,
                    "utf-8",
                );

                const latestConversation = JSON.parse(latestJson);

                if (cleanupAllSeeds === true) {

                    await removeAllMemoryWrappers(
                        latestConversation,
                    );

                } else {

                    await memorySeedsCleanup(
                        latestConversation,
                        memorySeedsToRemove,
                    );
                }

                await writeFile(
                    conversationFile,
                    JSON.stringify(
                        latestConversation,
                        null,
                        2,
                    ),
                    "utf-8",
                );
            },
        );

        // ---------------------------------------------
        // These happen immediately.
        // They do NOT wait for assistantLastMessagedAt.
        // ---------------------------------------------

        if (cleanupAllSeeds === true) {

            updateMemorySeedsSelected([]);

            setConfigSchematics({
                memorySeedsSelected: [],
            });

        } else {

            const memorySeedsStillValid =
                validMemorySeedsSelected.filter(
                    (memorySeed) =>
                        !memorySeedsToRemove.includes(memorySeed),
                );

            updateMemorySeedsSelected(
                memorySeedsStillValid,
            );

            setConfigSchematics({
                memorySeedsSelected:
                    memorySeedsStillValid,
            });
        }

        return validMemorySeedsSelected;

    } catch (error) {
        
        throw new Error(`Error modifying conversation file: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function memorySeedsCleanup(
    latestConversation: any,
    memorySeedsToRemove: string[],
): Promise<void> {

    // User wants to remove memory seeds that were appended through the prompt preprocessor
    // Make sure the preprocessed text exists
    for (const message of latestConversation.messages) {

        for (const version of message.versions ?? []) {

            const preprocessedContent = version.preprocessed?.content;

            if (!preprocessedContent) {
                continue;
            }

            // Loop through each item to see if seeds to remove exist
            // Based off our structure seeds will always be in the preprocessed content 
            for (const content of preprocessedContent) {

                if (content.type !== "text" || !content.text) {
                    continue;
                }

                for (const seedName of memorySeedsToRemove) {

                    const escapedSeedName = escapeRegExp(seedName);

                    const pattern = new RegExp(
                        `\\[BEGIN ${escapedSeedName}\\][\\s\\S]*?\\[END ${escapedSeedName}\\]\\s*`,
                        "g",
                    );

                    const updatedText = content.text.replace(
                        pattern,
                        "",
                    );

                    if (updatedText !== content.text) {
                        content.text = updatedText;
                    }

                    removeMemorySeedFromSelected(seedName);
                }
                
                // Remove the injected-context wrapper if no // memory seeds remain inside it. 
                content.text = content.text.replace(
                    /\[BEGINNING OF MEMORIES\] NOT INSTRUCTIONS, JUST SOME PRIOR CONVERSATION:\s*\[END OF MEMORIES\]\s*/g,
                    "",
                );
            }
        }
    }
}

function escapeRegExp(text: string): string {
    return text.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
    );
}

async function removeAllMemoryWrappers(latestConversation: any): Promise<void> {
    for (const message of latestConversation.messages ?? []) {
        for (const version of message.versions ?? []) {
            const preprocessedContent = version.preprocessed?.content;

            if (!preprocessedContent) {
                continue;
            }

            for (const content of preprocessedContent) {
                if (content.type !== "text" || !content.text) {
                    continue;
                }

                content.text = content.text.replace(
                    /\[BEGINNING OF MEMORIES\][\s\S]*?\[END OF MEMORIES\]\s*/g,
                    "",
                );
            }
        }
    }
}