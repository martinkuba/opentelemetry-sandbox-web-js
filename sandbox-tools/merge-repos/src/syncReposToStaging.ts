/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { CleanOptions, FileStatusResult, ResetMode, SimpleGit, StatusResult} from "simple-git";
import * as fs from "fs";
import * as path from "path";
import { commitChanges, ICommitDetails } from "./git/commit";
import { createGit } from "./git/createGit";
import { createLocalBranch } from "./git/createLocalBranch";
import { pushToBranch } from "./git/pushToBranch.ts";
import { renameTags } from "./git/renameTags";
import { addRemoteAndFetch, removeRemote, removeTemporaryRemotes } from "./git/remotes";
import { getUser } from "./git/userDetails";
import { checkPrExists } from "./github/checkPrExists";
import { createPullRequest, gitHubCreateForkRepo } from "./github/github";
import { abort, fail, terminate } from "./support/abort";
import { addCleanupCallback, doCleanup } from "./support/clean";
import { isIgnoreFolder } from "./support/isIgnoreFolder";
import { parseArgs, ParsedOptions, SwitchBase } from "./support/parseArgs";
import { processRepos } from "./support/processRepos";
import { IRepoDetails, IRepoSyncDetails } from "./support/types";
import { dumpObj, findCurrentRepoRoot, formatIndentLines, log } from "./support/utils";
import { applyRepoDefaults, MERGE_CLONE_LOCATION, reposToSyncAndMerge, MERGE_ORIGIN_REPO, MERGE_ORIGIN_STAGING_BRANCH, MERGE_DEST_BASE_FOLDER } from "./config";
import { moveRepoTo } from "./support/moveTo";

interface ISourceRepoDetails {
    path: string,
    branch: string,
    message: string
}

/**
 * The command line options for this script
 */
interface SyncRepoToStagingOptions extends SwitchBase {
    cloneTo: string;
    originRepo: string;
    originBranch: string;

    /**
     * Run the script but don't create the final PR and move the destination folder up one level
     * ie. prefix "../" to the cloneTo location
     */
    test: boolean;

    /**
     * Don't create the PR
     */
    noPr: boolean;
}

// The current git repo root
const _gitRoot = findCurrentRepoRoot();

// The path that will be used for the merge git root (clone / working folder)
let _mergeGitRoot: string;

// Holds the current branch, so it can be restore if necessary on normal exit
let _currentBranch: string;

/**
 * The default command line arguments
 */
let _theArgs: ParsedOptions<SyncRepoToStagingOptions> = {
    failed: false,
    values: [],
    switches: {
        cloneTo: MERGE_CLONE_LOCATION,
        originBranch: MERGE_ORIGIN_STAGING_BRANCH,
        originRepo: MERGE_ORIGIN_REPO,
        test: false,
        noPr: false
    }
};

/**
 * Show the Help for this tool
 */
function showHelp() {
    var scriptParts;
    var scriptName = _theArgs.name;
    if (scriptName.indexOf("\\") !== -1) {
        scriptParts = scriptName.split("\\");
        scriptName = scriptParts[scriptParts.length - 1];
    } else if (scriptName.indexOf("/") !== -1) {
        scriptParts = scriptName.split("/");
        scriptName = scriptParts[scriptParts.length - 1];
    }

    console.log("");
    console.log(scriptName + " [-cloneTo <...>][-originBranch <...>][-originRepo <...>]");
    console.log("".padEnd(99, "-"));
    console.log(formatIndentLines(25, ` -cloneTo <location>    - The working location of where to clone the original repo, defaults to \"${MERGE_CLONE_LOCATION}\"`, 99));
    console.log(formatIndentLines(25, ` -originBranch <branch> - Identifies both the initial source and final destination branch for the merge, defaults to \"${MERGE_ORIGIN_STAGING_BRANCH}\"`, 99));
    console.log(formatIndentLines(25, ` -originRepo <repo>     - This identifies both the initial source and the final destination for the merge, defaults to \"${MERGE_ORIGIN_REPO}\"`, 99));

    terminate(2);
}

/**
 * Initialize this script by creating a new git clone instance of the originRepo
 * @param localGit - The SimpleGit instance to use for the current initial repository
 * @param originRepo - The originRepo in the form <owner>/<reponame>
 * @param originBranch - The origin branch to use as the source branch for the local clone
 * @param workingBranch - Identifies the local working branch that will also be pushed to the current users repo
 * @returns A new SimpleGit instance for working with the new local cloned origin repo in the forkDest
 */
async function _init(localGit: SimpleGit, originRepo: string, originBranch: string, workingBranch: string): Promise<SimpleGit> {
    _currentBranch = (await localGit.branch()).current;
    log("Current Branch: " + _currentBranch);

    addCleanupCallback(async () => {
        let currentBranch = (await localGit.branch()).current;
        if (currentBranch !== _currentBranch) {
            log(`Switching back to ${_currentBranch}`);
            await localGit.checkout(_currentBranch).catch(abort(localGit, `Unable to checkout ${_currentBranch}`));
        }
    });

    // Set default values
    applyRepoDefaults(reposToSyncAndMerge);

    _mergeGitRoot = path.resolve(_gitRoot, _theArgs.switches.cloneTo).replace(/\\/g, "/");
    log(`MergeRoot: ${_mergeGitRoot}`);

    const repoTokens = originRepo.split("/");
    if (repoTokens.length !== 2) {
        fail(localGit, `${originRepo} must be in the format <owner>/<repo-name>`);
    }

    const repoName = repoTokens[1];

    let userDetails = await getUser(localGit);
    let destUser = userDetails.name;
    if (!destUser || destUser.indexOf(" ") !== -1) {
        destUser = userDetails.user;
    }

    // Make sure the user has forked the repo and if not create one
    await gitHubCreateForkRepo(_gitRoot, originRepo);

    // Now lets go and create a local repo
    let mergeGit = await createLocalBranch(localGit, _mergeGitRoot, originRepo, originBranch, destUser, repoName, workingBranch, userDetails);

    await removeTemporaryRemotes(mergeGit, reposToSyncAndMerge);
    await removePotentialMergeConflicts(mergeGit, reposToSyncAndMerge, _mergeGitRoot);

    return mergeGit;
}

/**
 * Remove any files that may cause merge conflicts from the source branch that we are going to merge into
 * @param git - The SimpleGit instance to use for this repo
 * @param theRepos - The configured repos that we are going to merge into this branch
 * @param baseFolder - The base folder for this repo
 */
async function removePotentialMergeConflicts(git: SimpleGit, theRepos: IRepoSyncDetails, baseFolder: string): Promise<ICommitDetails> {
    log("Removing Potential merge conflicting files from original branch");
    const files = fs.readdirSync(baseFolder);
    let removed = 0;

    let details = "Deleted...";
    for (let lp = 0; lp < files.length; lp++) {
        let inputFile = files[lp];
        if (!isIgnoreFolder(theRepos, inputFile, true)) {
            log(`Deleting ${inputFile}`);
            await git.rm(inputFile).catch(abort(git, `Unable to remove ${inputFile}`));
            details += "\n - " + inputFile;
            removed++;
        }
    };

    if (removed > 0) {
        let commitDetails = {
            committed: false,
            message: `Removed ${removed} potential conflicting file${removed > 1 ? "s" : ""}${details}`
        };

        commitDetails.committed = await commitChanges(git, commitDetails);

        return commitDetails;
    }

    return null;
}

function getFileStatus(status: StatusResult, name: string): FileStatusResult {
    for (let lp = 0; lp < status.files.length; lp++) {
        if (status.files[lp].path === name) {
            return status.files[lp];
        }
    }

    return null;
}

function logAppendMessage(commitMessage: string, fileStatus :FileStatusResult, message: string) {
    let logMessage: string;
    let thePath = fileStatus ? fileStatus.path : "";
    if (thePath.startsWith(_mergeGitRoot)) {
        thePath = thePath.substring(_mergeGitRoot.length);
    }

    if (fileStatus && thePath && fileStatus.index && fileStatus.working_dir) {
        logMessage = ` - (${fileStatus.index.padEnd(1)}${fileStatus.working_dir.padEnd(1)}) ${thePath} - ${message}`;
    } else if (fileStatus && thePath) {
        logMessage = ` - ${thePath} - ${message}`;
    } else {
        logMessage = ` - ${message}`;
    }

    log(logMessage);
    if (commitMessage.length + logMessage.length < 2048) {
        commitMessage += `\n${logMessage}`;
    } else if (commitMessage.indexOf("...truncated...") === -1) {
        commitMessage += "\n...truncated...";
    }

    return commitMessage;
}

/**
 * Helper to resolve merge conflicts in favor of the original master repo's
 * 
 * The git "status" values
 * ' ' = unmodified
 * M = modified
 * T = file type changed (regular file, symbolic link or submodule)
 * A = added
 * D = deleted
 * R = renamed
 * C = copied (if config option status.renames is set to "copies")
 * U = updated but unmerged
 * 
 * index      workingDir     Meaning
 * -------------------------------------------------
 *            [AMD]   not updated
 * M          [ MTD]  updated in index
 * T          [ MTD]  type changed in index
 * A          [ MTD]  added to index                        <-- (T) not handled
 * D                  deleted from index
 * R          [ MTD]  renamed in index
 * C          [ MTD]  copied in index
 * [MTARC]            index and work tree matches           <-- Not handled here as === Not conflicting
 * [ MTARC]      M    work tree changed since index
 * [ MTARC]      T    type changed in work tree since index <-- not handled, should not occur
 * [ MTARC]      D    deleted in work tree
 *               R    renamed in work tree
 *               C    copied in work tree
 * -------------------------------------------------
 * D             D    unmerged, both deleted
 * A             U    unmerged, added by us                 <-- not handled, should not occur
 * U             D    unmerged, deleted by them
 * U             A    unmerged, added by them
 * D             U    unmerged, deleted by us
 * A             A    unmerged, both added
 * U             U    unmerged, both modified
 * -------------------------------------------------
 * ?             ?    untracked
 * !             !    ignored
 * -------------------------------------------------
 */
async function resolveConflictsToTheirs(git: SimpleGit, commitDetails: ICommitDetails, performCommit: boolean): Promise<boolean> {

    function describeStatus(status: string) {
        switch(status) {
            case "_":
                return "Not Modified";
            case "M":
                return "Modified";
            case "T":
                return "Type Changed";
            case "A":
                return "Added";
            case "D":
                return "Deleted";
            case "R":
                return "Renamed";
            case "C":
                return "Copied";
            case "U":
                return "Updated";
            default:
        }

        return "Unknown(" + status + ")";
    }
            
    let status = await git.status().catch(abort(git, "Unable to get status")) as StatusResult;
    if (status.conflicted.length === 0) {
        log(`No Conflicts - ${commitDetails.message}`)
        // No Conflicts
        return false;
    }

    let commitSummary = {
    };

    log(`Resolving ${status.conflicted.length} conflicts`);
    commitDetails.message += `\n### Auto resolving ${status.conflicted.length} conflict${status.conflicted.length > 1 ? "s" : ""} to select the master repo version`;

    let commitMessage = "";
    for (let lp = 0; lp < status.conflicted.length; lp++) {
        let conflicted = status.conflicted[lp];
        let fileStatus = getFileStatus(status, conflicted);
        let fileState = `${fileStatus.index.padEnd(1)}${fileStatus.working_dir.padEnd(1)}`.replace(/\s/g, "_");

        commitSummary[fileState] = (commitSummary[fileState] + 1 || 1);

        if (fileStatus.index === "D") {
            // index      workingDir     Meaning
            // -------------------------------------------------
            // D                  deleted from index
            // D             D    unmerged, both deleted
            // D             U    unmerged, deleted by us
            if (fileStatus.working_dir === "U") {
                // Deleted by Us
                commitMessage = logAppendMessage(commitMessage, fileStatus, "Deleted by us => checkout theirs");
                await git.checkout([
                    "--theirs",
                    conflicted
                ]);

                await git.raw([
                    "add",
                    "-f",
                    conflicted]);
            } else {
                commitMessage = logAppendMessage(commitMessage, fileStatus, `Removed from ${fileStatus.working_dir === "D" ? "both" : "theirs"}`);
                await git.rm(conflicted);
            }
        } else if (fileStatus.index === "A") {
            // index      workingDir     Meaning
            // -------------------------------------------------
            // [ MTARC]      M    work tree changed since index
            // [ MTARC]      D    deleted in work tree
            // A             A    unmerged, both added
            // A             U    unmerged, added by us                     <-- This could mean that it was deleted from their repo or just added by us and changes from historical versions that merge could not resolve
            // -------------------------------------------------
            // Not handled
            // -------------------------------------------------
            // [MTARC]            index and work tree matches               <-- Not conflicting
            // [ MTARC]      T    type changed in work tree since index     <-- Also should not occur
            if (fileStatus.working_dir === "A") {
                commitMessage = logAppendMessage(commitMessage, fileStatus, "Added in both => checkout theirs");
                await git.checkout([
                    "--theirs",
                    conflicted
                ]);

                await git.raw([
                    "add",
                    "-f",
                    conflicted]);
            } else if (fileStatus.working_dir === "M") {
                commitMessage = logAppendMessage(commitMessage, fileStatus, "Added in theirs, modified in ours => checkout theirs");
                await git.checkout([
                    "--theirs",
                    conflicted
                ]);

                await git.raw([
                    "add",
                    "-f",
                    conflicted]);
            } else if (fileStatus.working_dir === "D") {
                commitMessage = logAppendMessage(commitMessage, fileStatus, "Added in theirs, deleted in ours => checkout theirs");
                await git.checkout([
                    "--theirs",
                    conflicted
                ]);

                await git.raw([
                    "add",
                    "-f",
                    conflicted]);
            } else if (fileStatus.working_dir === "U") {
                commitMessage = logAppendMessage(commitMessage, fileStatus, "Added in ours => checkout ours");
                // Just checkout (keep) our version and any changes / deletions will be resolved during during sync validation steps
                await git.checkout([
                    "--ours",
                    conflicted
                ]);

                await git.raw([
                    "add",
                    "-f",
                    conflicted]);
            } else {
                commitMessage = logAppendMessage(commitMessage, fileStatus, `Unsupported automatic merge state for ${conflicted}`);
            }
        } else if (fileStatus.index === "R") {
            // index      workingDir     Meaning
            // -------------------------------------------------
            // [ MTARC]      M    work tree changed since index
            // [ MTARC]      D    deleted in work tree
            // -------------------------------------------------
            // Not handled
            // -------------------------------------------------
            // [MTARC]            index and work tree matches           <-- Not conflicting
            // [ MTARC]      T    type changed in work tree since index
            if (fileStatus.working_dir === "M") {
                commitMessage = logAppendMessage(commitMessage, fileStatus, "Renamed in theirs, modified in ours => remove local and checkout theirs");
                await git.checkout([
                    "--theirs",
                    conflicted
                ]);

                await git.raw([
                    "add",
                    "-f",
                    conflicted]);
            } else if (fileStatus.working_dir === "D") {
                commitMessage = logAppendMessage(commitMessage, fileStatus, "Renamed in theirs, deleted in ours => checkout theirs");
                await git.checkout([
                    "--theirs",
                    conflicted
                ]);

                await git.raw([
                    "add",
                    "-f",
                    conflicted]);
            } else {
                commitMessage = logAppendMessage(commitMessage, fileStatus, "!!! Unsupported automatic renamed merge state");
            }
        } else if (fileStatus.index === "U") {
            // index      workingDir     Meaning
            // -------------------------------------------------
            // U             D    unmerged, deleted by them
            // U             A    unmerged, added by them
            // U             U    unmerged, both modified
            if (fileStatus.working_dir === "D") {
                commitMessage = logAppendMessage(commitMessage, fileStatus, "Unmerged, deleted by them => remove");
                await git.rm(conflicted);
            } else if (fileStatus.working_dir === "A") {
                commitMessage = logAppendMessage(commitMessage, fileStatus, "Unmerged, added by them => checkout theirs");
                await git.checkout([
                    "--theirs",
                    conflicted
                ]);

                await git.raw([
                    "add",
                    "-f",
                    conflicted]);
            } else if (fileStatus.working_dir === "U") {
                commitMessage = logAppendMessage(commitMessage, fileStatus, "Unmerged, both modified => checkout theirs");
                await git.checkout([
                    "--theirs",
                    conflicted
                ]);

                await git.raw([
                    "add",
                    "-f",
                    conflicted]);
            } else {
                commitMessage = logAppendMessage(commitMessage, fileStatus, "Unsupported automatic unmerged state");
            }
        } else {
            commitMessage = logAppendMessage(commitMessage, fileStatus, " => checkout theirs");
            await git.checkout([
                "--theirs",
                conflicted
            ]);

            await git.raw([
                "add",
                "-f",
                conflicted]);
        }
    }

    status = await git.status().catch(abort(git, "Unable to get status")) as StatusResult;
    if (status.conflicted.length !== 0) {
        await fail(git, `Still has conflicts ${status.conflicted.length} we can't auto resolve - ${commitMessage}\n${JSON.stringify(status.conflicted, null, 4)}`);
    }

    let summaryKeys = Object.keys(commitSummary);
    if (summaryKeys.length > 0) {
        commitDetails.message += "\nSummary of changes by file state";
        summaryKeys.forEach((value) => {
            let status = describeStatus(value[0]) + " <=> " + describeStatus(value[1]);
            commitDetails.message += `\n${value} (${status}): ${commitSummary[value]}`;
        });
    }

    commitDetails.message += `\n${commitMessage}`;

    // Directly committing as using "git merge --continue" will ALWAYS popup an editor
    if (performCommit) {
        return await commitChanges(git, commitDetails);
    }

    return false;
}

async function checkFixBadMerges(git: SimpleGit, repoName: string, baseFolder: string, destFolder: string, commitDetails: ICommitDetails, level: number) {

    // Get master source files
    const masterFiles = fs.readdirSync(baseFolder);
    const destFiles = fs.readdirSync(destFolder);

    function _isVerifyIgnore(source: string, ignoreOtherRepoFolders: boolean) {
        if (source === "." || source === ".." || source === ".git" || source === ".vs") {
            // Always ignore these
            return true;
        }

        let isDefined = false;

        // Don't ignore the auto-merge folder
        if (source === MERGE_DEST_BASE_FOLDER) {
            // Always process this folder
            return false;
        }
        
        if (reposToSyncAndMerge) {
            let repoNames = Object.keys(reposToSyncAndMerge);
            for (let lp = 0; lp < repoNames.length; lp++) {
                let repoDestFolder = reposToSyncAndMerge[repoNames[lp]].destFolder;
                if (repoName === repoNames[lp]) {
                    if ((destFolder + "/" + source + "/").indexOf("/" + repoDestFolder + "/") !== -1) {
                        // Always process this folder if it's the current repo
                        return false;
                    }
                } else {
                    if (repoDestFolder === source || (destFolder + "/" + source + "/").indexOf("/" + repoDestFolder + "/") !== -1 || (destFolder + "/" + source).endsWith("/" + repoDestFolder)) {
                        isDefined = ignoreOtherRepoFolders;
                    }
                }
            }
        }
    
        return isDefined;
    }

    async function validateFile(masterFile: string, destFile: string) {
        let changed = false;
        if (fs.existsSync(destFile)) {
            // Compare contents
            let destStats = fs.statSync(destFile);
            let masterStats = fs.statSync(masterFile);
            if (destStats.size !== masterStats.size) {
                // File size is different so was not moved / merged correctly
                commitDetails.message = logAppendMessage(commitDetails.message, { index: "x", working_dir: "S", path: destFile } , `Re-Copying master file as size mismatch ${destStats.size} !== ${masterStats.size}`);
                fs.copyFileSync(masterFile, destFile);
                changed = true;
            } else {
                // Same file size, so compare contents
                let masterContent = fs.readFileSync(masterFile);
                let destContent = fs.readFileSync(destFile);
                if (masterContent.length !== destContent.length) {
                    // File content is different so was not moved / merged correctly
                    commitDetails.message = logAppendMessage(commitDetails.message, { index: "x", working_dir: "C", path: destFile } , "Re-Copying master file as content mismatch");
                    fs.copyFileSync(masterFile, destFile);
                    changed = true;
                } else {
                    let isSame = true;
                    let lp = 0;
                    while (isSame && lp < masterContent.length) {
                        if (masterContent[lp] !== destContent[lp]) {
                            isSame = false;
                        }
                        lp++;
                    }

                    if (!isSame) {
                        // File content is different so was not moved / merged correctly
                        commitDetails.message = logAppendMessage(commitDetails.message, { index: "x", working_dir: "C", path: destFile } , "Re-Copying master file as content is different");
                        fs.copyFileSync(masterFile, destFile);
                        changed = true;
                    }
                }
            }
        } else {
            // Missing dest so was not moved / merged correctly
            commitDetails.message = logAppendMessage(commitDetails.message, { index: "x", working_dir: "M", path: destFile } , "Re-Copying master file");
            fs.copyFileSync(masterFile, destFile);
            changed = true;
        }

        return changed;
    }

    log(` - (Verifying) ${baseFolder} <=> ${destFolder}`);
    for (let mLp = 0; mLp < masterFiles.length; mLp++) {
        let theFile = masterFiles[mLp];
        if (!_isVerifyIgnore(theFile, true)) {
            // log(` - (...) ${baseFolder + "/" + masterFiles[mLp]} ==> ${theFile}`);
            let masterStats = fs.statSync(baseFolder + "/" + theFile);
            if (masterStats.isDirectory()) {
                if (fs.existsSync(destFolder + "/" + theFile)) {
                    let destStats = fs.statSync(destFolder + "/" + theFile);
                    if (destStats.isDirectory()) {
                        await checkFixBadMerges(git, repoName, baseFolder + "/" + theFile, destFolder + "/" + theFile, commitDetails, level + 1);
                    } else {
                        log(` - (Mismatch) ${destFolder + "/" + theFile} is not a folder`);
                        commitDetails.message = logAppendMessage(commitDetails.message, { index: "x", working_dir: "T", path: destFolder + "/" + theFile } , "Dest is file should be folder");
                        await git.rm(destFolder + "/" + theFile)
    
                        fs.mkdirSync(destFolder + "/" + theFile);
                        await checkFixBadMerges(git, repoName, baseFolder + "/" + theFile, destFolder + "/" + theFile, commitDetails, level + 1);
                    }
                } else {
                    log(` - (Missing) ${baseFolder} <=> ${destFolder}`);
                    fs.mkdirSync(destFolder + "/" + theFile);
                    await checkFixBadMerges(git, repoName, baseFolder + "/" + theFile, destFolder + "/" + theFile, commitDetails, level + 1);
                }
            } else {
                // Assume file
                if (validateFile(baseFolder + "/" +  theFile,  destFolder + "/" +  theFile)) {

                    await git.raw([
                        "add",
                        "-f",
                        destFolder + "/" +  theFile]);
                }
            }
        } else {
            log(` - (xI) ${baseFolder + "/" + masterFiles[mLp]} ==> ${theFile}`);
        }
    }

    // Remove any files / folders that do not exist in the master repo
    for (let dLp = 0; dLp < destFiles.length; dLp++) {
        let destFile = destFiles[dLp];
        if (masterFiles.indexOf(destFile) === -1 && !_isVerifyIgnore(destFile, true)) {
            let destStats = fs.statSync(destFolder + "/" + destFile);
            if (destStats.isDirectory()) {
                commitDetails.message = logAppendMessage(commitDetails.message, { index: "*", working_dir: "F", path: destFolder + "/" + destFile } , `Removing extra folder ${destFile}`);
                await git.raw([
                    "rm",
                    "-f",
                    "-r",
                    destFolder + "/" + destFile]);
                // fs.rmdirSync(destFolder + "/" + destFile, {
                //     recursive: true
                // });
            } else {
                commitDetails.message = logAppendMessage(commitDetails.message, { index: "*", working_dir: "E", path: destFolder + "/" + destFile } , "Removing extra file");
                await git.rm(destFolder + "/" + destFile);
            }
        }
    }
}

async function getAndSyncSrcRepo(git: SimpleGit, repoName: string, details: IRepoDetails): Promise<ISourceRepoDetails> {

    // Get a clone of the source repo and reset to the starting point
    let srcOriginRepoUrl = details.url;
    let srcOriginBranch = details.branch;

    let forkDestOrg =  _mergeGitRoot + "-" + repoName;

    // Now lets go and create a local clone
    log(`Cloning the source repo ${srcOriginRepoUrl} branch ${srcOriginBranch} to ${forkDestOrg}`);
    await git.clone(srcOriginRepoUrl, forkDestOrg, [ "-b", srcOriginBranch]);

    let orgGit = createGit(forkDestOrg, "merge.org." + repoName + ".git");
    let checkoutArgs = [
        "--progress",
        "-B", srcOriginBranch
    ];

    if (details.branchStartPoint) {
        // Used for testing the the consistent "merging" over time based on using the configured
        // tags (startPoints) from the original master repo.
        checkoutArgs.push(details.branchStartPoint);
    } else {
        checkoutArgs.push("HEAD")
    }

    await orgGit.checkout(checkoutArgs);

    // Reset the local branch to the requested HEAD (or mergeStartPoint -- used for testing)
    log("Resetting...");
    await orgGit.reset(["--hard"]).catch(abort(git, "Failed to hard reset"));

    // Remove any untracked files in this local branch
    log("Cleaning...");
    // The excludes where for local development / branch purposes to ensure local changes where not lost
    await orgGit.clean([CleanOptions.RECURSIVE, CleanOptions.FORCE], ["-e", "/.vs"]).catch(abort(git, "Failed during clean"));

    let hashDetails = await orgGit.show(["-s", details.branchStartPoint ? details.branchStartPoint : "HEAD"]).catch(abort(git, `Failed getting hash details ${details.branchStartPoint ? details.branchStartPoint : "HEAD"}`));

    let commitHash: string = "";
    let commitDetails = /^commit\s+(\w+)/g.exec(hashDetails || "");
    if (commitDetails && commitDetails[1]) {
        commitHash = commitDetails[1];
    }

    let ignoreTags: string[] = [];
    Object.keys(reposToSyncAndMerge).forEach((value) => {
        ignoreTags.push(reposToSyncAndMerge[value].tagPrefix + "/");
    });

    // rename the tags from the original repos so they have a prefix and remove the original
    await renameTags(orgGit, reposToSyncAndMerge, details.tagPrefix + "/", ignoreTags);

    let moveCommitMessage: ICommitDetails = {
        committed: false,
        message: `${repoName} @ [${commitHash.substring(0, 7)}...](${details.url}/commit/${commitHash})\n${hashDetails}`
    }

    // Now Move the merger project to its final destination folder
    await moveRepoTo(orgGit, forkDestOrg, "", details.destFolder, moveCommitMessage);

    return {
        path: forkDestOrg,
        branch: srcOriginBranch,
        message: moveCommitMessage.message
    };
}

/**
 * Merge the temporary local "merge" branches (used to merge the original master repos into this repo so we have
 * their history here) branch into the final staging merge branch.
 * @param git - The SimpleGit instance for the repo to use
 * @param destBranch - This is the final destination branch to merge the master repo branches into
 * @param details - The holder for the commit details
 * @returns A new ICommitDetails which identifies the changes performed for this function, which may or may not
 * include details from the passed branchCommitDetails.
 */
async function mergeBranchToMergeMaster(git: SimpleGit, mergeBranchName: string, destBranch: string, destFolder: string, branchCommitDetails: ICommitDetails): Promise<ICommitDetails> {
    log(`Merging ${mergeBranchName} to merge ${destBranch}`);

    // Switch back to the merge branch 
    log(`Checking out ${destBranch}`);
    await git.checkout(destBranch);

    let mergeMessage = "";
    if (branchCommitDetails.message) {
        let branchCommitLines = branchCommitDetails.message.split("\n");
        let idx = 0;
        let cnt = 0;
        while (cnt < 5) {
            if (branchCommitLines[idx]) {
                if (cnt === 0) {
                    mergeMessage += "## " + branchCommitLines[idx];
                } else {
                    mergeMessage += "\n  - " + branchCommitLines[idx];
                }
                cnt++;
            }

            idx++;
        }

        if (branchCommitLines.length >= idx ) {
            mergeMessage += "\n  - ...";
        }
    }

    if (!mergeMessage) {
        mergeMessage = `## Merging changes from local branch ${mergeBranchName}`;
    }

    let mergeCommitMessage: ICommitDetails = {
        committed: false,
        message: mergeMessage
    };

    log(`Merging ${mergeBranchName}`)
    let commitPerformed = false;
    await git.merge([
        "--allow-unrelated-histories",
        "--no-commit",
        "-X", "theirs",
        "--progress",
        "--no-ff",
        "--no-edit",
        mergeBranchName]).catch(async (reason) => {
            commitPerformed = await resolveConflictsToTheirs(git, mergeCommitMessage, false);
        });

    mergeCommitMessage.committed = await commitChanges(git, mergeCommitMessage) || commitPerformed;

    return mergeCommitMessage;
}

//---------------------------------------------------------------------------------------------------------------
// Main Script execution
//---------------------------------------------------------------------------------------------------------------

if (!_gitRoot) {
    console.error("Unable to locate the repo root");
    terminate(2);
}

addCleanupCallback(async (git: SimpleGit)  => {
    //await removeTemporaryRemotes(git, reposToSyncAndMerge);
});

_theArgs = parseArgs({
    switches: {
        cloneTo: true,
        originBranch: true,
        originRepo: true,
        test: false,
        noPr: false
    },
    defaults: {
        values: _theArgs.values,
        switches: _theArgs.switches
    }
});

if (_theArgs.switches.showHelp) {
    showHelp();
}

if (_theArgs.failed) {
    fail(null, `Failed parsing arguments - ${JSON.stringify(_theArgs.errors, null, 4)}`);
}

const localGit = createGit(_gitRoot, "local.git");
log(`CWD: ${process.cwd()}; gitRoot: ${_gitRoot}`);

localGit.checkIsRepo().then(async (isRepo) => {
    if (isRepo) {
        // Lets go and process the repos
        log("We have a repo");
        const originRepo = _theArgs.switches.originRepo;
        const originRepoUrl = "https://github.com/" + originRepo;
        const originBranch = _theArgs.switches.originBranch;
        let createPr = !_theArgs.switches.noPr;
        if (_theArgs.switches.test ) {
            createPr = false;
            _theArgs.switches.cloneTo = "../" + _theArgs.switches.cloneTo;
        }

        let userDetails = await getUser(localGit);

        let workingBranch = userDetails.name + "/" + (originBranch.replace(/\//g, "-"));
        if (userDetails.name.indexOf(" ") !== -1) {
            workingBranch = userDetails.user + "/" + (originBranch.replace(/\//g, "-"));
        }

        const mergeGit = await _init(localGit, originRepo, originBranch, workingBranch);

        let existingPr = await checkPrExists(mergeGit, _mergeGitRoot, originRepoUrl, originBranch);
        if (existingPr) {
            await fail(localGit, `A PR already exists -- please commit or close the previous PR`)
        }

        let prTitle = "[AutoMerge] Merging change(s) from ";
        let prBody = "";
        let prRequired = false;
        
        console.log("Merge all Repos");

        let branchCommitDetails: { [key: string]: ICommitDetails } = { };

        // Merge and Sync all of the source repos
        await processRepos(reposToSyncAndMerge, async (repoName, repoDetails) => {
            log(`Merging ${repoName} from ${repoDetails.url} using ${repoDetails.mergeBranchName} into ${repoDetails.destFolder}`);

            let sourceDetails = await getAndSyncSrcRepo(mergeGit, repoName,repoDetails);

            log(`Adding Remote ${repoName} => ${sourceDetails.path} ${sourceDetails.branch}`)
            // Add the new source repo as the remote
            await addRemoteAndFetch(mergeGit, repoName, {
                url: sourceDetails.path,
                branch: sourceDetails.branch
            });

            branchCommitDetails[repoName] = {
                committed: false,
                message: "Merging " + sourceDetails.message
            };

            log("Merge Staged Repo into main merge staging");            
            let mergeBranchName = repoName + "/" + sourceDetails.branch
            let commitDetails = await mergeBranchToMergeMaster(mergeGit, mergeBranchName, workingBranch, repoDetails.destFolder, branchCommitDetails[repoName]);
            if (commitDetails.committed) {
                prTitle += repoName + "; ";
                if (prBody) {
                    prBody += "\n";
                }
                prBody += `# Changes from ${repoName}@${repoDetails.branch} (${repoDetails.url})\n${commitDetails.message}`;
                prRequired = true;
            }

            try {
                // Attempt to push the tags to the origin
                await mergeGit.pushTags("origin");
            } catch (e) {
                log(`Unable to push tags to origin - ${dumpObj(e)}`);
            }

            await removeRemote(mergeGit, repoName);
        });

        log("-----------------------------------------------");
        log("Now check for merge issues and fix from staging");
        log("-----------------------------------------------");
        let fixMergeCommitDetails: ICommitDetails = {
            committed: false,
            message: `Identifying and fixing merge issues from staged repos`
        };
    
        // Validate and fixup any bad merges that may have occurred -- make sure the source and new merged repo contain the same files
        await processRepos(reposToSyncAndMerge, async (repoName, repoDetails) => {
            fixMergeCommitDetails.message += `\nProcessing ${repoName}`;
            let stagingRoot = _mergeGitRoot + "-" + repoName;
            await checkFixBadMerges(mergeGit, repoName, stagingRoot, _mergeGitRoot, fixMergeCommitDetails, 0);
            if (!prRequired) {
                prTitle += repoName + "; ";
            }
        });

        // Commit changes to local branch
        fixMergeCommitDetails.committed = await commitChanges(mergeGit, fixMergeCommitDetails);

        if (!prRequired && fixMergeCommitDetails.committed) {
            if (prBody) {
                prBody += "\n";
            }
            if (prBody) {
                prBody += "\n";
            }
            prBody += `# Found and Fixed merge issues\n${fixMergeCommitDetails.message}`;
            prRequired = true;
        }

        if (prRequired && createPr && await pushToBranch(mergeGit)) {
            await createPullRequest(mergeGit, _mergeGitRoot, prTitle, prBody, originRepo, originBranch);

            try {
                // Attempt to push the tags to the origin
                await mergeGit.pushTags("origin");
            } catch (e) {
                log(`Unable to push tags to origin - ${dumpObj(e)}`);
            }

            try {
                // Attempt to push the tags to the originRepo
                await mergeGit.pushTags("upstream");
            } catch (e) {
                log(`Unable to push tags to upstream - ${dumpObj(e)}`);
            }
        }

        await doCleanup(mergeGit);
    } else {
        await fail(localGit, "We are not running inside a repo");
    }
}, async (reason) => {
    await fail(localGit, "Unable to check if this is a valid repo - " + JSON.stringify(reason));
});