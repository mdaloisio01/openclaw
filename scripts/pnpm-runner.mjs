import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCmdExeCommandLine } from "./windows-cmd-helpers.mjs";

function getPortableBasename(value) {
  return value.split(/[/\\]/).at(-1) ?? value;
}

function getPortableExtension(value) {
  return path.posix.extname(getPortableBasename(value)).toLowerCase();
}

function isPnpmExecPath(value) {
  return /^pnpm(?:-cli)?(?:\.(?:[cm]?js|cmd|exe))?$/.test(getPortableBasename(value).toLowerCase());
}

function hasScriptShebang(value) {
  let fd;
  try {
    fd = openSync(value, "r");
    const header = Buffer.alloc(2);
    return (
      readSync(fd, header, 0, header.length, 0) === header.length &&
      header[0] === 0x23 &&
      header[1] === 0x21
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function isExecutableFile(value) {
  try {
    if (!statSync(value).isFile()) {
      return false;
    }
    accessSync(value, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isFile(value) {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}

function splitPathEntries(value) {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  return value.split(path.delimiter).filter((entry) => entry.length > 0);
}

function listPnpmFallbackDirs(params = {}) {
  const env = params.env ?? process.env;
  const home = params.home ?? env.HOME ?? os.homedir();
  const dirs = [...splitPathEntries(env.PATH)];
  if (typeof env.PNPM_HOME === "string" && env.PNPM_HOME.length > 0) {
    dirs.push(env.PNPM_HOME);
  }
  if (typeof home === "string" && home.length > 0) {
    dirs.push(path.join(home, ".npm-global", "bin"));
    dirs.push(path.join(home, ".local", "share", "pnpm"));
    dirs.push(path.join(home, ".local", "bin"));
    dirs.push(path.join(home, "bin"));
  }
  return [...new Set(dirs)];
}

function resolveExecutableFromDirs(command, dirs) {
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isNodeRunnablePnpmExecPath(value) {
  if (!isPnpmExecPath(value)) {
    return false;
  }
  const extension = getPortableExtension(value);
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
    return isFile(value);
  }
  if (extension.length > 0) {
    return false;
  }
  return hasScriptShebang(value);
}

export function resolvePnpmRunner(params = {}) {
  const pnpmArgs = params.pnpmArgs ?? [];
  const nodeArgs = params.nodeArgs ?? [];
  const npmExecPath = params.npmExecPath ?? process.env.npm_execpath;
  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const platform = params.platform ?? process.platform;
  const comSpec = params.comSpec ?? process.env.ComSpec ?? "cmd.exe";
  const env = params.env ?? process.env;
  const home = params.home ?? env.HOME;

  if (typeof npmExecPath === "string" && npmExecPath.length > 0 && isPnpmExecPath(npmExecPath)) {
    if (isNodeRunnablePnpmExecPath(npmExecPath)) {
      return {
        command: nodeExecPath,
        args: [...nodeArgs, npmExecPath, ...pnpmArgs],
        shell: false,
      };
    }

    const npmExecExtension = getPortableExtension(npmExecPath);
    if (platform !== "win32" && npmExecExtension.length === 0 && isExecutableFile(npmExecPath)) {
      return {
        command: npmExecPath,
        args: pnpmArgs,
        shell: false,
      };
    }
    if (platform === "win32" && npmExecExtension === ".exe") {
      return {
        command: npmExecPath,
        args: pnpmArgs,
        shell: false,
      };
    }
    if (platform === "win32" && npmExecExtension === ".cmd") {
      return {
        command: comSpec,
        args: ["/d", "/s", "/c", buildCmdExeCommandLine(npmExecPath, pnpmArgs)],
        shell: false,
        windowsVerbatimArguments: true,
      };
    }
  }

  if (platform === "win32") {
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", buildCmdExeCommandLine("pnpm.cmd", pnpmArgs)],
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  const resolvedPnpm = resolveExecutableFromDirs(
    "pnpm",
    listPnpmFallbackDirs({
      env,
      home,
    }),
  );
  if (resolvedPnpm) {
    return {
      command: resolvedPnpm,
      args: pnpmArgs,
      shell: false,
    };
  }

  return {
    command: "pnpm",
    args: pnpmArgs,
    shell: false,
  };
}

export function createPnpmRunnerSpawnSpec(params = {}) {
  const runner = resolvePnpmRunner(params);
  return {
    command: runner.command,
    args: runner.args,
    options: {
      cwd: params.cwd,
      detached: params.detached,
      stdio: params.stdio ?? "inherit",
      env: params.env ?? runner.env ?? process.env,
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
    },
  };
}

export function spawnPnpmRunner(params = {}) {
  const spawnSpec = createPnpmRunnerSpawnSpec(params);
  return spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
}
