import { getMemorySeedsPool } from "./memorySession";
import fs from "node:fs/promises";
import path from "node:path";

import {
    setConfigSchematics,
    getSaveMemoryNumber,
} from "./config";

export interface MemorySeed {
    date: string;
    root_input: string;
    direct_input: string;
    output: string;
}

export interface MemorySeedInfo {
    name: string;
    category: string;
    filename: string;
    seed: MemorySeed;
}

export class MemoryStore {
    private rootDirectory: string | null = null;
    private memoriesDirectory: string | null = null;

    /**
     * Configure where Memory Seeds are stored.
     *
     * The directory is supplied by LM Studio's plugin working directory.
     */
    async setRootDirectory(rootDirectory: string): Promise<void> {
        if (!rootDirectory || !rootDirectory.trim()) {
            throw new Error(
                "Memory Store root directory cannot be empty.",
            );
        }

        this.rootDirectory = rootDirectory;

        this.memoriesDirectory = path.join(
            this.rootDirectory,
            "memories",
        );
    }

    /**
     * Return the root directory used by the memory store.
     */
    async getRootDirectory(): Promise<string> {
        if (!this.rootDirectory) {
            throw new Error(
                "Memory Store has not been initialized with a root directory.",
            );
        }

        return this.rootDirectory;
    }

    /**
     * Make sure the root memories directory exists.
     */
    async initialize(): Promise<void> {
        const directory = await this.getMemoriesDirectory();

        await fs.mkdir(directory, {
            recursive: true,
        });
    }

    /**
     * Return the configured memories directory.
     */
    async getMemoriesDirectory(): Promise<string> {
        if (!this.memoriesDirectory) {
            throw new Error(
                "Memory Store has not been initialized with a root directory.",
            );
        }

        return this.memoriesDirectory;
    }

    /**
     * Create a memory category.
     *
     * Example:
     *   createCategory("Rust Game")
     *
     * Creates:
     *   memories/Rust Game/
     */
    async createCategory(category: string): Promise<void> {
        const directory = await this.getMemoriesDirectory();
        const safeCategory = sanitizePathPart(category);

        if (!safeCategory) {
            throw new Error("Memory category cannot be empty.");
        }

        await fs.mkdir(
            path.join(directory, safeCategory),
            {
                recursive: true,
            },
        );
    }

    /**
     * List all memory categories.
     */
    async listCategories(): Promise<string[]> {
        const directory = await this.initializeAndGetDirectory();

        const entries = await fs.readdir(directory, {
            withFileTypes: true,
        });

        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));
    }

    /**
     * Save a Memory Seed.
     * True = successful write/save
     * False = failed
     * 
     * Creates:
     *
     *   memories/
     *     Rust Game/
     *       game-architecture.json
     */
    async saveSeed(
        category: string,
        name: string,
        seed: MemorySeed,
    ): Promise<boolean> {
        const directory = await this.initializeAndGetDirectory();

        const safeCategory = sanitizePathPart(category);
        const safeName = sanitizeFilename(name);
        const saveMemoryNumber = getSaveMemoryNumber();

        if (saveMemoryNumber === null) {
            return false;
        }

        if (!safeCategory) {
            return false;
        }

        if (!safeName) {
            return false;
        }

        if (!seed.root_input.trim()) {
            return false;
        }

        if (!seed.direct_input.trim()) {
            return false;
        }

        if (!seed.output.trim()) {
            return false;
        }

        try {
            const categoryPath = path.join(
                directory,
                safeCategory,
            );

            await fs.mkdir(categoryPath, {
                recursive: true,
            });

            const filePath = path.join(
                categoryPath,
                `${safeName}.json`,
            );

            let seeds: MemorySeed[] = [];

            try {
                const existing = await fs.readFile(
                    filePath,
                    "utf-8",
                );

                const parsed = JSON.parse(existing);

                if (Array.isArray(parsed)) {
                    seeds = parsed;
                } else if (parsed && typeof parsed === "object") {
                    seeds = [parsed as MemorySeed];
                } else {
                    return false;
                }
            } catch (error: any) {
                if (error.code !== "ENOENT") {
                    return false;
                }
            }

            seeds.push(seed);

            await fs.writeFile(
                filePath,
                JSON.stringify(seeds, null, 2),
                "utf-8",
            );

            const memorySeedName =
                `${safeCategory}/${safeName}.json`;

            const memorySeedsPool =
                getMemorySeedsPool();

            if (!memorySeedsPool.includes(memorySeedName)) {
                setConfigSchematics({
                    memorySeedsPool: [
                        ...memorySeedsPool,
                        memorySeedName,
                    ],
                });
            }

            return true;
        } catch {
            return false;
        }
    }

    async saveMultipleSeeds(
        category: string,
        name: string,
        seeds: MemorySeed[],
        saveMemoryNumber: number,
    ): Promise<boolean> {
        const directory = await this.initializeAndGetDirectory();

        const safeCategory = sanitizePathPart(category);
        const safeName = sanitizeFilename(name);

        if (saveMemoryNumber === null) {
            return false;
        }

        if (!safeCategory) {
            return false;
        }

        if (!safeName) {
            return false;
        }

        if (!seeds.length) {
            return false;
        }

        for (const seed of seeds) {
            if (!seed.root_input.trim()) {
                return false;
            }

            if (!seed.direct_input.trim()) {
                return false;
            }

            if (!seed.output.trim()) {
                return false;
            }
        }
        
        try {
            const categoryPath = path.join(
                directory,
                safeCategory,
            );

            await fs.mkdir(categoryPath, {
                recursive: true,
            });

            const filePath = path.join(
                categoryPath,
                `${safeName}.json`,
            );

            let existingSeeds: MemorySeed[] = [];

            try {
                const existing = await fs.readFile(
                    filePath,
                    "utf-8",
                );

                const parsed = JSON.parse(existing);

                if (Array.isArray(parsed)) {
                    existingSeeds = parsed;
                } else if (parsed && typeof parsed === "object") {
                    // Support the previous single-seed file format.
                    existingSeeds = [parsed as MemorySeed];
                } else {
                    return false;
                }
            } catch (error: any) {
                if (error.code !== "ENOENT") {
                    return false;
                }
            }

            existingSeeds.push(...seeds);

            await fs.writeFile(
                filePath,
                JSON.stringify(existingSeeds, null, 2),
                "utf-8",
            );

            const memorySeedName =
                `${safeCategory}/${safeName}.json`;

            const memorySeedsPool =
                getMemorySeedsPool();

            if (!memorySeedsPool.includes(memorySeedName)) {
                setConfigSchematics({
                    memorySeedsPool: [
                        ...memorySeedsPool,
                        memorySeedName,
                    ],
                });
            }
            
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Load one Memory Seed.
     */
    async loadSeed(
        category: string,
        name: string,
    ): Promise<MemorySeed> {
        const directory = await this.getMemoriesDirectory();

        const safeCategory = sanitizePathPart(category);
        const safeName = sanitizeFilename(name);

        if (!safeCategory || !safeName) {
            throw new Error("Invalid Memory Seed path.");
        }

        const filePath = path.join(
            directory,
            safeCategory,
            `${safeName}.json`,
        );

        const contents = await fs.readFile(
            filePath,
            "utf-8",
        );

        return parseMemorySeed(contents, filePath);
    }

    /**
     * List all Memory Seeds inside a category.
     */
    async listSeeds(
        category: string,
    ): Promise<MemorySeedInfo[]> {
        const directory = await this.getMemoriesDirectory();

        const safeCategory = sanitizePathPart(category);

        if (!safeCategory) {
            throw new Error("Memory category cannot be empty.");
        }

        const categoryPath = path.join(
            directory,
            safeCategory,
        );

        try {
            const entries = await fs.readdir(
                categoryPath,
                {
                    withFileTypes: true,
                },
            );

            const seeds: MemorySeedInfo[] = [];

            for (const entry of entries) {
                if (
                    !entry.isFile() ||
                    !entry.name
                        .toLowerCase()
                        .endsWith(".json")
                ) {
                    continue;
                }

                const filePath = path.join(
                    categoryPath,
                    entry.name,
                );

                const contents = await fs.readFile(
                    filePath,
                    "utf-8",
                );

                const seed = parseMemorySeed(
                    contents,
                    filePath,
                );

                seeds.push({
                    name: path.basename(
                        entry.name,
                        ".json",
                    ),
                    category: safeCategory,
                    filename: entry.name,
                    seed,
                });
            }

            return seeds.sort((a, b) =>
                a.name.localeCompare(b.name),
            );
        } catch (error) {
            if (
                isNodeError(error) &&
                error.code === "ENOENT"
            ) {
                return [];
            }

            throw error;
        }
    }

    /**
     * Load every Memory Seed in a category.
     */
    async loadCategory(
        category: string,
    ): Promise<MemorySeedInfo[]> {
        return this.listSeeds(category);
    }

    /**
     * Check whether a category exists.
     */
    async categoryExists(
        category: string,
    ): Promise<boolean> {
        const directory = await this.getMemoriesDirectory();

        const safeCategory = sanitizePathPart(category);

        if (!safeCategory) {
            return false;
        }

        try {
            const stats = await fs.stat(
                path.join(
                    directory,
                    safeCategory,
                ),
            );

            return stats.isDirectory();
        } catch (error) {
            if (
                isNodeError(error) &&
                error.code === "ENOENT"
            ) {
                return false;
            }

            throw error;
        }
    }

    /**
     * Check whether a Memory Seed exists.
     */
    async seedExists(
        category: string,
        name: string,
    ): Promise<boolean> {
        const directory = await this.getMemoriesDirectory();

        const safeCategory = sanitizePathPart(category);
        const safeName = sanitizeFilename(name);

        if (!safeCategory || !safeName) {
            return false;
        }

        try {
            const stats = await fs.stat(
                path.join(
                    directory,
                    safeCategory,
                    `${safeName}.json`,
                ),
            );

            return stats.isFile();
        } catch (error) {
            if (
                isNodeError(error) &&
                error.code === "ENOENT"
            ) {
                return false;
            }

            throw error;
        }
    }

    /**
     * Initialize the store and return its directory.
     */
    private async initializeAndGetDirectory(): Promise<string> {
        await this.initialize();

        return this.getMemoriesDirectory();
    }
}

/**
 * Convert a user/model-provided category into a safe
 * directory name.
 *
 * We intentionally allow spaces because categories are
 * meant to be human-readable.
 */
function sanitizePathPart(value: string): string {
    return value
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
        .replace(/\.+$/g, "")
        .trim();
}

/**
 * Convert a user/model-provided Memory Seed name into
 * a safe filename.
 */
function sanitizeFilename(value: string): string {
    return value
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
        .replace(/\.+$/g, "")
        .trim();
}

/**
 * Validate the contents of a JSON Memory Seed file.
 */
function parseMemorySeed(
    contents: string,
    filePath: string,
): MemorySeed {
    let parsed: unknown;

    try {
        parsed = JSON.parse(contents);
    } catch {
        throw new Error(
            `Invalid JSON in Memory Seed: ${filePath}`,
        );
    }

    if (
        typeof parsed !== "object" ||
        parsed === null
    ) {
        throw new Error(
            `Invalid Memory Seed format: ${filePath}`,
        );
    }

    const value = parsed as Record<string, unknown>;

    if (
        typeof value.date !== "string" ||
        typeof value.root_input !== "string" ||
        typeof value.direct_input !== "string" ||
        typeof value.output !== "string"
    ) {
        throw new Error(
            `Memory Seed is missing required fields: ${filePath}`,
        );
    }

    return {
        date: value.date,
        root_input: value.root_input,
        direct_input: value.direct_input,
        output: value.output,
    };
}

/**
 * Type guard for Node filesystem errors.
 */
function isNodeError(
    error: unknown,
): error is NodeJS.ErrnoException {
    return (
        error instanceof Error &&
        "code" in error
    );
}

export const memoryStore = new MemoryStore();