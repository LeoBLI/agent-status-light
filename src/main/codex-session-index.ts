import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStatus } from "../shared/types";

interface CodexSessionIndexEntry {
  id: string;
  threadName?: string;
  updatedAt?: number;
}

export interface CodexSessionIndexDiagnostics {
  found: boolean;
  path: string;
}

export function getCodexSessionIndexDiagnostics(): CodexSessionIndexDiagnostics {
  const indexPath = codexSessionIndexPath();
  return {
    found: existsSync(indexPath),
    path: indexPath
  };
}

export function enrichFromCodexSessionIndex(session: SessionStatus): Partial<SessionStatus> {
  const entries = readSessionIndex();
  if (entries.length === 0) {
    return {};
  }

  const exactId =
    findById(entries, session.codexThreadId) ||
    findById(entries, session.codexSessionId) ||
    findById(entries, session.sessionId);

  if (exactId) {
    return toSessionOpenFields(exactId);
  }

  const title = session.displayTitle || session.title || session.sessionName;
  const titleMatch = findByTitle(entries, title, session.updatedAt);
  return titleMatch ? toSessionOpenFields(titleMatch) : {};
}

export function isCodexThreadId(value: string | undefined): boolean {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function codexThreadDeepLink(threadId: string | undefined): string | undefined {
  return isCodexThreadId(threadId) ? `codex://threads/${threadId}` : undefined;
}

function toSessionOpenFields(entry: CodexSessionIndexEntry): Partial<SessionStatus> {
  return {
    codexThreadId: entry.id,
    codexDeepLink: codexThreadDeepLink(entry.id),
    codexSessionPath: findSessionFile(entry.id)
  };
}

function findById(
  entries: CodexSessionIndexEntry[],
  value: string | undefined
): CodexSessionIndexEntry | undefined {
  if (!isCodexThreadId(value)) {
    return undefined;
  }

  return entries.find((entry) => entry.id === value);
}

function findByTitle(
  entries: CodexSessionIndexEntry[],
  title: string | undefined,
  updatedAt: number
): CodexSessionIndexEntry | undefined {
  const candidate = title?.trim();
  if (!candidate) {
    return undefined;
  }

  const matches = entries.filter((entry) => entry.threadName === candidate);
  if (matches.length === 1) {
    return isCloseInTime(matches[0], updatedAt) ? matches[0] : undefined;
  }

  return undefined;
}

function isCloseInTime(entry: CodexSessionIndexEntry, updatedAt: number): boolean {
  if (!entry.updatedAt) {
    return false;
  }

  return Math.abs(entry.updatedAt - updatedAt) <= 30 * 60 * 1000;
}

function readSessionIndex(): CodexSessionIndexEntry[] {
  const indexPath = codexSessionIndexPath();
  if (!existsSync(indexPath)) {
    return [];
  }

  try {
    return readFileSync(indexPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseIndexLine)
      .filter((entry): entry is CodexSessionIndexEntry => Boolean(entry));
  } catch {
    return [];
  }
}

function parseIndexLine(line: string): CodexSessionIndexEntry | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const id = text(parsed.id);
    if (!id || !isCodexThreadId(id)) {
      return undefined;
    }

    const updatedAtRaw = text(parsed.updated_at) || text(parsed.updatedAt);
    const updatedAt = updatedAtRaw ? Date.parse(updatedAtRaw) : undefined;
    return {
      id,
      threadName: text(parsed.thread_name) || text(parsed.threadName),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined
    };
  } catch {
    return undefined;
  }
}

function findSessionFile(threadId: string): string | undefined {
  const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  if (!existsSync(sessionsRoot)) {
    return undefined;
  }

  try {
    return findFileByName(sessionsRoot, threadId);
  } catch {
    return undefined;
  }
}

function findFileByName(root: string, needle: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.includes(needle)) {
      return fullPath;
    }

    if (entry.isDirectory()) {
      const found = findFileByName(fullPath, needle);
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

function codexSessionIndexPath(): string {
  return path.join(os.homedir(), ".codex", "session_index.jsonl");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
