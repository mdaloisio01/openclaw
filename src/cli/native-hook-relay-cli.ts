import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  invokeNativeHookRelayBridge,
  isNativeHookRelayBridgeStaleRegistrationError,
  renderNativeHookRelayUnavailableResponse,
  type NativeHookRelayProcessResponse,
} from "../agents/harness/native-hook-relay.js";
import { callGateway } from "../gateway/call.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";

const MAX_NATIVE_HOOK_STDIN_BYTES = 1024 * 1024;
const DEFAULT_NATIVE_HOOK_RELAY_MAX_ACTIVE = 2;
const NATIVE_HOOK_RELAY_SLOT_WAIT_MS = 25;
const NATIVE_HOOK_RELAY_SLOT_STALE_MS = 30_000;

export type NativeHookRelayCliOptions = {
  provider?: string;
  relayId?: string;
  generation?: string;
  event?: string;
  preToolUseUnavailable?: string;
  timeout?: string;
};

type NativeHookRelayCliDeps = {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  invokeBridge?: typeof invokeNativeHookRelayBridge;
  callGateway?: typeof callGateway;
  acquireSlot?: typeof acquireNativeHookRelaySlot;
};

export async function runNativeHookRelayCli(
  opts: NativeHookRelayCliOptions,
  deps: NativeHookRelayCliDeps = {},
): Promise<number> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const invokeBridge = deps.invokeBridge ?? invokeNativeHookRelayBridge;
  const callGatewayFn = deps.callGateway ?? callGateway;
  const acquireSlot = deps.acquireSlot ?? acquireNativeHookRelaySlot;
  const provider = readRequiredOption(opts.provider, "provider");
  const relayId = readRequiredOption(opts.relayId, "relay-id");
  const generation = opts.generation?.trim() || undefined;
  const event = readRequiredOption(opts.event, "event");
  let timeoutMs: number;
  try {
    timeoutMs = parseTimeoutMsWithFallback(opts.timeout, 5_000);
  } catch (error) {
    writeText(stderr, formatRelayCliError("invalid native hook timeout", error));
    return 1;
  }

  let rawPayload: unknown;
  try {
    const rawInput = await readStreamText(stdin, MAX_NATIVE_HOOK_STDIN_BYTES);
    rawPayload = rawInput.trim() ? JSON.parse(rawInput) : null;
  } catch (error) {
    writeText(stderr, formatRelayCliError("failed to read native hook input", error));
    return 1;
  }

  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await acquireSlot(timeoutMs);
  } catch (error) {
    writeText(stderr, formatRelayCliError("native hook relay overloaded", error));
    const response = renderNativeHookRelayUnavailableResponse({
      provider,
      event,
      preToolUseUnavailable: opts.preToolUseUnavailable,
      message: "Native hook relay overloaded",
    });
    writeText(stdout, response.stdout);
    writeText(stderr, response.stderr);
    return response.exitCode;
  }

  try {
    try {
      const response = await invokeBridge({
        provider,
        relayId,
        generation,
        event,
        rawPayload,
        registrationTimeoutMs: 100,
        timeoutMs,
      });
      writeText(stdout, response.stdout);
      writeText(stderr, response.stderr);
      return response.exitCode;
    } catch (error) {
      if (isNativeHookRelayBridgeStaleRegistrationError(error)) {
        writeText(stderr, formatRelayCliError("native hook relay unavailable", error));
        const response = renderNativeHookRelayUnavailableResponse({
          provider,
          event,
          preToolUseUnavailable: opts.preToolUseUnavailable,
          message: "Native hook relay unavailable",
        });
        writeText(stdout, response.stdout);
        writeText(stderr, response.stderr);
        return response.exitCode;
      }
      // Fall through to the gateway path for embedded/local gateway cases and
      // older registrations that predate the direct relay bridge.
    }

    try {
      const response = await callGatewayFn<NativeHookRelayProcessResponse>({
        method: "nativeHook.invoke",
        params: { provider, relayId, generation, event, rawPayload },
        timeoutMs,
        scopes: [ADMIN_SCOPE],
      });
      writeText(stdout, response.stdout);
      writeText(stderr, response.stderr);
      return response.exitCode;
    } catch (error) {
      writeText(stderr, formatRelayCliError("native hook relay unavailable", error));
      const response = renderNativeHookRelayUnavailableResponse({
        provider,
        event,
        preToolUseUnavailable: opts.preToolUseUnavailable,
        message: "Native hook relay unavailable",
      });
      writeText(stdout, response.stdout);
      writeText(stderr, response.stderr);
      return response.exitCode;
    }
  } finally {
    releaseSlot?.();
  }
}

function readRequiredOption(value: string | undefined, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Missing required option --${name}`);
}

async function readStreamText(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new Error(`native hook input exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function writeText(stream: NodeJS.WritableStream, value: string | undefined): void {
  if (value) {
    stream.write(value);
  }
}

function formatRelayCliError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}\n`;
}

async function acquireNativeHookRelaySlot(timeoutMs: number): Promise<() => void> {
  const maxActive = readNativeHookRelayMaxActive();
  if (maxActive <= 0) {
    return () => {};
  }
  const startedAt = Date.now();
  const root = nativeHookRelaySlotRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  while (Date.now() - startedAt < timeoutMs) {
    for (let index = 0; index < maxActive; index += 1) {
      const slotPath = path.join(root, `slot-${index}`);
      if (removeStaleNativeHookRelaySlot(slotPath)) {
        // Try to claim the slot immediately after removing stale state.
      }
      try {
        mkdirSync(slotPath, { mode: 0o700 });
        return () => {
          rmSync(slotPath, { recursive: true, force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    }
    await delay(Math.min(NATIVE_HOOK_RELAY_SLOT_WAIT_MS, timeoutMs - (Date.now() - startedAt)));
  }
  throw new Error(`native hook relay concurrency limit reached (${maxActive})`);
}

function readNativeHookRelayMaxActive(): number {
  const raw = process.env.OPENCLAW_NATIVE_HOOK_RELAY_MAX_ACTIVE;
  if (!raw) {
    return DEFAULT_NATIVE_HOOK_RELAY_MAX_ACTIVE;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_NATIVE_HOOK_RELAY_MAX_ACTIVE;
  }
  return Math.floor(parsed);
}

function nativeHookRelaySlotRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
  return path.join(tmpdir(), `openclaw-native-hook-relay-slots-${uid}`);
}

function removeStaleNativeHookRelaySlot(slotPath: string): boolean {
  try {
    const stats = statSync(slotPath);
    if (Date.now() - stats.mtimeMs < NATIVE_HOOK_RELAY_SLOT_STALE_MS) {
      return false;
    }
    rmSync(slotPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function createReadableTextStream(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

export function createWritableTextBuffer(): NodeJS.WritableStream & { text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  return Object.assign(stream, {
    text: () => Buffer.concat(chunks).toString("utf8"),
  });
}
