import {
  Uri,
} from "vscode";
import * as vscode from "vscode";

interface IMctlConfig {
  access_token: string;
}

export function getProgramPath(name: string): string {
	const workspaceFolder = vscode.workspace.workspaceFolders?.find((folder) => {
		return folder.name === name;
	}
	);
	if (!workspaceFolder) {
		throw new Error("Not a valid Membrane workspace folder");
	}
	return workspaceFolder.uri.fsPath;
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