import { Uri } from "vscode";
import * as vscode from "vscode";
const path = require("path");

interface IMctlConfig {
  access_token: string;
}

export function getProgramPath(name: string): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.find((folder) => {
    return folder.name === name;
  });
  if (!workspaceFolder) {
    throw new Error("Not a valid Membrane workspace folder");
  }
  return workspaceFolder.uri.fsPath;
}

export async function getCurrentProgramMemconfigUri(): Promise<
  Uri | undefined
> {
  const fs = vscode.workspace.fs;
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor || activeEditor.document.uri.scheme !== "file") {
    console.log(
      "No Membrane file is open: " + activeEditor?.document.uri.toString()
    );
    return;
  }

  let baseUri = Uri.joinPath(activeEditor.document.uri, "..");
  let stat;
  do {
    try {
      stat = await fs.stat(Uri.joinPath(baseUri, "memconfig.json"));
      if (stat) {
        break;
      }
    } catch (e: any) {
      if (e.code !== "FileNotFound") {
        throw e;
      }
    }
    if (/^\/?$/.test(baseUri.path)) {
      return;
    }
    baseUri = Uri.joinPath(baseUri, "..");
  } while (!stat);

  return Uri.joinPath(baseUri, "memconfig.json");
}

export async function getCurrentProgramUri(): Promise<Uri | undefined> {
  const memconfigUri = await getCurrentProgramMemconfigUri();
  if (memconfigUri) {
    return Uri.joinPath(memconfigUri, "..");
  }
}

export async function getCurrentProgramMemconfigPath(): Promise<
  string | undefined
> {
  const memconfigUri = await getCurrentProgramMemconfigUri();
  if (memconfigUri) {
    return memconfigUri.path;
  }
}

export async function getCurrentProgramName(): Promise<string | undefined> {
  const memconfigPath = await getCurrentProgramMemconfigPath();
  if (memconfigPath) {
    return path.basename(path.dirname(memconfigPath));
  }
}

// TODO: instead of guessing where the Membrane workspace is, use mctl to find out
export async function configFile(): Promise<IMctlConfig> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0].uri;
  if (!workspaceUri) {
    throw new Error("Not a valid Membrane workspace folder");
  }
  const data = await vscode.workspace.fs.readFile(
    Uri.joinPath(workspaceUri, "..", ".config")
  );
  return JSON.parse(data.toString());
}

export const getApiBaseUrl = (): string => {
  return (
    (vscode.workspace
      .getConfiguration("membrane")
      .get("apiBaseUrl") as string) ?? "https://api.membrane.io"
  );
};
