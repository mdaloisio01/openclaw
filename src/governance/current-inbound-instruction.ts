export type CurrentInboundInstruction =
  | "unrestricted"
  | "planning_only"
  | "report_only"
  | "no_work";

const ARTIFACT_REQUEST =
  /^(?:only\s+)?(?:write|draft|generate|prepare|create|give me|make up|put together)\s+(?:(?!\b(?:for|to|that|which|with|about)\b).){0,80}\b(?:prompt|plan|build packet)\b(?=\s*(?:$|:|,|\b(?:for|to|that|which|with|about|and|then)\b))/;
const ARTIFACT_CONTENT_CONTINUATION =
  /^(?:include|contain|mention|quote|say|use)\b|^(?:have|make)\s+(?:it|the\s+(?:prompt|plan|build packet))\b/u;
const ARTIFACT_CONTENT_SUFFIX =
  /^\s*(?::|\b(?:to|that|which|with|about)\b|for\b[\s\S]*\b(?:to|that|which|with|about)\b)/u;
const EXECUTION_INSTRUCTION =
  /^(?:only\s+)?(?:execute|implement|apply|run|build|repair|fix|test|verify|deploy|restart|reload|restore|rollback|resume|continue|write|create|change|update)\b/;
const PLANNING_ONLY_INSTRUCTION = /^(?:planning|prompt)[ -]only(?:\s*:|\s*$)/u;
// Explanations remain part of the restriction. Later executable clauses are
// split before classification and can still supersede it explicitly.
const REPORT_ONLY_TAIL = String.raw`(?:\s*(?:$|:|,)|\s+(?:for|on|about|of|please|now)\b|\s+(?:because|since|as)\b[\s\S]*$)`;
const REPORT_ONLY_INSTRUCTION = new RegExp(
  String.raw`^(?:(?:report|status(?: update| report)?)[ -]only${REPORT_ONLY_TAIL}|(?:only|just)\s+(?:report|answer)\b)`,
  "u",
);
const REPORT_REQUEST_LEAD_IN =
  /^(?:(?:give|show|send)\s+me|provide(?:\s+me)?|(?:start|proceed)(?:\s+with)?)(?:\s+(?:a|an|the))?\s+/u;
const REPORT_ONLY_REQUEST_SUFFIX = new RegExp(
  String.raw`\b(?:report|status(?: update| report)?)[ -]only${REPORT_ONLY_TAIL}`,
  "u",
);
const REPORT_ONLY_EXPLANATION =
  /\b(?:report|status(?: update| report)?)[ -]only\s+(?:because|since|as)\b/u;
const FIRST_PERSON_CLAUSE = /^(?:i|we)\b/u;
const PLAIN_AND_SEPARATOR = /^\s+and\s+$/u;
const CLEANUP_CREW_HEADING =
  /^cleanup[ -]crew(?:\s+(?:production|build|repair|runtime|mission))*\s*[:,]?\s*/u;
const POLITE_REQUEST_LEAD_IN = /^(?:please|can you|could you|would you)(?:,\s*|\s+)/u;
// A negative verb with a specific object can be repair prose or a scoped
// exclusion. Only bare, temporal, or whole-mission negatives stop all work.
const WHOLE_MISSION_OBJECT = String.raw`(?:(?:this|the|all|any)\s+)?(?:(?:active|current|cleanup[ -]crew|production)\s+)*(?:work|build|repair|mission)`;
// A complete whole-mission stop remains authoritative when the operator adds
// timing, politeness, or an explanation. Arbitrary object suffixes stay scoped.
const WHOLE_MISSION_HOLD_POLITENESS = String.raw`(?:please|thanks|thank you)`;
const WHOLE_MISSION_HOLD_TIMING = String.raw`(?:right now|for (?:now|the moment|the time being)|at (?:this time|the moment)|now|here|yet|until\b[\s\S]*|before\b[\s\S]*|after\b[\s\S]*|without\b[\s\S]*)`;
const WHOLE_MISSION_HOLD_EXPLANATION = String.raw`(?:(?:because|since|as)\b|(?:just|only)\b)[\s\S]*`;
const WHOLE_MISSION_HOLD_SUFFIX = String.raw`\s*(?:,\s*)?(?:${WHOLE_MISSION_HOLD_POLITENESS}\s*,?\s*)?(?:${WHOLE_MISSION_HOLD_TIMING}\s*,?\s*)?(?:${WHOLE_MISSION_HOLD_POLITENESS}\s*,?\s*)?(?:${WHOLE_MISSION_HOLD_EXPLANATION})?\s*$`;
const DIRECT_WHOLE_MISSION_OBJECT = String.raw`(?:${WHOLE_MISSION_OBJECT}|(?:(?:this|the|current|active|all|any)\s+)?(?:cleanup[ -]crew|execution|production)|all|everything)`;
// Restart verbs require a complete execution target and a bounded tail. This
// keeps `proceed with the report only` from reauthorizing production.
const START_OR_PROCEED_EXECUTION_INSTRUCTION = new RegExp(
  String.raw`^(?:start|proceed)(?:\s+with)?\s+${DIRECT_WHOLE_MISSION_OBJECT}(?:\s+(?:please|right now|now|again|immediately))*\s*$`,
  "u",
);
const DO_NOT_DO_WORK_HOLD = new RegExp(
  String.raw`^(?:dont|don't|do not)\s+do\s+(?:any work|anything else)${WHOLE_MISSION_HOLD_SUFFIX}`,
  "u",
);
const DO_NOT_DO_WORK_ON_WHOLE_MISSION_HOLD = new RegExp(
  String.raw`^(?:dont|don't|do not)\s+do\s+(?:any\s+)?work\s+on\s+${WHOLE_MISSION_OBJECT}${WHOLE_MISSION_HOLD_SUFFIX}`,
  "u",
);
const BARE_HOLD_INSTRUCTION = new RegExp(
  String.raw`^(?:(?:explicitly\s+)?(?:pause|stop)|no execution|do nothing else|(?:dont|don't|do not)\s+(?:continue|execute|run|resume|start|proceed))${WHOLE_MISSION_HOLD_SUFFIX}`,
  "u",
);
const DIRECT_WHOLE_MISSION_HOLD = new RegExp(
  String.raw`^(?:(?:explicitly\s+)?(?:pause|stop))\s+${DIRECT_WHOLE_MISSION_OBJECT}${WHOLE_MISSION_HOLD_SUFFIX}`,
  "u",
);
const WHOLE_MISSION_ACTION_HOLD = new RegExp(
  String.raw`^(?:dont|don't|do not)\s+(?:continue|execute|run|resume|start|proceed)(?:\s+with)?\s+${WHOLE_MISSION_OBJECT}${WHOLE_MISSION_HOLD_SUFFIX}`,
  "u",
);
const WORK_ON_WHOLE_MISSION_HOLD = new RegExp(
  String.raw`^(?:(?:explicitly\s+)?stop\s+(?:(?:all|any|this|the)\s+)?(?:work|working)\s+on|(?:dont|don't|do not)\s+(?:continue|execute|run|resume|start|proceed)(?:\s+with)?\s+(?:work|working)\s+on)\s+${WHOLE_MISSION_OBJECT}${WHOLE_MISSION_HOLD_SUFFIX}`,
  "u",
);
const NO_EXECUTION_OF_WHOLE_MISSION_HOLD = new RegExp(
  String.raw`^no execution of\s+${WHOLE_MISSION_OBJECT}${WHOLE_MISSION_HOLD_SUFFIX}`,
  "u",
);

function isHoldInstruction(clause: string): boolean {
  return (
    DO_NOT_DO_WORK_HOLD.test(clause) ||
    DO_NOT_DO_WORK_ON_WHOLE_MISSION_HOLD.test(clause) ||
    BARE_HOLD_INSTRUCTION.test(clause) ||
    DIRECT_WHOLE_MISSION_HOLD.test(clause) ||
    WHOLE_MISSION_ACTION_HOLD.test(clause) ||
    WORK_ON_WHOLE_MISSION_HOLD.test(clause) ||
    NO_EXECUTION_OF_WHOLE_MISSION_HOLD.test(clause)
  );
}

function isExecutionInstruction(clause: string): boolean {
  return EXECUTION_INSTRUCTION.test(clause) || START_OR_PROCEED_EXECUTION_INSTRUCTION.test(clause);
}

function isReportOnlyInstruction(clause: string): boolean {
  const requestedReport = clause.replace(REPORT_REQUEST_LEAD_IN, "");
  const reportClause = requestedReport.replace(CLEANUP_CREW_HEADING, "");
  return (
    REPORT_ONLY_INSTRUCTION.test(reportClause) ||
    (requestedReport !== clause && REPORT_ONLY_REQUEST_SUFFIX.test(requestedReport))
  );
}

function normalizeInstructionClause(part: string): string {
  return (
    part
      .trim()
      .replace(/^[-*]\s+/u, "")
      .replace(/^(?:ok|okay|actually),\s*/u, "")
      .replace(POLITE_REQUEST_LEAD_IN, "")
      // Cleanup Crew is an existing addressed mission heading, not an action.
      .replace(CLEANUP_CREW_HEADING, "")
      .replace(POLITE_REQUEST_LEAD_IN, "")
  );
}

function instructionClauses(text: string | undefined): string[] {
  // Quoted examples and requested prompt contents are data, not operator holds.
  // Keep this local instruction matching independent of generated reply text.
  const current = (text ?? "")
    .toLowerCase()
    .replace(/[’]/gu, "'")
    .replace(/```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/gu, " ")
    .replace(/(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])/gu, " ")
    .replace(/^\s*>.*$/gmu, " ");
  return current.split(/[.!?\n]+/u).flatMap((sentence) => {
    const clauses: string[] = [];
    let artifactRequested = false;
    let artifactContentExpected = false;
    const parts = sentence.split(/(\s*;\s*(?:then\s+)?|\s+(?:(?:and|but)(?:\s+then)?|then)\s+)/u);
    for (let index = 0; index < parts.length; index += 2) {
      const clause = normalizeInstructionClause(parts[index]);
      const nextPart = parts[index + 2]?.trim();
      const hasFirstPersonReportTail =
        isReportOnlyInstruction(clause) &&
        PLAIN_AND_SEPARATOR.test(parts[index + 1] ?? "") &&
        Boolean(nextPart && FIRST_PERSON_CLAUSE.test(nextPart));
      if (REPORT_ONLY_EXPLANATION.test(clause) || hasFirstPersonReportTail) {
        // Plain `and` coordinates the explanation; explicit `and then`,
        // semicolon, or sentence boundaries still begin a new instruction.
        while (PLAIN_AND_SEPARATOR.test(parts[index + 1] ?? "") && parts[index + 2]) {
          index += 2;
        }
      }
      if (!clause) {
        continue;
      }
      const artifactDataClause =
        artifactContentExpected ||
        (artifactRequested && ARTIFACT_CONTENT_CONTINUATION.test(clause));
      if (artifactDataClause) {
        const explicitBoundary = /,\s*$/u.test(clause) || parts[index + 1]?.includes(";");
        artifactRequested = false;
        artifactContentExpected = false;
        if (explicitBoundary) {
          continue;
        }
        break;
      }
      clauses.push(clause);
      const artifact = ARTIFACT_REQUEST.exec(clause);
      if (artifact) {
        artifactRequested = true;
        const suffix = clause.slice(artifact[0].length);
        const explicitBoundary = /,\s*$/u.test(clause) || parts[index + 1]?.includes(";");
        // Prompts and build packets can contain imperative text as data. A plan's
        // later imperative remains an operator action unless a content verb marks it as data.
        const commandBearingArtifact = /\b(?:prompt|build packet)\b/u.test(artifact[0]);
        artifactContentExpected =
          commandBearingArtifact && ARTIFACT_CONTENT_SUFFIX.test(suffix) && !explicitBoundary;
      } else if (
        isExecutionInstruction(clause) ||
        PLANNING_ONLY_INSTRUCTION.test(clause) ||
        isReportOnlyInstruction(clause) ||
        isHoldInstruction(clause)
      ) {
        artifactRequested = false;
        artifactContentExpected = false;
      }
    }
    return clauses;
  });
}

/** Classify the actual current inbound instruction, never a report or history. */
export function classifyCurrentInboundInstruction(
  text: string | undefined,
): CurrentInboundInstruction {
  let instruction: CurrentInboundInstruction = "unrestricted";
  let planningArtifactRequested = false;
  for (const clause of instructionClauses(text)) {
    const artifact = ARTIFACT_REQUEST.exec(clause);
    if (artifact) {
      planningArtifactRequested = true;
      instruction = "planning_only";
      continue;
    }
    if (isExecutionInstruction(clause)) {
      instruction = "unrestricted";
      continue;
    }
    if (PLANNING_ONLY_INSTRUCTION.test(clause)) {
      planningArtifactRequested = true;
      instruction = "planning_only";
      continue;
    }
    if (isReportOnlyInstruction(clause)) {
      instruction = "report_only";
      continue;
    }
    if (isHoldInstruction(clause)) {
      // Later explicit instructions supersede earlier execution authorization.
      // Withholding execution still permits the requested plan/report artifact.
      instruction =
        instruction === "report_only"
          ? "report_only"
          : planningArtifactRequested
            ? "planning_only"
            : "no_work";
    }
  }
  return instruction;
}
