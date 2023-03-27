// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import { promisify } from "util";
import * as vscode from "vscode";
import { sendError, sendInfo } from "vscode-extension-telemetry-wrapper";
import { LSDaemon } from "./daemon";
import { getExpService } from "../exp";
import { TreatmentVariables } from "../exp/TreatmentVariables";

const delay = promisify(setTimeout);

let daemon: LSDaemon;
export async function initDaemon(context: vscode.ExtensionContext) {
   daemon = new LSDaemon(context);
   await daemon.initialize();

   const activated = await checkJavaExtActivated(context);
   if (activated) {
      daemon.logWatcher.sendStartupMetadata("redhat.java activated");
   }
}

async function checkJavaExtActivated(_context: vscode.ExtensionContext): Promise<boolean> {
   const javaExt = vscode.extensions.getExtension("redhat.java");
   if (!javaExt) {
      return false;
   }

   vscode.workspace.onDidGrantWorkspaceTrust(() => {
      checkIfJavaServerCrashed(30 * 1000 /*ms*/);
   });

   // wait javaExt to activate
   const timeout = 30 * 60 * 1000; // wait 30 min at most
   let count = 0;
   while(!javaExt.isActive && count < timeout) {
      await delay(1000);
      count += 1000;
      if (count % 10000 === 0) {
         checkIfJavaServerCrashed();
      }
   }

   if (!javaExt.isActive) {
      sendError(new Error("redhat.java extension not activated within 30 min"));
      daemon.logWatcher.sendStartupMetadata("redhat.java activation timeout");
      return false;
   }

   traceLSPPerformance(javaExt);

   // on ServiceReady
   javaExt.exports.onDidServerModeChange(async (mode: string) => {
      if (mode === "Hybrid") { // begin to start standard language server
         checkIfJavaServerCrashed(30 * 1000 /*ms*/);
      }

      if (mode === "Standard") {
         daemon.logWatcher.sendStartupMetadata("jdtls standard server ready");

         daemon.logWatcher.stop(); // Only focus on errors occurred during startup.

         // watchdog
         if (await daemon.processWatcher.start()) {
            daemon.processWatcher.monitor();
         } else {
            sendError(new Error("jdtls watchdog is not started"));
         }
      }
   });

   return true;
}

const INTERESTED_REQUESTS: Set<string> = new Set([
   "initialize",
   "textDocument/completion",
]);
async function traceLSPPerformance(javaExt: vscode.Extension<any>) {
   const javaExtVersion = javaExt.packageJSON?.version;
   const isPreReleaseVersion = /^\d+\.\d+\.\d{10}/.test(javaExtVersion);
   const isTreatment = !isPreReleaseVersion && 
      (await getExpService()?.getTreatmentVariableAsync(TreatmentVariables.VSCodeConfig, TreatmentVariables.JavaCompletionSampling, true /*checkCache*/) || false);
   const sampling: string = isPreReleaseVersion ? "pre-release" : (isTreatment ? "sampling" : "");
   // Trace the interested LSP requests performance
   javaExt.exports?.onDidRequestEnd((traceEvent: any) => {
      if (!traceEvent.error && !isPreReleaseVersion && !isTreatment) {
         return;
      }

      if (INTERESTED_REQUESTS.has(traceEvent.type)) {
         // See https://github.com/redhat-developer/vscode-java/pull/3010
         // to exclude the invalid completion requests.
         if (!traceEvent.error && !traceEvent.resultLength && traceEvent.type === "textDocument/completion") {
            return;
         }

         sendTrace(traceEvent, javaExtVersion, sampling);
         return;
      }
   });
}

function sendTrace(traceEvent: any, javaExtVersion: any, sampling: string) {
   let code: number = 0;
   let errorMessage: string = "";
   if (traceEvent.error) {
      code = traceEvent.error?.code || 0;
      errorMessage = traceEvent.error?.message || String(traceEvent.error);
   }

   if (errorMessage) {
      sendInfo("", {
         name: "lsp",
         kind: escapeLspRequestName(traceEvent.type),
         duration: Math.trunc(traceEvent.duration),
         code,
         message: errorMessage,
         javaversion: javaExtVersion,
      });
      return;
   }

   sendInfo("", {
      name: "lsp",
      kind: escapeLspRequestName(traceEvent.type),
      duration: Math.trunc(traceEvent.duration),
      resultLength: traceEvent.resultLength,
      javaversion: javaExtVersion,
      remark: sampling,
   });
}

let corruptedCacheDetected: boolean = false;
async function checkIfJavaServerCrashed(wait: number = 0/*ms*/) {
   if (corruptedCacheDetected) {
      return;
   }

   // wait Java Language Server to start
   if (wait) {
      await delay(wait);
   }

   // TODO: not to call start() repeatedly. @testforstephen
   // daemon.processWatcher.start() can return false when there is no embedded jre, where you cannot judge whether the process is started or not.
   const corruptedCache = !await daemon.processWatcher.start() && await daemon.logWatcher.checkIfWorkspaceCorrupted();
   if (!corruptedCacheDetected && corruptedCache) {
      corruptedCacheDetected = true;
      sendInfo("", {
         name: "corrupted-cache",
      });
      const ans = await vscode.window.showErrorMessage("Java extension cannot start due to corrupted workspace cache, please try to clean the workspace.",
                     "Clean and Restart");
      if (ans === "Clean and Restart") {
         sendInfo("", {
            name: "clean-cache-action",
         });
         vscode.commands.executeCommand("java.clean.workspace", true);
      } else {
         sendInfo("", {
            name: "clean-cache-cancel-action",
         });
      }
   }
}

/**
 * To avoid the LSP request name get redacted.
 */
function escapeLspRequestName(name: string) {
   return name.replace(/\//g, "-")
}
