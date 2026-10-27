import electron = require("electron");

/**
 * The one narrow bridge between the page and the main process: pick a folder with the system's own dialog, and hear that a system
 * notification was clicked. Nothing else crosses: no file access, no shell, no generic send. What the dialog returns is a path the host
 * judges again before using it.
 */

interface OpenWork {
	readonly key: string;
	readonly sessionId: string;
	readonly decisionId: string;
}

electron.contextBridge.exposeInMainWorld("kisoDesktop", {
	pickFolder: (): Promise<string | null> => electron.ipcRenderer.invoke("kiso:pick-folder") as Promise<string | null>,
	onOpenWork: (handler: (target: OpenWork) => void): void => {
		electron.ipcRenderer.on("kiso:open-work", (_event, target: OpenWork) => handler(target));
	},
});
