import fs from "node:fs/promises";
import path from "node:path";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { mimeFromExtension } from "../shared/mime.js";
import {
  classifyFsSafeReadError,
  readAbsolutePath,
  resolveCanonicalReadPath,
  statRequiredDirectory,
} from "./path-errors.js";

export const DIR_LIST_DEFAULT_MAX_ENTRIES = 200;
export const DIR_LIST_HARD_MAX_ENTRIES = 5000;

type DirListParams = {
  path?: unknown;
  pageToken?: unknown;
  maxEntries?: unknown;
  query?: unknown;
  followSymlinks?: unknown;
};

type DirListEntry = {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  isDir: boolean;
  mtime: number;
};

type DirListOk = {
  ok: true;
  path: string;
  entries: DirListEntry[];
  nextPageToken?: string;
  truncated: boolean;
  query?: string;
};

type DirListErrCode =
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "IS_FILE"
  | "SYMLINK_REDIRECT"
  | "READ_ERROR";

type DirListErr = {
  ok: false;
  code: DirListErrCode;
  message: string;
  canonicalPath?: string;
};

type DirListResult = DirListOk | DirListErr;

function clampMaxEntries(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return DIR_LIST_DEFAULT_MAX_ENTRIES;
  }
  return Math.min(Math.floor(input), DIR_LIST_HARD_MAX_ENTRIES);
}

function parsePageOffset(input: unknown): number {
  if (typeof input !== "string") {
    return 0;
  }
  return Math.min(parseStrictNonNegativeInteger(input) ?? 0, DIR_LIST_HARD_MAX_ENTRIES);
}

function readQuery(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function encodeNamePageToken(name: string): string {
  return `after:${Buffer.from(name, "utf8").toString("base64url")}`;
}

function decodeNamePageToken(input: unknown): string | undefined {
  if (typeof input !== "string" || !input.startsWith("after:")) {
    return undefined;
  }
  const encodedName = input.slice("after:".length);
  if (!encodedName) {
    return undefined;
  }
  try {
    return Buffer.from(encodedName, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function classifyFsError(err: unknown): DirListErrCode {
  const safeCode = classifyFsSafeReadError(err);
  if (safeCode) {
    return safeCode;
  }
  const code = (err as { code?: string } | null)?.code;
  if (code === "ENOENT") {
    return "NOT_FOUND";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "PERMISSION_DENIED";
  }
  return "READ_ERROR";
}

async function collectDirectoryPage(input: {
  canonical: string;
  maxEntries: number;
  pageToken: unknown;
  query: string | undefined;
}): Promise<{ names: string[]; truncated: boolean }> {
  const afterName = decodeNamePageToken(input.pageToken);
  const legacyOffset = afterName === undefined ? parsePageOffset(input.pageToken) : 0;
  const query = input.query?.toLocaleLowerCase();
  const selectionLimit = input.maxEntries + 1;
  const selectedNames: string[] = [];

  const dir = await fs.opendir(input.canonical);
  try {
    for await (const dirent of dir) {
      const name = dirent.name;
      if (afterName !== undefined && name.localeCompare(afterName) <= 0) {
        continue;
      }
      if (query && !name.toLocaleLowerCase().includes(query)) {
        continue;
      }

      selectedNames.push(name);
      selectedNames.sort((left, right) => left.localeCompare(right));
      if (selectedNames.length > legacyOffset + selectionLimit) {
        selectedNames.pop();
      }
    }
  } finally {
    await dir.close().catch(() => {});
  }

  const pageNames =
    afterName === undefined && legacyOffset > 0
      ? selectedNames.slice(legacyOffset, legacyOffset + selectionLimit)
      : selectedNames.slice(0, selectionLimit);

  return {
    names: pageNames.slice(0, input.maxEntries),
    truncated: pageNames.length > input.maxEntries,
  };
}

export async function handleDirList(params: DirListParams): Promise<DirListResult> {
  const requestedPath = readAbsolutePath(params.path);
  if (typeof requestedPath !== "string") {
    return requestedPath;
  }

  const maxEntries = clampMaxEntries(params.maxEntries);
  const query = readQuery(params.query);

  const followSymlinks = params.followSymlinks === true;

  const canonical = await resolveCanonicalReadPath({
    requestedPath,
    followSymlinks,
    classifyError: classifyFsError,
    notFoundMessage: "path not found",
  });
  if (typeof canonical !== "string") {
    return canonical;
  }

  const directory = await statRequiredDirectory(canonical, classifyFsError);
  if (!directory.ok) {
    return directory;
  }

  let page: { names: string[]; truncated: boolean };
  try {
    page = await collectDirectoryPage({
      canonical,
      maxEntries,
      pageToken: params.pageToken,
      query,
    });
  } catch (err) {
    const code = classifyFsError(err);
    return {
      ok: false,
      code,
      message: `list failed: ${String(err)}`,
      canonicalPath: canonical,
    };
  }

  const nextPageToken =
    page.truncated && page.names.length > 0
      ? encodeNamePageToken(page.names[page.names.length - 1] ?? "")
      : undefined;

  const entries: DirListEntry[] = [];
  for (const name of page.names) {
    const entryPath = path.join(canonical, name);
    const stats = await fs.lstat(entryPath);
    const isDir = stats.isDirectory();

    entries.push({
      name,
      path: entryPath,
      size: isDir ? 0 : stats.size,
      mimeType: isDir ? "inode/directory" : mimeFromExtension(name),
      isDir,
      mtime: stats.mtimeMs,
    });
  }

  return {
    ok: true,
    path: canonical,
    entries,
    nextPageToken,
    truncated: page.truncated,
    ...(query ? { query } : {}),
  };
}
