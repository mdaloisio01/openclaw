import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  invokeNativeHookRelay,
  type NativeHookRelayProcessResponse,
} from "../../agents/harness/native-hook-relay.js";
import {
  createGatewayPerfStageTimer,
  formatGatewayPerfCpuUsage,
  logGatewayPerfSummary,
} from "./perf-logging.js";
import type { GatewayRequestHandlers } from "./types.js";

export const nativeHookRelayHandlers: GatewayRequestHandlers = {
  "nativeHook.invoke": async ({ params, respond, context }) => {
    const perf = createGatewayPerfStageTimer();
    const cpuStarted = process.cpuUsage();
    try {
      // Relay invocations are one-shot bridges into a live native harness.
      // Require the current generation so stale clients cannot post into a
      // newly registered relay with the same id.
      const result: NativeHookRelayProcessResponse = await invokeNativeHookRelay({
        provider: params.provider,
        relayId: params.relayId,
        generation: params.generation,
        event: params.event,
        rawPayload: params.rawPayload,
        requireGeneration: true,
      });
      perf.mark("relay_invoke");
      logGatewayPerfSummary({
        logger: context.logGateway,
        surface: "nativeHook.invoke",
        durationMs: perf.totalMs(),
        message:
          `provider=${typeof params.provider === "string" ? params.provider : "unknown"} ` +
          `relayId=${typeof params.relayId === "string" ? params.relayId : "unknown"} ` +
          `generation=${typeof params.generation === "number" ? params.generation : "unknown"} ` +
          `${formatGatewayPerfCpuUsage(cpuStarted)} stages="${perf.summary()}"`,
      });
      respond(true, result);
    } catch (error) {
      perf.mark("relay_error");
      logGatewayPerfSummary({
        logger: context.logGateway,
        surface: "nativeHook.invoke",
        durationMs: perf.totalMs(),
        message:
          `provider=${typeof params.provider === "string" ? params.provider : "unknown"} ` +
          `relayId=${typeof params.relayId === "string" ? params.relayId : "unknown"} ` +
          `generation=${typeof params.generation === "number" ? params.generation : "unknown"} ` +
          `error=true ${formatGatewayPerfCpuUsage(cpuStarted)} stages="${perf.summary()}"`,
      });
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "native hook relay failed",
        ),
      );
    }
  },
};
