import type { SessionEntry } from "./session-manager.js";

export function filterVisibleSessionEntries(entries: SessionEntry[]): SessionEntry[] {
  const hiddenIds = new Set<string>();
  let hiddenContentSeen = false;
  for (const entry of entries) {
    if (
      (entry.type === "message" && "display" in entry.message && !entry.message.display) ||
      (entry.type === "custom_message" && !entry.display)
    ) {
      hiddenIds.add(entry.id);
      hiddenContentSeen = true;
    } else if (
      hiddenContentSeen &&
      (entry.type === "compaction" || entry.type === "branch_summary")
    ) {
      // Summaries can restate earlier hidden model or tool content.
      hiddenIds.add(entry.id);
    }
  }
  for (const entry of entries) {
    if (entry.type === "label" && hiddenIds.has(entry.targetId)) {
      hiddenIds.add(entry.id);
    }
  }

  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  return entries.flatMap((entry) => {
    if (hiddenIds.has(entry.id)) {
      return [];
    }
    let parentId = entry.parentId;
    const visited = new Set<string>();
    while (parentId && hiddenIds.has(parentId)) {
      if (visited.has(parentId)) {
        parentId = null;
        break;
      }
      visited.add(parentId);
      parentId = entryById.get(parentId)?.parentId ?? null;
    }
    return [parentId === entry.parentId ? entry : { ...entry, parentId }];
  });
}
