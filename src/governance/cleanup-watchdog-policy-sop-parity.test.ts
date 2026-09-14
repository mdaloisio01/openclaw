import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLEANUP_WATCHDOG_ACCEPTED_READ_VERSIONS,
  CLEANUP_WATCHDOG_ACTIVATION_GATES,
  CLEANUP_WATCHDOG_CLEAN_DIMENSIONS,
  CLEANUP_WATCHDOG_COVERAGE_KINDS,
  CLEANUP_WATCHDOG_POLICY_VERSION,
  CLEANUP_WATCHDOG_PRIORITY_ORDER,
  GOVERNANCE_ACTION_STATES,
  GOVERNANCE_CONTINUATION_STATES,
  GOVERNANCE_DECISION_STATES,
  GOVERNANCE_DELIVERY_STATES,
  GOVERNANCE_MISSION_STATES,
  GOVERNANCE_PHASE_STATES,
  GOVERNANCE_WATCHDOG_FINDING_STATES,
  GOVERNANCE_WORKER_STATES,
} from "./cleanup-watchdog-policy.js";

function readGovernanceFile(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

describe("cleanup-watchdog policy generated SOP parity", () => {
  it("keeps the JSON schema aligned with the canonical TypeScript policy", () => {
    const schema = JSON.parse(readGovernanceFile("cleanup-watchdog-policy.schema.json")) as {
      properties: {
        policyVersion: { const: string };
        acceptedReadVersions: { contains: { const: string } };
        missionStates: { items: { enum: string[] } };
        phaseStates: { items: { enum: string[] } };
        actionStates: { items: { enum: string[] } };
        workerStates: { items: { enum: string[] } };
        continuationStates: { items: { enum: string[] } };
        watchdogFindingStates: { items: { enum: string[] } };
        deliveryStates: { items: { enum: string[] } };
        decisionStates: { items: { enum: string[] } };
        priorityOrder: { items: { enum: string[] } };
        cleanDimensions: { items: { enum: string[] } };
        coverageKinds: { items: { enum: string[] } };
        activationGates: { items: { enum: string[] } };
      };
    };

    expect(schema.properties.policyVersion.const).toBe(CLEANUP_WATCHDOG_POLICY_VERSION);
    expect(schema.properties.acceptedReadVersions.contains.const).toBe(
      CLEANUP_WATCHDOG_POLICY_VERSION,
    );
    expect(schema.properties.missionStates.items.enum).toEqual(GOVERNANCE_MISSION_STATES);
    expect(schema.properties.phaseStates.items.enum).toEqual(GOVERNANCE_PHASE_STATES);
    expect(schema.properties.actionStates.items.enum).toEqual(GOVERNANCE_ACTION_STATES);
    expect(schema.properties.workerStates.items.enum).toEqual(GOVERNANCE_WORKER_STATES);
    expect(schema.properties.continuationStates.items.enum).toEqual(GOVERNANCE_CONTINUATION_STATES);
    expect(schema.properties.watchdogFindingStates.items.enum).toEqual(
      GOVERNANCE_WATCHDOG_FINDING_STATES,
    );
    expect(schema.properties.deliveryStates.items.enum).toEqual(GOVERNANCE_DELIVERY_STATES);
    expect(schema.properties.decisionStates.items.enum).toEqual(GOVERNANCE_DECISION_STATES);
    expect(schema.properties.priorityOrder.items.enum).toEqual(CLEANUP_WATCHDOG_PRIORITY_ORDER);
    expect(schema.properties.cleanDimensions.items.enum).toEqual(CLEANUP_WATCHDOG_CLEAN_DIMENSIONS);
    expect(schema.properties.coverageKinds.items.enum).toEqual(CLEANUP_WATCHDOG_COVERAGE_KINDS);
    expect(schema.properties.activationGates.items.enum).toEqual(CLEANUP_WATCHDOG_ACTIVATION_GATES);
  });

  it("keeps the prompt/SOP digest as a consumer of the canonical policy", () => {
    const digest = readGovernanceFile("cleanup-watchdog-policy.prompt.md");

    expect(digest).toContain("not an independent authority");
    expect(digest).toContain(CLEANUP_WATCHDOG_POLICY_VERSION);
    for (const version of CLEANUP_WATCHDOG_ACCEPTED_READ_VERSIONS) {
      expect(digest).toContain(version);
    }
    for (const priority of CLEANUP_WATCHDOG_PRIORITY_ORDER) {
      expect(digest).toContain(priority);
    }
    for (const dimension of CLEANUP_WATCHDOG_CLEAN_DIMENSIONS) {
      expect(digest).toContain(dimension);
    }
    for (const gate of CLEANUP_WATCHDOG_ACTIVATION_GATES) {
      expect(digest).toContain(gate);
    }
    expect(digest).toContain(
      "Changing a mission to a blocked-looking status never makes watchdog clean",
    );
    expect(digest).toContain("Duplicate suppression affects chat delivery only");
    expect(digest).toContain("Gateway/runtime readiness without mission resumption is not clean");
    expect(digest).toContain(
      "Controller enforcement is not allowed until every activation gate passes",
    );
    expect(digest).toContain("effective mode remains `shadow_observe`");
  });
});
