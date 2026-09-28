import type { ChatMessage, PromptPreprocessorController } from "@lmstudio/sdk";
import { setCurrentConversationHistory, getCurrentConversationHistory } from "./conversationHistoryCache";
import { isEligibleAssistantMessage } from "./conversationReader";
import { memoryStore } from "./memoryStore";
import { removeMemorySeeds } from "./removeMemorySeeds";
import { join, basename } from "node:path";
import path from "node:path";

import {
    getMemorySeedsPool,
    updateMemorySeedsSelected,
    addMemorySeedToSelected,
    getMemorySeedsSelected
} from "./memorySession";

import {
    configSchematics,
    setConfigSchematics,
    setSaveMemoryNumber,
    getSaveMemoryNumber,
    setSaveMemoryCategory,
    getSaveMemoryCategory,
    setSaveMemoryName,
    getSaveMemoryName,
    setIsRemovingMemorySeedsQueued,
    getIsRemovingMemorySeedsQueued,
    resetSaveMemoryParameters,
} from "./config";

import { 
    readFile, 
    writeFile, 
    access, 
    readdir, 
    stat,
    open,
    unlink
} from "node:fs/promises";

let injectedMemorySeeds: string[] | null = null;
let cleanupAllSeeds: boolean;
let internalChatID = "";
const relationshipsLimit = 15;

/**
* https://github.com/anh-vudinh
* Main function that directs the flow of the plugin
*/
export async function promptPreprocessor(
    ctl: PromptPreprocessorController,
    userMessage: ChatMessage,
): Promise<string | ChatMessage> {

    // Establish directories
    const memoriesDirectory = await memoryStore.getMemoriesDirectory();

    // Establish initial variable values
    const config = ctl.getPluginConfig(configSchematics);
    const memorySeedsPool = getMemorySeedsPool();
    const memorySeedsSelected = config.get("memorySeedsSelected") as string[];
    let conversationFileName = config.get("conversationFileName") as string;
    const history = await ctl.pullHistory();
    await setCurrentConversationHistory(history);
    const messages = (await getCurrentConversationHistory()).getMessagesArray();
    const userText = userMessage.getText();
    const workingDirectory = ctl.getWorkingDirectory();
    let createNewInternalChatID = false;

    // Read userText to see if user is trying to save a memory.
    // Prepare the entire full command string for the Model. Don't let model determine this.
    // We preprocess the full save command and give it as one proper string.
    const saveMemoryStringForModel = await saveMemoryTextCheckerExtractorConstructor(userText);
    const shouldSendFullSaveMemoryString = saveMemoryStringForModel !== "";

    // Read user and assistant text to see if we need to give the first round of
    // numbering instructions to the model or if we need to remind it to continue to adhere
    const numberingInstructionStringForModel = await constructMessageNumberingInstructionReminder(messages);
    const shouldSendNumberingInstructionString = numberingInstructionStringForModel !== "";

    // Assume values can be lost during future runs because of random plugin reinitialization
    const foundHistoryChatID = await promptProcessorScanHistoryForID(messages);

    // ICID exist in history still
    if (foundHistoryChatID !== "") {
        internalChatID = foundHistoryChatID;
    }

    // ICID not in memory or history
    if (internalChatID === "" &&
        foundHistoryChatID === ""
    ) {
        // Try to recover ICID through the relationship file.
        // ICID will still be blank at this point
        internalChatID = await promptProcessorRecoverChatID(
            internalChatID,
            normalizeJsonFileName(conversationFileName),
            workingDirectory,
            userText,
        );

        if (internalChatID !== "") {
            createNewInternalChatID = true;
        }
    }

    // If we still do not know InternalChatID after the recovery
    // We must create a new one
    if (internalChatID === "") {
        internalChatID = Math.floor(Date.now() / 1000).toString();
        createNewInternalChatID = true;
    }

    // Use the pre-existing InternalChatID found
    // to find the matching conversation file
    // Skip if we already know the conversation file
    if (conversationFileName === "") {

        conversationFileName = await promptProcessorScanForConversationFile(
            userText, 
            workingDirectory,
        );

        conversationFileName = normalizeJsonFileName(conversationFileName);
    }
    
    // Cleaning up whitespaces only, not misspellings
    const normalizedMemorySeedsSelected =
        memorySeedsSelected.map(
            (memorySeed) =>
                memorySeed
                    .trim()
                    .replace(
                        /\.json.*$/i,
                        ".json",
                    ),
        );

    // Compare selected seeds stored in .config to see if they're
    // actually from the available memory pool
    const validMemorySeedsSelected = [
        ...new Set(
            normalizedMemorySeedsSelected.filter(
                (memorySeed) =>
                    memorySeedsPool.includes(
                        memorySeed,
                    ),
            ),
        ),
    ];

    // Scan file first for injected seeds
    // Check on first initialzation, and skip checks later if nothing changed
    // Still works if plugin randomly reinitializes, IMS will be set to null again. 
    // So the current states either
    // matches, doesn't match, or was reset by random initialization.
    let injectedContext = "";

    if (
        injectedMemorySeeds === null ||
        !areStringArraysEqualAsSets(injectedMemorySeeds, validMemorySeedsSelected)
    ) {

        injectedMemorySeeds = await promptProcessorConversationFileScanForPreviousSeeds(conversationFileName, [...memorySeedsPool]);
    }

    // Gating Memory Injection Logic to be disabled during an all parameters provided full save memory turn
    // This is for an edge case check and will keep the save memory command string unpoluted with a memories payload
    if (!shouldSendFullSaveMemoryString) {

        // Determine only new memory seeds to inject
        // This means new additions from config memorySeedsSelected
        const newMemorySeeds =
            validMemorySeedsSelected.filter(
                (memorySeed) =>
                    !injectedMemorySeeds!.includes(
                        memorySeed,
                    ),
            );

        // New valid seeds waiting to be injected
        if (newMemorySeeds.length > 0) {

            injectedContext = await promptProcessorConstructMemoriesToInject(newMemorySeeds, memoriesDirectory);
        }
    }

    // Remove all memory seeds
    const areSeedsDetectedInHistory = await promptProcessorHistorySimpleScanForSeeds(messages);

    if(
        memorySeedsSelected.length === 0 && 
        areSeedsDetectedInHistory === true
    ) {

        cleanupAllSeeds = true;

        await promptProcessorRemoveSeeds(
            conversationFileName, 
            injectedMemorySeeds, 
            validMemorySeedsSelected, 
            cleanupAllSeeds
        );

        injectedMemorySeeds = [];
    }

    // Remove specific memory seeds the user no longer wants
    // after the model has finished responding
    if(memorySeedsSelected.length > 0) {

        cleanupAllSeeds = false;

        injectedMemorySeeds = await promptProcessorRemoveSeeds(
            conversationFileName, 
            injectedMemorySeeds, 
            validMemorySeedsSelected, 
            cleanupAllSeeds
        );
    }

    // NORMAL PATH
    // We are not currently trying to remove memory seeds or send a completed save command.
    // But we need to create a 2 second .lock file to coordinate the Context Cleanup Plugin
    // if it is currently in use with alongside this plugin.
    // removingMemorySeeds and shouldSendFullSaveMemoryString will create will call the maybeCreateACoordinationReadyFileAndAcquireLockFile
    // themselves so this path will not be bypassed.
    if (
        !shouldSendFullSaveMemoryString && 
        !getIsRemovingMemorySeedsQueued()
    ) {

        const conversationDirectory = join(
            await memoryStore.getRootDirectory(),
            "conversations"
        );
        
        const conversationFile = join(
            conversationDirectory,
            normalizeJsonFileName(conversationFileName),
        );

        const conversationJson = await readFile(
            conversationFile,
            "utf-8",
        );
    
        const conversation = JSON.parse(conversationJson);
        
        await maybeCreateACoordinationReadyFileAndAcquireLockFile(
            conversation,
            conversationFile,
            "main"
        );
    }

    // Reset after the check
    setIsRemovingMemorySeedsQueued(false);

    // Already tested the order of content, it did not improve abilities of model to adhere to rules.
    // Models forget/disregard things when they want to and take anything as suggestions if they want too.
    return (
        `${userText}.                          ` +
        `${injectedContext? `${injectedContext}[END OF MEMORIES] ` : ""}` +
        `${createNewInternalChatID? `[ICID: ${internalChatID}] Ignore this ICID tag. ` : ""}` +
        `${shouldSendNumberingInstructionString? numberingInstructionStringForModel : "" }` +
        `${shouldSendFullSaveMemoryString? saveMemoryStringForModel : ""}`
    );
}

/**             ______________________________________           
 *             |                                      |
 *             | LMSTUDIO LOVES TO DISCONNECT PLUGINS |
 *             |______________________________________|
 * 
 * FLOW OF SCAN →  promptProcessorScanHistoryForID()       →       promptProcessorRecoverChatID()           →          (GENERATE BRAND NEW ICID?)        →       promptProcessorScanForConversationFile()
 *                             ↓                                                ↓                                                                                                    ↓
 *                    (ICID FOUND YES/NO)                        (ICID already in memory? YES/NO)                                                              scanForConversationFileThruRelationshipFile()         → (CHECK AGAINST in memory ICID and relationship ICIDs | FOUND CONVO FILE YES/NO) → (CHECK AGAINST WD Base Name in Relationship file | FOUND CONVO YES/NO)
 *                                                                              ↓                                                                                                    ↓
 *                                                      scanForConversationFileThruBaseNameOfWorkingDirectory()                                              scanForConversationFileThruBaseNameOfWorkingDirectory() → (CHECK IF WD Base is a convo file, access it to check for in memory ICID | FOUND CONVO YES/NO) → (Fuzzy match clientInput to userText | FOUND CONVO YES/NO)
 *                                                                              ↓                                                                                                    ↓
 *                                                         (CONFIRMED CONVO FILE && || FOUND ICID YES/NO)                                                 scanForConversationFileThruFullConversationDirectoryScan() → (CHECK ALL convo files Match in memory ICID | FOUND YES/NO) → (Fuzzy match clientInput to userText | FOUND CONVO YES/NO) → (AUTHORITY TO UPDATE stale relationships once in memory ICID and Convo are known but mismatched)
 *                                                                                                                                                                                   ↓
 *                                                                                                                                                                        refreshRelationshipFile()                  → (If convo is known, ICID in convo is missing, relationship has ICID and convo paired, repurpose abandoned ICID & renew relationship. Overwrite in memory internalChatID variable with renewed ICID. This is to overwrite the newly generated ICID logic). 
 *                                                                                                                                                                                   ↓
 *                                                                                                                                *** CONVERSATION FILE AND ICID SHOULD NOW BE KNOWN & LINKED OTHERWISE THE CONVERSATION DOES NOT EXIST ***
 */

/**
 * Try to recover InternalChatID tag if the users deleted it from chat.
 */
interface ChatSessionConversationRelationship {
    internalChatID: string;
    conversationFile: string;
}

/**
* Try and recover InternalChatID from in memory InternalChatID
* or using the fallback of the scanForConversationFileThruBaseNameOfWorkingDirectory() scan
* If either is impossible than there's no choice but to assign a new ICID
*/
async function promptProcessorRecoverChatID(
    internalChatID: string,
    conversationFileName: string,
    workingDirectory: string,
    userText: string,
): Promise<string> {

    // If already available in memory, use it.
    if (internalChatID !== "") {
        return internalChatID;
    }

    const rootDirectory = await memoryStore.getRootDirectory();

    // Construct the path to the conversation file
    const conversationDirectory = join(
        rootDirectory,
        "conversations",
    );

    const relationshipFile = join(
        conversationDirectory,
        "ChatSessionConversationRelationship.json",
    );

    // Cannot perform relationship lookup without a filename.
    if (conversationFileName === "") {
        
        // Attempt a reverse lookup first using the basename of working directory
        conversationFileName = await scanForConversationFileThruBaseNameOfWorkingDirectory(
            workingDirectory,
            conversationDirectory,
            conversationFileName,
            userText,
        );
        
        // Conversation File Name still unknown, cannot resume with recovery
        if(conversationFileName === "") {
            return "";
        }
    }

    try {
        
        const relationshipJson = await readFile(
            relationshipFile,
            "utf-8",
        );

        const relationships: ChatSessionConversationRelationship[] =
            JSON.parse(relationshipJson);

        // Search from newest to oldest.
        // Grab the newest relationship that matches the coversation file name
        // There cannot be two conversations files with the same exact name in a folder
        // At worst we are repurposing an abandoned ICID rather than making a new one
        for (
            let i = relationships.length - 1;
            i >= 0;
            i--
        ) {

            const relationship = relationships[i];

            if (relationship.conversationFile === conversationFileName) {
                return relationship.internalChatID;
            }
        }

    } catch (error: any) {

        if (error instanceof SyntaxError) {

            console.error(
                `Relationship file JSON is corrupted: ${error.message}`,
            );

        } else if (error.code === "ENOENT") {

            console.error(
                "Relationship file not found.",
            );

        } else {

            console.error(
                `Relationship lookup failed: ${error}`,
            );
        }
    }

    return "";
}

/**
* Scan history for InternalChatID tag.
* Cheaper than scanning the conversation file, if
* The conversation file name is still unknown, or the
* plugin reinitializes during an ongoing conversation.
* Note: history will always be missing the newest user+assistant message,
* so it's useless during the very first user message in chat.
*/
async function promptProcessorScanHistoryForID(
    messages: ChatMessage[],
): Promise<string> {

    let searchedInternalChatID = "";

    for (const message of messages) {
        if ((message as any).data.role !== "user") {
            continue;
        }

        for (const content of (message as any).data.content ?? []) {
            if (content.type !== "text" || !content.text) {
                continue;
            }

            const match = content.text.match(
                /\[ICID:\s*(\d+)\]/
            );

            if (match) {
                searchedInternalChatID = match[1];
                break;
            }
        }

        if (searchedInternalChatID !== "") {
            break;
        }
    }

    return searchedInternalChatID;
}

/**
* Scan conversation folder to link the real-time chat to
* it's associated conversation file. This enables the user to
* not have to manually make the link for the plugin.
* Trade off: more resources expended for great ease of use
* 1st scan is ideal, later scans are fallbacks, each has it's early ending.
* 1st scan: cheap - check the relationship file for an exisiting relationship.
* 2nd scan: cheap - check the basename of workingdirectory, which "usually" matches the conversation file name,
* reliability is uncertain but it's quick to see if the convo file is found and has the matching ICID
* 3rd scan: expensive - scan each conversation file starting from newest to oldest until
* we find the matching InternalChatID.
* 4th scan: during the 3rd scan also check if clientInput = userText of most recent prompt preproccesor
* Scan 3 and 4 are authoritative and will repair the association in relationshipfile if needed
* LM Studio likes to reuse file names like empty.conversation.json
*/
async function promptProcessorScanForConversationFile(
    userText: string,
    workingDirectory: string,
): Promise<string> {
    const rootDirectory = await memoryStore.getRootDirectory();
    let relationships: any[] = [];
    let foundConversationFileName = "";

    // Construct the path to the conversation file
    const conversationDirectory = join(
        rootDirectory,
        "conversations"
    );

    const relationshipFile = join(
        conversationDirectory,
        "ChatSessionConversationRelationship.json",
    );

    // Read the relationship file
    try {
        const relationshipJson = await readFile(
            relationshipFile,
            "utf-8",
        );

        relationships = JSON.parse(relationshipJson);

    } catch {
        // File doesn't exist yet, so we'll create it in a later step.
    }

    // We've already found or assigned an InternalChatID.
    // Check if there is an existing relationship in the relationship JSON.
    const existingRelationship = relationships.find(
        (relationship) =>
            relationship.internalChatID === internalChatID,
    );

    // 1st SCAN:
    // STEP 1: If there is a current relationship, check if the
    // conversation file still exists. If the file does not exist,

    if (existingRelationship) {

        foundConversationFileName = await scanForConversationFileThruRelationshipFile(
            existingRelationship,
            conversationDirectory,
            foundConversationFileName,
            relationships,
            relationshipFile,
        )

        if(foundConversationFileName !== "") {

            return foundConversationFileName
        }

    } else {
        // Nothing matched the InternalChatID
        // Lets check to see if the current WD name is present
        const directoryBaseNameFromWD = basename(workingDirectory);

        const conversationFileName = `${directoryBaseNameFromWD}.conversation.json`;

        const existingConversationRelationship = relationships.find(
            (relationship) =>
                relationship.conversationFile === conversationFileName,
        );

        if (existingConversationRelationship) {
            
            // This conversation file name already has a relationship,
            // update the InternalChatID in the relationship file.
            const relationshipData = {
                internalChatID,
                conversationFile: conversationFileName,
            };

            // Remove the old copy of this relationship.
            relationships = relationships.filter(
                (relationship) =>
                    relationship.conversationFile !== conversationFileName,
            );

            // Reinsert it at the bottom so the newest relationship
            // is always the last entry.
            relationships.push(relationshipData);

            // Keep only the newest relationships.
            if (relationships.length > relationshipsLimit) {
                relationships = relationships.slice(-relationshipsLimit);
            }

            await writeFile(
                relationshipFile,
                JSON.stringify(relationships, null, 2),
                "utf-8",
            );

            // Update InternalChatID outer scope variable with what we just wrote in
            internalChatID = relationshipData.internalChatID;
            setConfigSchematics({conversationFileName: normalizeJsonFileName(conversationFileName)});

            return conversationFileName;
        }
    }

    // 2nd SCAN:
    // STEP 3: Check if the basename of WD is a match for the conversation file.
    // Brand new ICID was generated, this will link that new ICID to the foundConvversationFileName
    if (foundConversationFileName === "") {

        foundConversationFileName = await scanForConversationFileThruBaseNameOfWorkingDirectory(
            workingDirectory,
            conversationDirectory,
            foundConversationFileName,
            userText,
        )
    }

    // 3rd SCAN:
    // STEP 4: Scan each conversation file starting from the newest.
    if (foundConversationFileName === "") {

        foundConversationFileName = await scanForConversationFileThruFullConversationDirectoryScan(
            conversationDirectory,
            foundConversationFileName,
            userText,
        )
    }

    // FINAL STEP:
    // If we found a conversation file through STEP 3 or STEP 4,
    // create/update the relationship in ChatSessionConversationRelationship.json.
    if (foundConversationFileName !== "") {

        refreshRelationshipFile(
            relationships,
            rootDirectory,
            foundConversationFileName,
        );
    }

    // Set config state after scanning and relationship persistence.
    setConfigSchematics({conversationFileName: normalizeJsonFileName(foundConversationFileName)});

    return foundConversationFileName;
}

//-----------------------------------------------------------
// Scanning Options
//-----------------------------------------------------------

/**
 * 1st Scan: Cheap look up in a small maintained 15 object(recent conversations) json
 */
async function scanForConversationFileThruRelationshipFile(
    existingRelationship: any,
    conversationDirectory: string,
    foundConversationFileName: string,
    relationships: any[],
    relationshipFile: string,
):Promise<string> {

    const conversationFileName = existingRelationship.conversationFile;

    const conversationFilePath = join(
        conversationDirectory,
        conversationFileName,
    );

    // Check if conversation file stated in the relationship object passed in still exist.
    // If it doesn't remove the entry in the relationship file.
    try {
        await access(conversationFilePath);

        // File exists
        foundConversationFileName = conversationFileName;

    } catch {
        // Conversation file no longer exists.
        // Remove abandoned relationship.
        relationships = relationships.filter(
            (relationship) =>
                relationship.internalChatID !== internalChatID,
        );

        await writeFile(
            relationshipFile,
            JSON.stringify(relationships, null, 2),
            "utf-8",
        );
    }

    // STEP 2:
    // If the conversation file still exists, open it to confirm ICID.
    if (foundConversationFileName !== "") {

        const conversationContent = await readFile(
            conversationFilePath,
            "utf-8",
        );

        const internalChatIDPattern = new RegExp(
            `\\[ICID:\\s*${internalChatID}\\]`,
        );

        const icidMatches = internalChatIDPattern.test(conversationContent);

        // STEP 2.1:
        // Existing relationship is valid, so return immediately.
        if (icidMatches) {
            setConfigSchematics({conversationFileName: foundConversationFileName});
            return foundConversationFileName;
        }

        // Existing relationship is invalid.
        // Clear it and continue with the remaining scans.
        foundConversationFileName = "";
    }

    return foundConversationFileName;
}

/**
 * 2nd Scan: Guess work, uses LM Studio's working directory base name to hope it matches an actual conversation file
 * Proven to be unreliable I eventually seen with my testing that empty.conversation.json could be linked to something like empty-0918sd0f98uja working directory
 */
async function scanForConversationFileThruBaseNameOfWorkingDirectory(
    workingDirectory: string,
    conversationDirectory: string,
    foundConversationFileName: string,
    userText: string,
):Promise<string> {

    try {
        const directoryBaseNameFromWD = basename(workingDirectory);

        const conversationFileName = `${directoryBaseNameFromWD}.conversation.json`;

        const conversationFilePath = join(
            conversationDirectory,
            conversationFileName,
        );

        const conversationContent = await readFile(
            conversationFilePath,
            "utf-8",
        );

        const internalChatIDPattern = new RegExp(
            `\\[ICID:\\s*${internalChatID}\\]`,
        );

        // First check for the ICID.
        if (internalChatIDPattern.test(conversationContent)) {
            foundConversationFileName = conversationFileName;
        }

        // If ICID did not match, check clientInput.
        if (foundConversationFileName === "") {
            try {
                const conversation = JSON.parse(conversationContent);

                const normalize = (s: string): string =>
                    (s ?? "")
                        .trim()
                        .replace(/\s+/g, " ");

                const clientInput = normalize(conversation.clientInput);
                const input = normalize(userText);

                if (
                    clientInput.length > 0 &&
                    input.startsWith(clientInput)
                ) {
                    foundConversationFileName = conversationFileName;
                }

                // we now know the conversationfilename
                // reverse lookup ICID if it already exist in relationship file.
                // This will help sync the in memory ICID to what we already have on file
                // and control if a brand new ICID is actually assigned.
                if (foundConversationFileName !== "") {

                    const rootDirectory = await memoryStore.getRootDirectory();
                    let relationships: any[] = [];

                    // Construct the path to the conversation file
                    const conversationDirectory = join(
                        rootDirectory,
                        "conversations"
                    );

                    const relationshipFile = join(
                        conversationDirectory,
                        "ChatSessionConversationRelationship.json",
                    );

                    try {
                        const relationshipJson = await readFile(
                            relationshipFile,
                            "utf-8",
                        );

                        relationships = JSON.parse(relationshipJson);

                    } catch {
                        // File doesn't exist yet, so we'll create it in a later step.
                    }

                    const existingRelationship = relationships.find(
                        (relationship) =>
                            relationship.conversationFile === foundConversationFileName,
                    );

                    if (existingRelationship) {
                        internalChatID = existingRelationship.internalChatID;
                    }
                }

            } catch {
                // Ignore malformed conversation content
                // and continue to the next scan.
            }
        }

    } catch (error: any) {

        if (error?.code !== "ENOENT") {
            console.error(error);
        }

        // Just move to next scan.
    }

    setConfigSchematics({conversationFileName: foundConversationFileName});

    return foundConversationFileName;
}

/**
* 3rd and 4th(nested) Scan: Literally looked through all the actual conversation files existing and made the match by spotting the ICID in memory/history
* or the clientInput is what was currently sent to the assistant.
* HIGHEST AUTHORITY IF WE'VE REACHED THIS SCAN FALLBACK AND GOT A MATCH
*/
async function scanForConversationFileThruFullConversationDirectoryScan(
    conversationDirectory: string,
    foundConversationFileName: string,
    userText: string,
):Promise<string> {

    const allConversationFiles = await findAllConversationFiles(conversationDirectory);

    const internalChatIDPattern = new RegExp(
        `\\[ICID:\\s*${internalChatID}\\]`,
    );

    for (const conversationFile of allConversationFiles) {

        const conversationContent = await readFile(
            conversationFile,
            "utf-8",
        );

        // First try to match the InternalChatID.
        if (internalChatIDPattern.test(conversationContent)) {
            foundConversationFileName = basename(conversationFile);

            break;
        }

        // 4th SCAN:
        // Fallback for brand-new conversations where the
        // InternalChatID has not yet been injected.
        try {
            const conversation = JSON.parse(conversationContent);

            const normalize = (s: string): string =>
                (s ?? "")
                    .trim()
                    .replace(/\s+/g, " ");

            const clientInput = normalize(conversation.clientInput);
            const input = normalize(userText);

            if (
                clientInput.length > 0 &&
                input.startsWith(clientInput)
            ) {
                foundConversationFileName = basename(conversationFile);

                break;
            }

        } catch {
            // Ignore malformed conversation files and continue scanning.
        }
    }

    // Have an ICID in memory that matches the ICID found in this conversation file
    // Prior relationship scan did not catch this link or had a stale ICID -> conversationfile relationship
    // Replace the ICID in the relationshipfile to match what's in the current conversation
    if (
        internalChatID !== "" &&
        foundConversationFileName !== ""
    ) {
        const relationshipFile = join(
            conversationDirectory,
            "ChatSessionConversationRelationship.json",
        );

        const lockFile = `${relationshipFile}.lock`;

        try {
            await acquireLock(lockFile, "scanForConversationFileThruFullConversationDirectoryScan");

            const relationshipJson = await readFile(
                relationshipFile,
                "utf-8",
            );

            const relationships = JSON.parse(relationshipJson);

            const matchingRelationship = relationships.find(
                (relationship: any) =>
                    relationship.conversationFile ===
                    foundConversationFileName,
            );

            if (
                matchingRelationship &&
                matchingRelationship.internalChatID !== internalChatID
            ) {
                matchingRelationship.internalChatID = internalChatID;

                await writeFile(
                    relationshipFile,
                    JSON.stringify(relationships, null, 2),
                    "utf-8",
                );
            }

        } catch {
            // Ignore missing or malformed relationship files.
        } finally {
            releaseLock(lockFile, "scanForConversationFileThruFullConversationDirectoryScan");
        }
    }

    return foundConversationFileName;
}

/**
* Uses pre-exisiting relationships ICID if conversation file name is reused by LM Studio.
* Refreshes it's state by putting the re-established relationship as recent by moving it to the 
* bottom of the relationship file. Assigns repurposed ICID into memory.
*/
async function refreshRelationshipFile(
    relationships: any[],
    rootDirectory: string,
    conversationFileName: string,
): Promise<void> {
    
    // Construct the path to the conversation file
    const conversationDirectory = join(
        rootDirectory,
        "conversations"
    );

    const relationshipFile = join(
        conversationDirectory,
        "ChatSessionConversationRelationship.json",
    );

    // Read the relationship file
    try {
        const relationshipJson = await readFile(
            relationshipFile,
            "utf-8",
        );

        relationships = JSON.parse(relationshipJson);

    } catch {
        // File doesn't exist yet, so we'll create it in a later step.
    }

    const lockFile = `${relationshipFile}.lock`;

    // If this conversation file already has a relationship,
    // reuse its existing InternalChatID.
    const existingRelationship = relationships.find(
        (relationship) =>
            relationship.conversationFile === conversationFileName,
    );

    if (existingRelationship) {
        internalChatID = existingRelationship.internalChatID;
    }

    const relationshipData = {
        internalChatID,
        conversationFile: conversationFileName,
    };

    // Remove the old copy of this relationship.
    relationships = relationships.filter(
        (relationship) =>
            relationship.internalChatID !== internalChatID &&
            relationship.conversationFile !== conversationFileName,
    );

    // Reinsert it at the bottom so the newest relationship
    // is always the last entry.
    relationships.push(relationshipData);

    // Keep only the newest relationships.
    if (relationships.length > relationshipsLimit) {
        relationships = relationships.slice(-relationshipsLimit);
    }

    try{
        await acquireLock(lockFile, "refreshRelationshipFile");

        await writeFile(
            relationshipFile,
            JSON.stringify(relationships, null, 2),
            "utf-8",
        );
    } catch (error) {

    } finally {
        releaseLock(lockFile, "refreshRelationshipFile");
    }

    // Update InternalChatID outer scope variable with what we just wrote in
    internalChatID = relationshipData.internalChatID;
}

/**
* Gather all the conversation files and order them
* from newest to oldest. The main function promptProcessorScanForConversationFile
* will then start searching in that given order.
*/
async function findAllConversationFiles(
    conversationsDirectory: string,
): Promise<string[]> {

    const conversationFiles: string[] = [];

    async function searchDirectory(
        directory: string,
    ): Promise<void> {

        const entries = await readdir(directory, {
            withFileTypes: true,
        });

        for (const entry of entries) {

            const fullPath = join(
                directory,
                entry.name,
            );

            if (
                entry.isFile()
            ) {
                // exclude the relationship file
                if ( entry.name === "ChatSessionConversationRelationship.json") {
                    continue;
                }

                if (
                    entry.name.endsWith(".lock") ||
                    entry.name.endsWith(".ready")
                ) {
                    continue;
                }

                conversationFiles.push(fullPath);
                continue;
            }

            if (entry.isDirectory()) {
                await searchDirectory(fullPath);
            }
        }
    }
    
    await searchDirectory(conversationsDirectory);

    const filesWithModifiedTime = await Promise.all(
        conversationFiles.map(async (filePath) => {
            const fileStats = await stat(filePath);

            return {
                filePath,
                modifiedTime: fileStats.mtimeMs,
            };
        }),
    );

    filesWithModifiedTime.sort(
        (a, b) => b.modifiedTime - a.modifiedTime,
    );

    return filesWithModifiedTime.map(
        (file) => file.filePath,
    );
}

//-----------------------------------------------------------
// Memory Seeds
//-----------------------------------------------------------

/**
* Shortcut to trigger a quick cleanup of all the memory seeds in conversation file
* when user has removed all seeds in Memories to Inject.
* Rather than the more expensive route of mathcing and removing seeds one by one.
*/
async function promptProcessorHistorySimpleScanForSeeds(
    messages: ChatMessage[],
): Promise<boolean> {

    for (const message of messages) {
        if (/\[BEGIN .*\.json\]/.test(message.getText())) {
            return true;
        }
    }

    return false;
}

/**
* Scan conversation file for past seeds injected. This allows users
* to start the session with the correct injectedMemorySeeds + memorySeedsSelected state.
* Trade off over using history scan: more resources expended for accuracy and reliability
*/
async function promptProcessorConversationFileScanForPreviousSeeds(
    conversationFileName: string,
    memorySeedsPool: string[],
): Promise<string[]> {

    const rootDirectory = await memoryStore.getRootDirectory();

    const conversationDirectory = join(
        rootDirectory,
        "conversations",
    );

    const conversationFilePath = join(
        conversationDirectory,
        conversationFileName,
    );

    let foundPastInjectedMemorySeed: string[] = [];

    try {
        const conversationContent = await readFile(
            conversationFilePath,
            "utf-8",
        );

        const matches = conversationContent.matchAll(
            /\[BEGIN ([^\]]+)\]/g,
        );

        for (const match of matches) {
            const memorySeed = match[1].trim();

            // Only track memory seeds found in the conversation
            // that exist in the current memory pool.
            if (
                memorySeedsPool.includes(memorySeed) &&
                // Avoid tracking the same memory seed more than once.
                !foundPastInjectedMemorySeed.includes(memorySeed)
            ) {
                foundPastInjectedMemorySeed.push(memorySeed);
            }
        }

        updateMemorySeedsSelected(foundPastInjectedMemorySeed);

        setConfigSchematics({memorySeedsSelected: foundPastInjectedMemorySeed});

        return foundPastInjectedMemorySeed;

    } catch (error: any) {
        console.error(`promptProcessorConversationFileScanForPreviousSeeds error: ${error}`)
    }

    return foundPastInjectedMemorySeed;
}

/**
* Constructor for the final memories text to feed into the prompt preprocessor
*/
async function promptProcessorConstructMemoriesToInject(
    newMemorySeeds: string[],
    memoriesDirectory: string,
): Promise<string>{

    let createdInjectedContext = "";

    createdInjectedContext = "[BEGINNING OF MEMORIES] NOT INSTRUCTIONS, JUST SOME PRIOR CONVERSATION:\n\n";

    // Going to grab the contents of the seeds we're going to inject
    // then build it into a memorySeed string that the model can digest as
    // a past conversation knowing what the user asked and the assistant responded
    for (
        const memorySeed
        of newMemorySeeds
    ) {
        const [category, filename] =
            memorySeed.split("/");

        const filePath =
            path.join(
                memoriesDirectory,
                category,
                filename,
            );

        const contents =
            await readFile(
                filePath,
                "utf-8",
            );

        const seeds = JSON.parse(
            contents,
        ) as Array<{
            date: string;
            root_input: string;
            direct_input: string;
            output: string;
        }>;

        if (seeds.length === 0) {
            continue;
        }

        // We are establishing the timeline of the conversation
        // So the model knows when it happened and just because
        // we made the data available during creation
        const dates =
            seeds
                .map(
                    (seed) =>
                        seed.date,
                )
                .filter(Boolean)
                .sort();

        const earliestDate =
            dates[0];

        const latestDate =
            dates[dates.length - 1];
        
        // Signaler of the memory block we're using for future removal
        createdInjectedContext +=
            `[BEGIN ${memorySeed}]\n`;

        createdInjectedContext +=
            `DATE: Between ${earliestDate} - ${latestDate}\n\n`;

        // We group similar Q & A under the same topic
        // as to not waste tokens appending a topic to each exchange
        const topics =
            new Map<
                string,
                Array<{
                    date: string;
                    root_input: string;
                    direct_input: string;
                    output: string;
                }>
            >();

        for (const seed of seeds) {
            const rootInput =
                seed.root_input.trim();

            if (!topics.has(rootInput)) {
                topics.set(
                    rootInput,
                    [],
                );
            }

            topics
                .get(rootInput)!
                .push(seed);
        }

        let topicNumber = 1;

        for (
            const [
                rootInput,
                topicSeeds,
            ] of topics
        ) {
            createdInjectedContext +=
                `TOPIC_${topicNumber}: ${rootInput}\n`;

            for (
                const seed
                of topicSeeds
            ) {
                createdInjectedContext +=
                    `USER: ${seed.direct_input}\n`;

                createdInjectedContext +=
                    `ASSISTANT: ${seed.output}\n\n`;
            }

            topicNumber += 1;
        }

        // Indicates the end of the memory block
        createdInjectedContext +=
            `[END ${memorySeed}]\n\n`;

        // Before this time injectedMemorySeeds will no longer be null
        // It needed to start as null for a prior if check
        if(injectedMemorySeeds !== null){
            injectedMemorySeeds.push(
                memorySeed,
            );
        }

        addMemorySeedToSelected(memorySeed);
    }

    setConfigSchematics({memorySeedsSelected: getMemorySeedsSelected()});

    return createdInjectedContext;
}

/**
* Simple middleman to figure out which valid memories the user chose to remove
*/
async function promptProcessorRemoveSeeds(
    conversationFileName: string,
    injectedMemorySeeds: string[],
    validMemorySeedsSelected: string[],
    cleanupAllSeeds: boolean,
): Promise<string[]> {

    // Here we check if there were actually seeds removed by the user
    const memorySeedsToRemove =
        injectedMemorySeeds.filter(
            (memorySeed) =>
                !validMemorySeedsSelected.includes(
                    memorySeed,
                ),
        );

    // Second check to make sure there's actually something to remove
    if(memorySeedsToRemove.length > 0) {

        setIsRemovingMemorySeedsQueued(true);

        injectedMemorySeeds = await removeMemorySeeds(conversationFileName, validMemorySeedsSelected, memorySeedsToRemove, cleanupAllSeeds);

    }

    return injectedMemorySeeds;
}

//-----------------------------------------------------------
// Helpers
//-----------------------------------------------------------

function areStringArraysEqualAsSets(
    a: string[],
    b: string[],
): boolean {
    const aSet = new Set(a);
    const bSet = new Set(b);

    if (aSet.size !== bSet.size) {
        return false;
    }

    return [...aSet].every((value) => bSet.has(value));
}

export function normalizeJsonFileName(jsonFileName: string){

    return jsonFileName.replace(/(\.json).*$/, "$1");
}

//-----------------------------------------------------------
// Numbering Instructions
//-----------------------------------------------------------

/**
 * Creates the numbering instructions string that will be pass to the model
 */
async function constructMessageNumberingInstructionReminder(
    messages: ChatMessage[]
): Promise<string>{
    // Model appends message # at the end of the it's response
    // prerequisite to instructing to save memory
    const assistantIndex = messages.filter(isEligibleAssistantMessage).length + 1;

    let numberingInstruction = "";
    const shouldSendNumberInstructions = await promptProcessorScanHistoryForNumberingInstruction(messages) === false;

    // Append full numbering instruction only once if not done yet
    // or if model shown pattern it forgot the instructions
    if (shouldSendNumberInstructions) {
        numberingInstruction = 
            ` Formatting Instruction: This is a reminder to continue appending ***message <##>*** on it's own separate line at the end of each response. `+
            `the <##> placeholder corresponds to your current assistant turn.` +
            `:End of Instruction. Your message number for this turn is ${assistantIndex}.`;
    }

    return numberingInstruction !== ""
    ? numberingInstruction
    : "";
}

/*
* Note: history will always be missing the newest user+assistant message,
* so it's useless during the very first user message in chat.
* This checks if both Formatting Instructions ever were passed to the assistant
* and if the assistant is currently still adhering to number instructions.
* True = Formatting instructions already exist  &&  one of the last 2 assistant messages still adheres to the formatting rule with matching assistantIndex
* False = No formatting instructions exist anywhere || model has clearly forgotten to append message #s
*/
async function promptProcessorScanHistoryForNumberingInstruction(
    messages: ChatMessage[],
): Promise<boolean> {
    let formattingInstructionExists = false;
    const assistantMessages: string[] = [];
    const assistantIndex = messages.filter(isEligibleAssistantMessage).length + 1;
    const expectedNumber = assistantIndex - 1;

    for (const message of messages) {
        for (const content of (message as any).data.content ?? []) {
            if (content.type !== "text" || !content.text) {
                continue;
            }

            if (
                /Formatting Instruction:\s[\s\S]*?:End of Instruction\./i.test(
                    content.text,
                )
            ) {
                formattingInstructionExists = true;
            }
        }
    }

    if (!formattingInstructionExists) {
        return false;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];

        if (!isEligibleAssistantMessage(message)) {
            continue;
        }

        let assistantText = "";

        for (const content of (message as any).data.content ?? []) {
            if (content.type !== "text" || !content.text) {
                continue;
            }

            const text = content.text;

            if (
                text.includes(
                    "__LM_STUDIO_INTERNAL_LSEP_SYNTHETIC_REASONING_END",
                )
            ) {
                continue;
            }

            assistantText += text;
        }

        if (assistantText !== "") {
            assistantMessages.push(assistantText);
        }

        if (assistantMessages.length === 2) {
            break;
        }
    }

    if (assistantMessages.length < 2) {
        return true;
    }

    return assistantMessages.some(text => {
        const backQuarter = text.slice(Math.floor(text.length * 0.75));

        return new RegExp(
            "`?\\*{2,3}\\s*message\\s+" +
            expectedNumber +
            "\\s*\\*{2,3}`?",
            "i",
        ).test(backQuarter);
    });
}

//-----------------------------------------------------------
// Save Memory
//-----------------------------------------------------------

/**
 * Collects and creates the full save memory string that will be pass to the model.
 * This Has instructions to override the model's preivously collected parameters
 * in favor of what we've collected.
 */
async function saveMemoryTextCheckerExtractorConstructor(
    userText: string
): Promise<string>{

    const EXIT_SAVE_MEMORY_REGEX =
        /\bexit\b\s+(?:save|sav|sve|sv|store|remember|persist)\b\s+(?:memory|mem|mm|mmry|memry|mry|mmy|memy)\b/i;

    const exitMatch = userText.match(EXIT_SAVE_MEMORY_REGEX);
    
    const exitRequested = exitMatch !== null? true : false;

    if (exitRequested === true) {
        resetSaveMemoryParameters();

        return (
            `User no longer wishes to save a memory all parameters currently gathered have been released.`
        );
    }

    const SAVE_MEMORY_REGEX =
        /\b(?:save|sav|sve|sv|store|remember|persist)\b.*?\b(?:memory|mem|mm|mmry|memry|mry|mmy|memy)\b(?:\s+message|msg)?\s*(\d+)/i;

    const saveMemoryMatch = userText.match(SAVE_MEMORY_REGEX);
    
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
        const CATEGORY_EXTRACT_REGEX =
            /\b(?:category|categroy|categary|categry|catgry|catagory|catgory|categoy)\b\s+(?:is\s+)?([^;,.]+)/i;

        const NAME_EXTRACT_REGEX =
            /\b(?:name|nmae|nam|nme)\b\s+(?:is\s+)?([^;,.]+)/i;

        if(getSaveMemoryCategory() === null){
            const saveMemoryCategoryMatch = userText.match(CATEGORY_EXTRACT_REGEX);
            if(saveMemoryCategoryMatch) {
                const category = saveMemoryCategoryMatch[1].trim();

                setSaveMemoryCategory(category);
            }
        }

        if(getSaveMemoryName() === null) {
            const saveMemoryNameMatch = userText.match(NAME_EXTRACT_REGEX);
            if(saveMemoryNameMatch){

                const name = saveMemoryNameMatch[1].trim();

                setSaveMemoryName(name);
            }
        }
    }

    // Construct the full memory string to feed to the model
    let constructSaveMemoryStringForModel = "";

    const currentSaveMemoryNumber = getSaveMemoryNumber();
    const currentSaveMemoryCategory = getSaveMemoryCategory();
    const currentSaveMemoryName = getSaveMemoryName();

    const allRequiredFieldsKnown =
        saveMemoryCommandQueued &&
        currentSaveMemoryNumber !== null &&
        (currentSaveMemoryCategory !== null && currentSaveMemoryCategory !== "") &&
        (currentSaveMemoryName !== null && currentSaveMemoryName !== "");
        
    if(allRequiredFieldsKnown) {
        constructSaveMemoryStringForModel += 
        ` The user asked you to use the persist_seed tool. ` +
        `Disregard their previously provided values. Here is their complete command: ` +
        `save memory ${currentSaveMemoryNumber}; category ${currentSaveMemoryCategory}; name ${currentSaveMemoryName}; ` +
        `:End of command.`
    }

    return allRequiredFieldsKnown
        ? constructSaveMemoryStringForModel 
        : "";
}

//-----------------------------------------------------------
// Lock File
//-----------------------------------------------------------

/**
 * Three States for lock
 * Null = plugin has yet to create a lock file, abandoned file if lock detected
 * True = lock was successfully acquired by this plugin
 * False = there was another lock exisiting before this plugin could acquire it
 * This will help regulate the timings of multiple polling plugins.
 * Needed to play with my context cleanup plugin.
 * https://github.com/anh-vudinh/LM-Studio_Context-Cleanup
 * 
 * MAKE SURE WHERE EVER YOU USE THIS ACQUIRELOCK FUNCTION YOU releaseLock() THE CORRESPONDING LOCKFILE CREATED
 * This acquirelock getter and checker cannot tolerate duplicate lockfiles originating from itself. It will error out to the saftey terminate timeout
 * There is tolerance for lock files with dupe names originating from other plugins and unique lockfile names.
 */

const lockFileFunctions = new Map<string, string[]>();

export function addLockFileFunction(
    lockFile: string,
    functionName: string,
): void {
    const functions = lockFileFunctions.get(lockFile) ?? [];

    if (!functions.includes(functionName)) {
        functions.push(functionName);
    }

    lockFileFunctions.set(lockFile, functions);
}

export function removeLockFileFunction(
    lockFile: string,
    functionName: string,
): boolean {
    const functions = lockFileFunctions.get(lockFile);

    if (!functions) {
        return false;
    }

    const index = functions.indexOf(functionName);

    if (index === -1) {
        return false;
    }

    functions.splice(index, 1);

    if (functions.length === 0) {
        lockFileFunctions.delete(lockFile);
    }

    return true;
}

export function getLockFileFunctions(
    lockFile: string,
): string[] {
    return [...(lockFileFunctions.get(lockFile) ?? [])];
}

export async function acquireLock(
    lockFile: string,
    functionName: string,
): Promise<void> {
    const LOCK_STALE_TIMEOUT_MS = 20_000;
    const LOCK_WAIT_TIMEOUT_MS = 25_000;
    const POLL_INTERVAL_MS = 100;

    const startedAt = Date.now();

    while (true) {

        if (Date.now() - startedAt >= LOCK_WAIT_TIMEOUT_MS) {
            throw new Error(
                `Timed out waiting for lock: ${lockFile}`,
            );
        }

        // PM already owns this lock.
        const currentFunctions = lockFileFunctions.get(lockFile);

        if (currentFunctions && currentFunctions.length > 0) {
            addLockFileFunction(lockFile, functionName);

            // console.log(
            //     "===== PM ALREADY OWNS LOCK =====",
            //     lockFile,
            //     "function",
            //     functionName,
            //     "active functions",
            //     getLockFileFunctions(lockFile),
            //     "timestamp",
            //     Date.now(),
            // );

            return;
        }

        try {
            const handle = await open(lockFile, "wx");

            addLockFileFunction(lockFile, functionName);

            // console.log(
            //     "===== PM CREATED LOCK =====",
            //     lockFile,
            //     "function",
            //     functionName,
            //     "active functions",
            //     getLockFileFunctions(lockFile),
            //     "timestamp",
            //     Date.now(),
            // );

            await handle.close();

            return;
        } catch (error) {
            const fsError = error as NodeJS.ErrnoException;

            if (fsError.code !== "EEXIST") {
                throw error;
            }

            // Another PM function may have acquired it
            // while this function was trying to create it.
            const functionsAfterCollision =
                lockFileFunctions.get(lockFile);

            if (
                functionsAfterCollision &&
                functionsAfterCollision.length > 0
            ) {
                addLockFileFunction(lockFile, functionName);

                // console.log(
                //     "===== PM ACQUIRED LOCK AFTER COLLISION =====",
                //     lockFile,
                //     "function",
                //     functionName,
                //     "active functions",
                //     getLockFileFunctions(lockFile),
                //     "timestamp",
                //     Date.now(),
                // );

                return;
            }

            try {
                const stats = await stat(lockFile);
                const lockAge = Date.now() - stats.mtimeMs;

                if (lockAge >= LOCK_STALE_TIMEOUT_MS) {
                    await unlink(lockFile);

                    // console.log(
                    //     "===== OTHER PLUGIN STALE LOCK REMOVED BY PM =====",
                    //     lockFile,
                    //     "timestamp",
                    //     Date.now(),
                    // );

                    continue;
                }
            } catch (error) {
                const fsError = error as NodeJS.ErrnoException;

                if (fsError.code !== "ENOENT") {
                    throw error;
                }

                continue;
            }

            await new Promise<void>((resolve) =>
                setTimeout(resolve, POLL_INTERVAL_MS),
            );
        }
    }
}

export async function releaseLock(
    lockFile: string,
    functionName: string,
): Promise<void> {
    const removed = removeLockFileFunction(
        lockFile,
        functionName,
    );

    if (!removed) {
        throw new Error(
            `Function "${functionName}" does not own lock: ${lockFile}`,
        );
    }

    const remainingFunctions =
        getLockFileFunctions(lockFile);

    // console.log(
    //     "===== PM FUNCTION FINISHED =====",
    //     lockFile,
    //     "function",
    //     functionName,
    //     "remaining functions",
    //     remainingFunctions,
    //     "timestamp",
    //     Date.now(),
    // );

    // PM still has functions using this lock.
    if (remainingFunctions.length > 0) {
        return;
    }

    // Last PM function finished.
    try {
        await unlink(lockFile);

        // console.log(
        //     "===== PM RELEASED LOCK =====",
        //     lockFile,
        //     "timestamp",
        //     Date.now(),
        // );
    } catch (error) {
        const fsError = error as NodeJS.ErrnoException;

        if (fsError.code !== "ENOENT") {
            throw error;
        }
    }
}

//-----------------------------------------------------------
// Coordinating With Context Cleanup Plugin
//-----------------------------------------------------------
export async function maybeCreateACoordinationReadyFileAndAcquireLockFile(
    conversation: any,
    conversationFile: string,
    lockFunctionName: string,
    operation?: () => Promise<void>,
): Promise<void> {
    const enabledPluginsArray = conversation.plugins;

    const hasContextCleanup = enabledPluginsArray.some(
        (plugin: string) => plugin.includes("context-cleanup"),
    );

    const hasPersistingMemories = enabledPluginsArray.some(
        (plugin: string) => plugin.includes("persisting-memories"),
    );

    const originalAssistantLastMessagedAt = conversation.assistantLastMessagedAt;

    const shouldCoordinateWithContextCleanup =
        hasContextCleanup && hasPersistingMemories;

    if (shouldCoordinateWithContextCleanup) {

        const readyFile = `${conversationFile}.persisting-memories-final-write.ready`;

        // Creating the Psudeo wait time polling
        // Ordering matters here, acquire the .lock before creating the ready file for Context Cleanup Plugin to consume.
        await createPseudoWaitTimeForContextCleanupPlugin(
            originalAssistantLastMessagedAt,
            conversationFile,
            lockFunctionName,
            shouldCoordinateWithContextCleanup,
            operation
        )

        try {
            const handle = await open(readyFile, "wx");
            await handle.close();

            // console.log(
            //     "===== PM final-write ready file created =====",
            //     readyFile,
            //     Date.now()
            // );
        } catch (error) {
            const fsError = error as NodeJS.ErrnoException;

            if (fsError.code !== "EEXIST") {
                throw error;
            }

            await unlink(readyFile);

            // console.log(
            //     "===== stale PM final-write ready file removed =====",
            //     readyFile,
            //     Date.now()
            // );

            const handle = await open(readyFile, "wx");
            await handle.close();

            // console.log(
            //     "===== PM final-write ready file recreated =====",
            //     readyFile,
            //     Date.now()
            // );
        }
    }

    // Look in createPseudoWaitTimeForContextCleanupPlugin() if you're looking for the coordination logic function calls,
    // that includes executing functions during coordination.
    // No need for the ready File, we are not coordinating just acquire a lock file, 
    // to protect our duration for editing.
    if (!shouldCoordinateWithContextCleanup) {

        const lockFile = `${conversationFile}.lock`;

        await acquireLock(lockFile, lockFunctionName);

        const pollInterval = shouldCoordinateWithContextCleanup === true
            ? 500   // interval when another plugin created the lock file, shorter interval to act timely
            : 100;  // interval when this plugin created the lock file, longer interval to save resources

        // Initiated polling until assistantLastMessagedAt value changes
        // then initiate the conversation json overwrite
        const pollForAssistantUpdate = setInterval(async () => {
            try {
                const latestJson = await readFile(
                    conversationFile,
                    "utf-8",
                );

                const latestConversation = JSON.parse(latestJson);

                if (latestConversation.assistantLastMessagedAt !== originalAssistantLastMessagedAt) {
                    clearInterval(pollForAssistantUpdate);

                    // If an operation is supplied we wait 2000ms
                    const delay = operation
                            ? 2000  // True = we were supplied an actual function to execute (editting the conversation file.json) must timeout for 2000ms
                            : 0; // False = no function was supplied, we're just a placeholder just cycle through
                
                    // This timeout is to circumvent LM Studio's behavior
                    setTimeout(async () => {
                        // console.log("=====PM OPERATION COMMENCED======", Date.now())
                        try {
                            // Maybe do work or just act as a placeholder
                            await operation?.();
                        } catch (error) {
                            // Maybe do work or just act as a placeholder
                            console.error(`PM operation failed: ${lockFunctionName}`, error);
                        } finally {
                            // console.log("=====PM OPERATION FINISHED======", Date.now());
                            releaseLock(lockFile, lockFunctionName);
                        }
                    }, delay);
                }
            } catch (error) {
                clearInterval(pollForAssistantUpdate);

                console.error(
                    "Error polling for assistant update:",
                    error,
                );
            }
        }, pollInterval);
    }
}

/**
 * Only responsible for creating the ready file and wait time.
 */
async function createPseudoWaitTimeForContextCleanupPlugin (
    originalAssistantLastMessagedAt: any,
    conversationFile: string,
    lockFunctionName: string,
    shouldCoordinateWithContextCleanup: boolean,
    operation?: () => Promise<void>,
): Promise<void> {

    const lockFile = `${conversationFile}.lock`;

    await acquireLock(lockFile, lockFunctionName);

    const pollInterval = shouldCoordinateWithContextCleanup === true
            ? 100   // shorter interval to act timely
            : 500;  // interval when this plugin created the lock file, longer interval to save resources

    // Initiated polling until assistantLastMessagedAt value changes
    // then initiate the conversation json overwrite
    const pollForAssistantUpdate = setInterval(async () => {
        try {
            const latestJson = await readFile(
                conversationFile,
                "utf-8",
            );

            const latestConversation = JSON.parse(latestJson);

            if (latestConversation.assistantLastMessagedAt !== originalAssistantLastMessagedAt) {
                clearInterval(pollForAssistantUpdate);

                const delay = shouldCoordinateWithContextCleanup === true
                        ? 2000  // True = this plugin has the lead, and will be the one to enforce the 2000ms wait time
                        : 10; // False = another plugin has the lead, they will wait the 2000ms we fire off immediately
            
                // This timeout is to circumvent LM Studio's behavior
                setTimeout(async () => {
                    // console.log("=====PM OPERATION COMMENCED======", Date.now())
                    try {
                        // Maybe do work or just act as a placeholder
                        await operation?.();

                        } catch (error) {
                            // Maybe do work or just act as a placeholder
                            console.error(`PM operation failed: ${lockFunctionName}`, error);
                    } finally {
                        // console.log("=====PM OPERATION FINISHED======", Date.now());
                        releaseLock(lockFile, lockFunctionName);
                        // setLockFileOriginatesFromThisPlugin(lockFile, null);
                    }
                }, delay);
            }
        } catch (error) {
            clearInterval(pollForAssistantUpdate);

            console.error(
                "Error polling for assistant update:",
                error,
            );
        }
    }, pollInterval);
}