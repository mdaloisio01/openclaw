const activeOwnerRunCounts = new Map<string, number>();

export function beginOwnerRunForGovernedMissionAdmission(ownerKey: string): () => void {
  const normalizedOwnerKey = ownerKey.trim();
  if (!normalizedOwnerKey) {
    return () => {};
  }
  activeOwnerRunCounts.set(
    normalizedOwnerKey,
    (activeOwnerRunCounts.get(normalizedOwnerKey) ?? 0) + 1,
  );
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const remaining = (activeOwnerRunCounts.get(normalizedOwnerKey) ?? 1) - 1;
    if (remaining > 0) {
      activeOwnerRunCounts.set(normalizedOwnerKey, remaining);
    } else {
      activeOwnerRunCounts.delete(normalizedOwnerKey);
    }
  };
}

export function hasOwnerRunForGovernedMissionAdmission(ownerKey: string): boolean {
  const normalizedOwnerKey = ownerKey.trim();
  return normalizedOwnerKey ? (activeOwnerRunCounts.get(normalizedOwnerKey) ?? 0) > 0 : false;
}
