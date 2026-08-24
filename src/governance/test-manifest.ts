import type { RawTestResult, TestManifest } from "./mission-manifest.types.js";

export type TestManifestReconciliation = {
  passed: boolean;
  requestedFileCount: number;
  executedFileCount: number;
  expectedTotal: number;
  actualTotal: number;
  missingFiles: string[];
  unexpectedFiles: string[];
};

export function reconcileTestManifest(
  manifest: TestManifest | undefined,
  results: readonly RawTestResult[] | undefined,
): TestManifestReconciliation {
  const requested = new Set(manifest?.requestedFiles ?? []);
  const executed = new Set((results ?? []).map((result) => result.file));
  const missingFiles = [...requested].filter((file) => !executed.has(file)).sort();
  const unexpectedFiles = [...executed].filter((file) => !requested.has(file)).sort();
  const actualTotal = (results ?? []).reduce(
    (sum, result) => sum + result.passed + result.failed + (result.skipped ?? 0),
    0,
  );
  const expectedTotal = manifest?.expectedTotal ?? 0;
  return {
    passed:
      Boolean(manifest) &&
      missingFiles.length === 0 &&
      unexpectedFiles.length === 0 &&
      actualTotal === expectedTotal &&
      (results ?? []).every((result) => result.failed === 0),
    requestedFileCount: requested.size,
    executedFileCount: executed.size,
    expectedTotal,
    actualTotal,
    missingFiles,
    unexpectedFiles,
  };
}
