import type { ChatMessage, PromptPreprocessorController } from "@lmstudio/sdk";
import { setCurrentConversationHistory, getCurrentConversationHistory } from "./conversationHistoryCache";
import { isEligibleAssistantMessage } from "./conversationReader";
import { acquireLock, releaseLock } from "./acquireLockFile";
import { memoryStore } from "./memoryStore";
import { removeMemorySeeds } from "./removeMemorySeeds";
import { saveMemoryTextCheckerExtractorConstructor } from "./saveMemoryTextCheckerExtractorConstructor";
import { join, basename } from "node:path";
import path from "node:path";
import os from "os";

import {
    getMemorySeedsPool,
    updateMemorySeedsSelected,
    addMemorySeedToSelected,
    getMemorySeedsSelected
} from "./memorySession";

import {
    configSchematics,
    setConfigSchematics,
    setIsRemovingMemorySeedsQueued,
    getIsRemovingMemorySeedsQueued,
    getInternalChatID,
    setInternalChatID,
    getConversationFileName,
    setConversationFileName,
} from "./config";

import { 
    readFile, 
    writeFile,
    readdir, 
    stat,
    open,
    unlink
} from "node:fs/promises";

let injectedMemorySeeds: string[] | null = null;
let cleanupAllSeeds: boolean;
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
    const lmStudioRootDirectory = path.join(
        os.homedir(),
        ".lmstudio",
    );
    const memoriesDirectory = await memoryStore.getMemoriesDirectory();

    // Establish initial variable values
    const config = ctl.getPluginConfig(configSchematics);
    const memorySeedsPool = getMemorySeedsPool();
    const memorySeedsSelected = config.get("memorySeedsSelected") as string[];
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

    //------------------------------------
    // Maybe repair a missing relationship bond with in memory data
    //------------------------------------
    if(getInternalChatID() !== "" && getConversationFileName() !== "") {
        // Check that the relationship exists in the relationship file.
        // If it does not, add it. This is the extreme case user is deleting relationships directly from the file and their load bearing user message
        // Two available options in the function, choose which one to enable. Each has it's pros or cons.
        const relationshipReadded = await maybeRepairRelationshipFileWithKnownICIDAndConversationFile(
            lmStudioRootDirectory,
        )

        if(relationshipReadded) {
            createNewInternalChatID = true;
        }
    }

    // ICID UNKNOWN?
    if (getInternalChatID() === "") {
        // SCAN HISTORY IF FOUND ASSIGN IT TO THE INTERNAL MEMORY
        const historyICID = await promptProcessorScanHistoryForID(messages);

        //------------------------------------
        // CONVERSATION FILE NAME KNOWN IN MEMORY BUT ICID UNKNOWN IN HISTORY (USER PROBABLY DELETED LOAD BEARING USER MESSAGE)
        //------------------------------------

        if(historyICID === "") {
            // Recover ICID through the relationship file
            const icidRecovered = await recoverICIDMultiStepMaybeSetConversationFileName(
                lmStudioRootDirectory,
                workingDirectory,
                userText,
            );

            if (icidRecovered) {
                createNewInternalChatID = true;
            }
        }

        //------------------------------------
        // ICID UNKNOWN
        //------------------------------------

        // SCAN HISTORY FAILED
        if(getInternalChatID() === "") {
            // SCAN IT THROUGH THE RELATIONSHIP FILE
            // WE'VE ALSO SET THE CONVERSATION FILE NAME HERE IF WE FOUND IT ALONGSIDE 
            // THE ICID WE MATCHED WHILE LOOKING THROUGH THE RELATIONSHIP FILE
            await promptProcessorTryWorkingDirectoryBaseNameLookupInRelationshipFile(
                lmStudioRootDirectory,
                workingDirectory,
            );
        }

        // ICID COULD NOT BE FOUND AT ALL SO CREATE A FRESH ICID
        if(getInternalChatID() === "") {
            setInternalChatID(Math.floor(Date.now() / 1000).toString());
            createNewInternalChatID = true;
        }
    }

    //------------------------------------
    // ICID NOW KNOWN
    //------------------------------------

    // CONVERSATION FILE NAME UKNOWN?
    if (getConversationFileName() === "") {
        
        // CHECK THE RELATIONSHIP FILE
        await promptProcessorMatchICIDInRelationshipFile(
            lmStudioRootDirectory,
        );

        // CHECK THE WORKING DIRECTORY BASE NAME FILE
        // CHECK FOR A EMBEDDED ICID OR MATCHING CLIENTINPUT
        if (getConversationFileName() === "") {
            await promptProcessorTryWorkingDirectoryConversationFile(
                lmStudioRootDirectory,
                workingDirectory,
                userText,
            );
        }
    }

    // CHECK THE FULL CONVERSATION DIRECTORY FROM NEWEST TO OLDEST
    // CONVERSATION FILES AND CHECK FOR EMBEDDED ICID OR MATCHING CLIENTINPUT
    if(
        getConversationFileName() === "" || 
        createNewInternalChatID === true
    ) {
        await scanForConversationFileThruFullConversationDirectoryScan(
            lmStudioRootDirectory,
            userText,
        );
    }

    //----------------------------------------------------
    // END: CONVERSATION FILE NAME NOW KNOWN && ICID NOW KNOWN
    //----------------------------------------------------

    //----------------------------------------------------
    // BEGIN: Memory Seed Logic
    //----------------------------------------------------
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
    // actually from the available memory pool.
    //
    // category/*.json expands to all current seeds in that category.
    const validMemorySeedsSelected = [
        ...new Set(
            normalizedMemorySeedsSelected.flatMap(
                (memorySeed) => {
                    const wildcardMatch =
                        memorySeed.match(
                            /^([^/]+)\/\*\.json$/i,
                        );

                    if (wildcardMatch) {
                        const category =
                            wildcardMatch[1];

                        return memorySeedsPool.filter(
                            (availableSeed) =>
                                availableSeed.startsWith(
                                    `${category}/`,
                                ),
                        );
                    }

                    return memorySeedsPool.includes(
                        memorySeed,
                    )
                        ? [memorySeed]
                        : [];
                },
            ),
        ),
    ];

    // Scan file first for injected seeds
    // Check on first initialzation, and skip checks later if nothing changed
    // Still works if plugin randomly reinitializes, IMS will be set to null again. 
    // So the current states either
    // matches, doesn't match, or was reset by random initialization.
    let injectedContext = "";

    const currentConversationFileName = getConversationFileName();

    if (
        injectedMemorySeeds === null ||
        !areStringArraysEqualAsSets(injectedMemorySeeds, validMemorySeedsSelected)
    ) {

        injectedMemorySeeds = await promptProcessorConversationFileScanForPreviousSeeds(currentConversationFileName, [...memorySeedsPool]);
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
            currentConversationFileName, 
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
            currentConversationFileName, 
            injectedMemorySeeds, 
            validMemorySeedsSelected, 
            cleanupAllSeeds
        );
    }

    // NORMAL PATH
    // We are not currently trying to remove memory seeds or send a completed save command.
    // But we need to create a 2 second .lock file to coordinate the Context Cleanup Plugin
    // if it is currently in use with alongside this plugin.
    // removingMemorySeeds and shouldSendFullSaveMemoryString will create and call the maybeCreateACoordinationReadyFileAndAcquireLockFile
    // themselves so this path will be bypassed.
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
            currentConversationFileName,
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

    // Reset the state after the check in removing seeds
    // so the next user message can update the upcoming state.
    setIsRemovingMemorySeedsQueued(false);

    // Already tested the order of content, it did not improve abilities of model to adhere to rules.
    // Models forget/disregard things when they want to and take anything as suggestions if they want too.
    return (
        `${userText}.                          ` +
        `${injectedContext? `${injectedContext}[END OF MEMORIES] ` : ""}` +
        `${createNewInternalChatID? `[ICID: ${getInternalChatID()}] Ignore this ICID tag. ` : ""}` +
        `${shouldSendNumberingInstructionString? numberingInstructionStringForModel : "" }` +
        `${shouldSendFullSaveMemoryString? saveMemoryStringForModel : ""}`
    );
}

/**             ______________________________________           
 *             |                                      |
 *             | LMSTUDIO LOVES TO DISCONNECT PLUGINS |
 *             |______________________________________|
 * 
 * FLOW OF SCAN   →    maybeRepairRelationshipFileWithKnownICIDAndConversationFile()         →        promptProcessorScanHistoryForID()           →          recoverICIDMultiStepMaybeSetConversationFileName()              →        promptProcessorTryWorkingDirectoryBaseNameLookupInRelationshipFile()        →       (Generate New ICID)      →           promptProcessorMatchICIDInRelationshipFile()              →           promptProcessorTryWorkingDirectoryConversationFile()             →             scanForConversationFileThruFullConversationDirectoryScan()
 *                                                 ↓                                                                  ↓                                                               ↓                                                                                  ↓                                                                                                          ↓                                                                          ↓                                                                                 ↓
 *                             (ICID && CONVO FILE IN MEMORY? YES/NO)                                     (ICID in history? YES/NO)                             (CFN in Relationship File? YES/NO | GET ICID)                        (Quick lazy check if WD base name is already an existing relationship)                                                (ICID Matches in Relationship File? YES/NO | Get CFN)                    (ICID found in WD Conversation.json? YES/NO | set CFN)                 (Scan through New -> Old Conversation.json Spotted ICID? YES/NO | set CFN)
 *                                                 ↓                                                                  ↓                                                               ↓                                                                                  ↓                                                                                                                                                                                     ↓                                                                                 ↓
 *                  (WRITE missing Relationship | Add ICID to History | Skip all Scans)                     (Add ICID to Memory)                  (Working Directory Base Name in Relationship File? YES/NO | GET ICID)                                 (Reuse pre-existing ICID + set CFN)                                                                                                                                            (ClientInput matches userText? YES/NO | set CFN)                         (During Scan check ClientInput matches userText? YES/NO | set CFN)
 *                                                                                                                                                                                    ↓                                              ______________________________________________________________________                                                                                                                                                                                                                                      ↓
 *                                                                                                                                                  (Scan allConversation Files New -> Old, Found matching clientInput)                                                                                                                                                                                                                                                                                        (WRITE Both CFN and ICID to relationship file if not already present)
 *                                                                                                                                                (in conversation file match to relationship? YES/NO | GET ICID + SET CFN)  →  (Will reuse pre-existing ICID, BOTH ICID AND CFN KNOWN SKIP REMAINING SCANS)                                                                                                                                                                                                       (repair mismatch relationship if present in relationship file)
 *                                                                                                                                                                                    ↓                                                                                                                                                                                                                                                                                                                                                          
 *                                                                                                                                                          (ICID MUST BE KNOWN BY NOW, IF NOT. IT NEVER EXISTED)                                                                                                                                                                                                                                                                                                         
 *                                                                                                                                                                                                                                                                                                                     
 *                                                                                                                                                                                                                                                                                                                                               
 *                                                                                                                                                                                                                                                                                                                            
 */

/**
 * Try to recover InternalChatID tag if the users deleted it from chat.
 */
interface ChatSessionConversationRelationship {
    internalChatID: string;
    conversationFile: string;
}

//-------------------------------
// Scanning options
//-------------------------------

/**
 * Extraordinary case if the user purposely deletes both the relationship entry in the relationship file,
 * and the user's message holding the ICID. We will reinsert the entry using the in memory data.
 */
async function maybeRepairRelationshipFileWithKnownICIDAndConversationFile(
    rootDirectory: string,
): Promise<boolean> {

    const conversationDirectory = join(
        rootDirectory,
        "conversations"
    );

    // Point to the relationship file
    const relationshipFile = join(
        conversationDirectory,
        "ChatSessionConversationRelationship.json",
    );

    const conversationFileName = getConversationFileName();

    const internalChatID = getInternalChatID();

    const lockFile = `${relationshipFile}.lock`;

    const functionName = "maybeRepairRelationshipFileWithKnownICIDAndConversationFile";

    try{
        await acquireLock(lockFile, functionName);

        const relationshipJson = await readFile(
            relationshipFile,
            "utf-8",
        );

        let relationships: ChatSessionConversationRelationship[] =
            JSON.parse(relationshipJson);

        relationships = relationships.filter(
            (relationship) =>
                relationship.internalChatID.trim() !== "" &&
                relationship.conversationFile.trim() !== "",
        );

        const relationship = relationships.find(
            (relationship) => relationship.conversationFile === conversationFileName &&
                relationship.internalChatID === internalChatID
        );

        // The exact relationship we have in memory is missing from the relationship file. CHOOSE ONLY ONE OPTION!!
        // That can only mean the user deleted the load bearing user message and deleted the relationship manually

        //---------------------------
        // OPTION 1: REPAIR THE RELATIONSHIP FILE WITH IN MEMORY DATA 
        // (must create a lock file with it's inherent delay)
        //---------------------------
        if (!relationship) {
                
            relationships.push({
                internalChatID: internalChatID,
                conversationFile: conversationFileName,
            });

            // Keep only the newest relationships.
            if (relationships.length > relationshipsLimit) {
                relationships = relationships.slice(-relationshipsLimit);
            }

            await writeFile(
                relationshipFile,
                JSON.stringify(relationships, null, 2),
                "utf-8",
            );

            return true;
        }

        //---------------------------
        // OPTION 2: RESET THE IN MEMORY DATA SO WE CAN GO THROUGH THE NORMAL PROCESS OF CREATING A BRAND NEW LINK 
        // (no lock file needed, no delay, just a quick read of the relationship file)
        //---------------------------
        // if (!relationship) {
        //     setConversationFileName("");
        //     setInternalChatID("");
        // }

        // Relationship already exists in the file
        if(relationship) {
            return false;
        }

    } catch (error) {
        // move along
    } finally {
        await releaseLock(lockFile, functionName);
    }

    return false;
}

/**
 * Scans history for any exisiting ICID.
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

    // So it does not overwrite an ICID already known in memory, but none exist in history(user deleted it)
    if(searchedInternalChatID !== ""){
        setInternalChatID(searchedInternalChatID);
    }

    return searchedInternalChatID;
}

/**
 * ICID marker in history has been lost, we will try to recover the CFN first through various methods to
 * re-establish the past ICID used.
 * CFN already in memory → check it against the relationship file
 * CFN in memory missing → check WD base name against relationship file
 * WD Base Name fails check → check from newest to oldest conversation files to match clientInput to userText = match means we now know the true conversation file name
 * check for the pre-existing relationship in the relationship file and reuse it. Reinject the re-established ICID.
 */
async function recoverICIDMultiStepMaybeSetConversationFileName(
    rootDirectory: string,
    workingDirectory: string,
    userText: string,
): Promise<boolean>{

    const conversationFileName = getConversationFileName();
    
    const conversationDirectory = join(
        rootDirectory,
        "conversations"
    );

    // Point to the relationship file
    const relationshipFile = join(
        conversationDirectory,
        "ChatSessionConversationRelationship.json",
    );

    // Conversation File Name still available in memory
    if(conversationFileName !== "") {
        try{
            const relationshipJson = await readFile(
                relationshipFile,
                "utf-8",
            );

            const relationships: ChatSessionConversationRelationship[] =
                JSON.parse(relationshipJson);

            const relationship = relationships.find(
                (relationship) => relationship.conversationFile === conversationFileName
            );

            if(relationship) {
                setInternalChatID(relationship.internalChatID);
                return true;
            }

        } catch {
            // move along
        }
    }

    // FALLBACK: JUST A QUICK LOOK UP IF IT WORKS IT WORKS, IF NOT THAT'S ALL WE CAN DO
    // Conversation File Name from Working Directory
    const directoryBaseNameFromWD = basename(workingDirectory);

    const conversationFileNameWD = `${directoryBaseNameFromWD}.conversation.json`;

    try {
        const relationshipJson = await readFile(
            relationshipFile,
            "utf-8",
        );

        const relationships: ChatSessionConversationRelationship[] =
            JSON.parse(relationshipJson);

        const relationship = relationships.find(
            (relationship) => relationship.conversationFile === conversationFileNameWD
        );

        if(relationship) {
            setInternalChatID(relationship.internalChatID);
            return true;
        }
    } catch {
        // move along
    }

    // Check clientInput of all the conversations in directory starting from the newest conversation file
    // No authority to overwrite, just comparing the conversation file found to the relationship file
    const allConversationFiles = await findAllConversationFiles(conversationDirectory);

    for (const conversationFile of allConversationFiles) {

        const conversationJson = await readFile(
            conversationFile,
            "utf-8",
        );

        // Find a matching clientInput text that matches the majority of the user's input
        // Sometimes clientInput did not fully register all of the user's input by the time we read it
        try {
            const conversation = JSON.parse(conversationJson);

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
                // If we already expendend the processing power to confirm the conversation file name
                // we might as well set it.
                setConversationFileName(normalizeJsonFileName(basename(conversationFile)));

                // Check relationship file for a matching internal chat ID
                try {
                    const relationshipJson = await readFile(
                        relationshipFile,
                        "utf-8",
                    );

                    const relationships: ChatSessionConversationRelationship[] =
                        JSON.parse(relationshipJson);

                    const relationship = relationships.find(
                        (relationship) => relationship.conversationFile === getConversationFileName()
                    );

                    if(relationship) {
                        setInternalChatID(relationship.internalChatID);
                        return true;
                    }
                } catch {
                    // move along
                }

                break;
            }
        } catch {
            // Ignore malformed conversation files and continue scanning.
        }
    }

    return false;
}

/**
 * Cheap check to see if a conversation file name can be derived from the working directory base name
 * WD base name sometimes has random alphanumeric suffixes
 */
async function promptProcessorTryWorkingDirectoryBaseNameLookupInRelationshipFile(
    rootDirectory: string,
    workingDirectory: string,
):Promise<void> {

    // Construct the path to the conversation folder
    const conversationDirectory = join(
        rootDirectory,
        "conversations",
    );

    // Point to the relationship file
    const relationshipFile = join(
        conversationDirectory,
        "ChatSessionConversationRelationship.json",
    );

    // Extract the basename of the working directory
    const workingDirectoryBaseName = basename(workingDirectory);

    // Point to the potential conversation file
    const conversationFileName = `${workingDirectoryBaseName}.conversation.json`;

    // Try to read the relationship file
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
        // At worst we are going to reuse an abandoned ICID rather than making a new one
        for (
            let i = relationships.length - 1;
            i >= 0;
            i--
        ) {
            const relationship = relationships[i];

            if (relationship.conversationFile === conversationFileName) {

                // If the conversation file is matched, set the conversation file name in memory
                setConversationFileName(normalizeJsonFileName(conversationFileName));

                // If a matching relationship is found, return its internalChatID
                setInternalChatID(relationship.internalChatID);
            }
        }
    } catch (error) {
        console.error("Error reading relationship file:", error);
    }
}

/**
 * Quick check to match an internal chat ID against the relationship file to derive the conversation file name
 */
async function promptProcessorMatchICIDInRelationshipFile(
    rootDirectory: string,
): Promise<void> {

    // Construct the path to the conversation folder
    const conversationDirectory = join(
        rootDirectory,
        "conversations",
    );

    // Point to the relationship file
    const relationshipFile = join(
        conversationDirectory,
        "ChatSessionConversationRelationship.json",
    );

    // Fetch current internal chat ID
    const currentInternalChatID = getInternalChatID();

    try {
        const relationshipJson = await readFile(
            relationshipFile,
            "utf-8",
        );

        const relationships: ChatSessionConversationRelationship[] =
            JSON.parse(relationshipJson);

        const relationship = relationships.find(
            (relationship) => relationship.internalChatID === currentInternalChatID
        );

        if (relationship) {

            // If a matching relationship is found, set it's conversation file name
            setConversationFileName(normalizeJsonFileName(relationship.conversationFile));
        }

    } catch (error: any) {
        console.error(`Error occurred while reading relationship file: ${error.message}`);
    }
}

/**
 * Check to see if Working Directory base name links to a conversation file, if it does check for the ICID
 * or clientInput in the file to validate the conversation file name
 */
async function promptProcessorTryWorkingDirectoryConversationFile(
    rootDirectory: string,
    workingDirectory: string,
    userText: string,
):Promise<void> {

    // Construct the path to the conversation folder
    const conversationDirectory = join(
        rootDirectory,
        "conversations",
    );

    // Extract the basename of the working directory
    const workingDirectoryBaseName = basename(workingDirectory);

    // Point to the potential conversation file
    const conversationFileName = `${workingDirectoryBaseName}.conversation.json`;

    // Construct the path to the conversation file
    const conversationFilePath = join(
        conversationDirectory,
        conversationFileName,
    );

    const currentInternalChatID = getInternalChatID();

    try {

        // Parse the conversation file
        const conversationJson = await readFile(
            conversationFilePath,
            "utf-8",
        );

        const conversation = JSON.parse(conversationJson);

        // Check for the embedded ICID
        const internalChatIDPattern = new RegExp(
            `\\[ICID:\\s*${currentInternalChatID}\\]`,
        );

        if (internalChatIDPattern.test(conversationJson)) {
            setConversationFileName(normalizeJsonFileName(conversationFileName));

            return;
        }

        // Check if the conversation file has a matching clientInput
        const normalize = (s: string): string =>
            (s ?? "")
                .trim()
                .replace(/\s+/g, " ");

        const clientInput = normalize(conversation.clientInput);

        const input = normalize(userText);

        // Find a matching clientInput text that matches the majority of the user's input
        // Sometimes clientInput did not fully register all of the user's input by the time we read it
        if (
            clientInput.length > 0 &&
            input.startsWith(clientInput)
        ) {
            setConversationFileName(normalizeJsonFileName(conversationFileName));

            return;
        }

    } catch (error: any) {
        if (error.code !== "ENOENT") {
            throw error;
        }

        // File doesn't exist — silently move along.
    }
}

/**
 * Expensive full directory scan of all conversation files from newest to oldest until a match is found between
 * the user's input and a conversation file's clientInput or ICID marker.
 * Highest authority to rewrite the relationship file to update or remove mismatched pairs.
 */
async function scanForConversationFileThruFullConversationDirectoryScan(
    rootDirectory: string,
    userText: string,
):Promise<void> {

    const conversationDirectory = join(
        rootDirectory,
        "conversations"
    );

    const allConversationFiles = await findAllConversationFiles(conversationDirectory);

    const currentInternalChatID = getInternalChatID();

    const internalChatIDPattern = new RegExp(
        `\\[ICID:\\s*${currentInternalChatID}\\]`,
    );

    for (const conversationFile of allConversationFiles) {

        const conversationJson = await readFile(
            conversationFile,
            "utf-8",
        );

        // Check for the embedded ICID
        if (internalChatIDPattern.test(conversationJson)) {

            setConversationFileName(normalizeJsonFileName(basename(conversationFile)));

            break;
        }

        // Find a matching clientInput text that matches the majority of the user's input
        // Sometimes clientInput did not fully register all of the user's input by the time we read it
        try {
            const conversation = JSON.parse(conversationJson);

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
                setConversationFileName(normalizeJsonFileName(basename(conversationFile)));

                break;
            }

        } catch {
            // Ignore malformed conversation files and continue scanning.
        }
    }

    // Point to the relationship file
    const relationshipFile = join(
        conversationDirectory,
        "ChatSessionConversationRelationship.json",
    );

    const lockFile = `${relationshipFile}.lock`;

    const functionName = "scanForConversationFileThruFullConversationDirectoryScan";

    // We should now have both ICID and ConversationFileName in memory
    // Check the relationship file if it already exists, if not we need to create it
    try {
        await acquireLock(lockFile, functionName);

        const relationshipJson = await readFile(
            relationshipFile,
            "utf-8",
        );

        const relationships: ChatSessionConversationRelationship[] =
            JSON.parse(relationshipJson);

        const relationship = relationships.find(
            (relationship) => relationship.internalChatID === currentInternalChatID &&
                relationship.conversationFile === getConversationFileName(),
        );

        // If they already perfectly match we don't need to do anything
        if (relationship) {
            setConversationFileName(normalizeJsonFileName(relationship.conversationFile));
            setInternalChatID(relationship.internalChatID);
            return;
        }

        // If there was not a perfect match, we need to create a new one or modify an old existing relationship

        const matchingIndexes = relationships
            .map((relationship, index) => ({
                relationship,
                index,
            }))
            .filter(
                ({ relationship }) =>
                    relationship.internalChatID === getInternalChatID() ||
                    relationship.conversationFile === getConversationFileName(),
            );

        if (matchingIndexes.length > 0) {

            const filteredRelationships = relationships.filter(
                (_, index) =>
                    !matchingIndexes.some(
                        (match) => match.index === index,
                    ),
            );

            filteredRelationships.push({
                internalChatID: getInternalChatID(),
                conversationFile: getConversationFileName(),
            });

            const relationshipsToWrite =
                filteredRelationships.length > relationshipsLimit
                    ? filteredRelationships.slice(-relationshipsLimit)
                    : filteredRelationships;

            await writeFile(
                relationshipFile,
                JSON.stringify(relationshipsToWrite, null, 4),
                "utf-8",
            );

        } else {

            relationships.push({
                internalChatID: getInternalChatID(),
                conversationFile: getConversationFileName(),
            });

            const relationshipsToWrite =
                relationships.length > relationshipsLimit
                    ? relationships.slice(-relationshipsLimit)
                    : relationships;

            await writeFile(
                relationshipFile,
                JSON.stringify(relationshipsToWrite, null, 4),
                "utf-8",
            );
        }

    } catch (error: any) {
        console.error(`scanForConversationFileThruFullConversationDirectoryScan() error: ${error.message}`);
    } finally {
        await releaseLock(lockFile, functionName);
    }
}

/**
 * Helper for the full scanning of all conversation files to find the ICID
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

            if (entry.isFile()) {
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