import { contextBridge, ipcRenderer } from "electron";
import { Diagnostics, OpenSessionResult, OverallStatus, StatusTree } from "../shared/types";

type PanelMode = "collapsed" | "expanded";

contextBridge.exposeInMainWorld("agentStatus", {
  getStatus: (): Promise<OverallStatus> => ipcRenderer.invoke("status:get"),
  getStatuses: (): Promise<StatusTree> => ipcRenderer.invoke("statuses:get"),
  getDiagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke("diagnostics:get"),
  dismissSession: (id: string): Promise<StatusTree> => ipcRenderer.invoke("session:dismiss", id),
  markSessionDone: (id: string): Promise<{ ok: boolean; tree: StatusTree }> =>
    ipcRenderer.invoke("session:mark-done", id),
  dismissAllDone: (): Promise<StatusTree> => ipcRenderer.invoke("done:dismiss-all"),
  approveAllApproval: (): Promise<unknown> => ipcRenderer.invoke("approval:approve-all"),
  openSession: (id: string): Promise<OpenSessionResult> => ipcRenderer.invoke("session:open", id),
  hideWindow: (): void => {
    ipcRenderer.send("window:hide");
  },
  setPanelMode: (mode: PanelMode): Promise<PanelMode> =>
    ipcRenderer.invoke("panel:set-mode", mode),
  getPanelMode: (): Promise<PanelMode> => ipcRenderer.invoke("panel:get-mode"),
  enlargeExpandedPanel: (): Promise<PanelMode> =>
    ipcRenderer.invoke("panel:enlarge-expanded"),
  setExpanded: (expanded: boolean): Promise<PanelMode> =>
    ipcRenderer.invoke("panel:set-mode", expanded ? "expanded" : "collapsed"),
  onStatus: (callback: (status: OverallStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: OverallStatus) => callback(status);
    ipcRenderer.on("status:update", listener);
    return () => ipcRenderer.removeListener("status:update", listener);
  },
  onStatuses: (callback: (tree: StatusTree) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tree: StatusTree) => callback(tree);
    ipcRenderer.on("statuses:update", listener);
    return () => ipcRenderer.removeListener("statuses:update", listener);
  },
  onPanelMode: (callback: (mode: PanelMode) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, mode: PanelMode) => callback(mode);
    ipcRenderer.on("panel:mode", listener);
    return () => ipcRenderer.removeListener("panel:mode", listener);
  }
});
