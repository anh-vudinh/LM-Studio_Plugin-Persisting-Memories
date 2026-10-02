import { PluginContext } from "@lmstudio/sdk";
import { toolsProvider } from "./toolsProvider";
import { promptPreprocessor } from "./promptPreprocessor";
import { memoryStore } from "./memoryStore";
import { readdir } from "fs/promises";
import { initializeMemorySeedsPool } from "./memorySession";
import path from "path";
import os from "os";

import {
    setConfigSchematics,
    configSchematics,
} from "./config";

/**
 * Populating the config starts here rather than
 * the default of starting in config.ts
 */
export async function main(context: PluginContext) {

    // checking memories directory to populate initial memory seed pool
    await memoryStore.setRootDirectory(
        path.join(
            os.homedir(),
            ".lmstudio",
        ),
    );

    await memoryStore.initialize();

    const memoriesDirectory =
        await memoryStore.getMemoriesDirectory();

    const categories = await readdir(
        memoriesDirectory,
        {
            withFileTypes: true,
        },
    );

    const memorySeedsPool: string[] = [];

    for (const category of categories) {
        if (!category.isDirectory()) {
            continue;
        }

        const categoryPath = path.join(
            memoriesDirectory,
            category.name,
        );

        const files = await readdir(
            categoryPath,
            {
                withFileTypes: true,
            },
        );

        for (const file of files) {
            if (
                file.isFile() &&
                file.name
                    .toLowerCase()
                    .endsWith(".json")
            ) {
                memorySeedsPool.push(
                    `${category.name}/${file.name}`,
                );
            }
        }
    }

    memorySeedsPool.sort();

    initializeMemorySeedsPool(memorySeedsPool);

    // first population of the config values
    setConfigSchematics({memorySeedsPool: memorySeedsPool});

    context.withConfigSchematics(configSchematics);
    context.withToolsProvider(toolsProvider);
    context.withPromptPreprocessor(promptPreprocessor);

    console.log("Persisting Memories(model dependent) Plugin initialized");
}