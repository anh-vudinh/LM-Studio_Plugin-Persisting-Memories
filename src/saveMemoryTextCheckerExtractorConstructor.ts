import {
    setSaveMemoryNumber,
    getSaveMemoryNumber,
    setSaveMemoryCategory,
    getSaveMemoryCategory,
    setSaveMemoryName,
    getSaveMemoryName,
    resetSaveMemoryParameters,
    setSaveMemoryNumberEndRange,
    getSaveMemoryNumberEndRange,
    getMultiSaveMemoryRegex,
    getCategoryExtractRegex,
    getSaveMemoryRegex,
    getExitSaveMemoryRegex,
    getNameExtractRegex,
} from "./config";

/**
 * Collects and creates the full save memory string that will be pass to the model.
 * This Has instructions to override the model's preivously collected parameters
 * in favor of what we've collected.
 */
export async function saveMemoryTextCheckerExtractorConstructor(
    userText: string
): Promise<string>{
    // Regexes unified at config.ts
    const SAVE_MEMORY_REGEX = getSaveMemoryRegex();

    const MULTI_SAVE_MEMORY_REGEX = getMultiSaveMemoryRegex();

    const CATEGORY_EXTRACT_REGEX = getCategoryExtractRegex();

    const NAME_EXTRACT_REGEX = getNameExtractRegex();

    const EXIT_SAVE_MEMORY_REGEX = getExitSaveMemoryRegex();

    const exitMatch = userText.match(EXIT_SAVE_MEMORY_REGEX);
    
    const exitRequested = exitMatch !== null? true : false;

    if (exitRequested === true) {
        resetSaveMemoryParameters();

        return (
            `User no longer wishes to save a memory, all parameters currently gathered should be released.`
        );
    }

    // ============================================================
    // FIELD EXTRACTION
    // ============================================================

    function extractCategory(segment: string): string | null {
        const match = segment.match(CATEGORY_EXTRACT_REGEX);
        return match?.[1]?.trim() ?? null;
    }

    // reject wildcard trying to be used as a name
    function extractFileName(
        segment: string,
    ): string | null {

        const match =
            segment.match(NAME_EXTRACT_REGEX);

        const fileName =
            match?.[1]?.trim() ?? null;

        if (
            fileName === "*" ||
            fileName === "*.json"
        ) {
            return null;
        }

        return fileName;
    }

    // --------------------------------------------------------
    // Check whether this message contains a save-memory range of messages command.
    // --------------------------------------------------------

    const multiSaveMatch = userText.match(MULTI_SAVE_MEMORY_REGEX);

    if (multiSaveMatch) {
        const startMemoryNumber = Number(multiSaveMatch[1]);
        const endMemoryNumber = Number(multiSaveMatch[2]);

        setSaveMemoryNumber(startMemoryNumber);
        setSaveMemoryNumberEndRange(endMemoryNumber);
    }

    // --------------------------------------------------------
    // Check whether this message contains a save-memory command.
    // --------------------------------------------------------
    
    // Make sure it wasn't actually a save-memory range command
    const saveMemoryMatch = !multiSaveMatch? userText.match(SAVE_MEMORY_REGEX) : null;
    
    if (saveMemoryMatch) {
        setSaveMemoryNumber(Number(saveMemoryMatch[1]));
    }

    // getSaveMemoryNumber()
    // Null = number not provided
    // If there was no number we won't assume user was trying to save a memory 
    // and just meant to type it as normal random user response
    const saveMemoryCommandQueued = getSaveMemoryNumber() !== null;

    // Save memory chain incomplete.
    // Category and/or Memory Name was missing. Expect to retrieve it.
    if (saveMemoryCommandQueued) {

        // --------------------------------------------------------
        // Split fields using the supported delimiters.
        // --------------------------------------------------------

        const segments: string[] = userText
            .split(/[;,.]/)
            .map((segment: string) => segment.trim())
            .filter((segment: string) => segment.length > 0);

        // --------------------------------------------------------
        // Process each segment.
        // --------------------------------------------------------

        for (const segment of segments) {

            // ----------------------------------------------------
            // CATEGORY
            // ----------------------------------------------------

            const category = extractCategory(segment);

            if (category !== null) {
                setSaveMemoryCategory(category);
                continue;
            }

            // ----------------------------------------------------
            // NAME
            // ----------------------------------------------------

            const fileName = extractFileName(segment);

            if (fileName !== null) {
                setSaveMemoryName(fileName);
                continue;
            }
        }
    }

    // Construct the full memory string to feed to the model
    let constructSaveMemoryStringForModel = "";

    const currentSaveMemoryNumber = getSaveMemoryNumber();
    const currentSaveMemoryCategory = getSaveMemoryCategory();
    const currentSaveMemoryName = getSaveMemoryName();
    const currentSaveMemoryNumberEndRange = getSaveMemoryNumberEndRange();

    const allRequiredFieldsKnown =
        currentSaveMemoryNumber !== null &&
        (currentSaveMemoryCategory !== null && currentSaveMemoryCategory !== "") &&
        (currentSaveMemoryName !== null && currentSaveMemoryName !== "");
        
    if(allRequiredFieldsKnown) {
        constructSaveMemoryStringForModel += 
        ` The user asked you to use the persist_seed tool. ` +
        `Disregard their previously provided values. Here is their complete command: ` +
        `save memory ${currentSaveMemoryNumber}`+
        `${currentSaveMemoryNumberEndRange !== null? ` through ${currentSaveMemoryNumberEndRange};` : ";"} ` +
        `category ${currentSaveMemoryCategory}; name ${currentSaveMemoryName}; ` +
        `:End of command.`
    }

    return allRequiredFieldsKnown
        ? constructSaveMemoryStringForModel 
        : "";
}