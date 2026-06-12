import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext) {
    console.log('IDE Branding extension activated');

    // Close welcome/getting-started tabs
    setTimeout(async () => {
        try {
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        } catch (e) { /* ignore */ }
    }, 2000);

    // Open a file in editor so center column isn't empty
    setTimeout(async () => {
        try {
            const readmes = await vscode.workspace.findFiles('README.md', null, 1);
            if (readmes.length > 0) {
                await vscode.commands.executeCommand('vscode.open', readmes[0]);
            } else {
                const anyFile = await vscode.workspace.findFiles('*', '**/node_modules/**', 1);
                if (anyFile.length > 0) {
                    await vscode.commands.executeCommand('vscode.open', anyFile[0]);
                }
            }
        } catch (e) { /* ignore */ }
    }, 2500);

    // Focus file explorer
    setTimeout(async () => {
        try {
            await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
        } catch (e) { /* ignore */ }
    }, 3000);

    // Open Claude Code in secondary sidebar (right panel)
    setTimeout(async () => {
        try {
            await vscode.commands.executeCommand('claudeVSCodeSidebarSecondary.focus');
        } catch (e) {
            try {
                await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
                await vscode.commands.executeCommand('claudeVSCodeSidebar.focus');
            } catch (e2) { /* ignore */ }
        }
    }, 4000);

    // Re-focus file explorer so left sidebar stays active
    setTimeout(async () => {
        try {
            await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
        } catch (e) { /* ignore */ }
    }, 5000);
}

export function deactivate() { }
