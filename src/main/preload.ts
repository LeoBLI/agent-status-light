import { contextBridge, ipcRenderer } from "electron";
import { Diagnostics, OpenSessionResult, OverallStatus, StatusTree } from "../shared/types";

contextBridge.exposeInMainWorld("agentStatus", {
  getStatus: (): Promise<OverallStatus> => ipcRenderer.invoke("status:get"),
  getStatuses: (): Promise<StatusTree> => ipcRenderer.invoke("statuses:get"),
  getDiagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke("diagnostics:get"),
  dismissSession: (id: string): Promise<StatusTree> => ipcRenderer.invoke("session:dismiss", id),
  openSession: (id: string): Promise<OpenSessionResult> => ipcRenderer.invoke("session:open", id),
  hideWindow: (): void => {
    ipcRenderer.send("window:hide");
  },
  setExpanded: (expanded: boolean): void => {
    ipcRenderer.send("window:set-expanded", expanded);
  },
  onStatus: (callback: (status: OverallStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: OverallStatus) => callback(status);
    ipcRenderer.on("status:update", listener);
    return () => ipcRenderer.removeListener("status:update", listener);
  },
  onStatuses: (callback: (tree: StatusTree) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tree: StatusTree) => callback(tree);
    ipcRenderer.on("statuses:update", listener);
    return () => ipcRenderer.removeListener("statuses:update", listener);
  }
});
