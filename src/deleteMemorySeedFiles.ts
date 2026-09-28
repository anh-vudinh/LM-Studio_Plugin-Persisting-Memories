import { memoryStore } from "./memoryStore";
import { join } from "node:path";
import { readdir, unlink, rmdir } from "node:fs/promises";
import { removeMemorySeedFromPool, getMemorySeedsPool } from "./memorySession";
import { setConfigSchematics } from "./config"

export async function deleteMemorySeedFile(
    memorySeed: string,
): Promise<string> {

    const normalizedMemorySeed = memorySeed
        .trim()
        .split(".json")[0] + ".json";

    const [category, filename] = normalizedMemorySeed.split("/");

    try{
        const memoriesDirectory =
            await memoryStore.getMemoriesDirectory();

        const memoryFile = join(
            memoriesDirectory,
            category,
            filename,
        );

        // Delete the file if it exist
        try {
            await unlink(memoryFile);
            removeMemorySeedFromPool(normalizedMemorySeed);
            setConfigSchematics({memorySeedsPool: [...getMemorySeedsPool()]});
            
        } catch (error: any) {
            if (error.code === "ENOENT") {
                console.error(`Error: Memory seed "${normalizedMemorySeed}" was not found.`);
            }
        }
        
        // Check if folder is empty
        // Delete folder if empty
        const categoryDirectory = join(
            memoriesDirectory,
            category,
        );

        const remainingFiles = await readdir(
            categoryDirectory,
        );

        if (remainingFiles.length === 0) {
            try {
                await rmdir(categoryDirectory);
            } catch (error: any) {
                if (error.code !== "EPERM" && error.code !== "ENOTEMPTY") {
                    console.error(`Error: Category Directory "${categoryDirectory}" was not found.`);
                }
            }
        }

        return `Memory seed "${normalizedMemorySeed}" deleted successfully.`;

    } catch (error: any) {
        if (error.code === "ENOENT") {
            return `Error: Memory seed "${normalizedMemorySeed}" was not found.`;
        }
    }

    return `Memory seed "${normalizedMemorySeed}" deleted successfully.`;
}