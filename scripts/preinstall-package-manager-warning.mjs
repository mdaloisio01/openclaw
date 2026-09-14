import { pathToFileURL } from "node:url";
import {
  createNonPnpmInstallErrorMessage,
  detectLifecyclePackageManager as detectPackageManagerForInstallGuard,
  enforcePnpmInstallLifecycle,
} from "./install-integrity-guard.mjs";

export function detectLifecyclePackageManager(env = process.env) {
  return detectPackageManagerForInstallGuard(env);
}

export function createPackageManagerWarningMessage(packageManager) {
  return createNonPnpmInstallErrorMessage(packageManager);
}

export function warnIfNonPnpmLifecycle(env = process.env, warn = console.warn) {
  const message = createPackageManagerWarningMessage(detectLifecyclePackageManager(env));
  if (!message) {
    return false;
  }
  warn(message);
  return true;
}

export function enforcePnpmLifecycle(env = process.env, hooks = {}) {
  return enforcePnpmInstallLifecycle({
    env,
    cwd: hooks.cwd ?? process.cwd(),
    error: hooks.error ?? console.error,
    warn: hooks.warn ?? console.warn,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  enforcePnpmLifecycle();
}
