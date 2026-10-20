import { describe, expect, it } from "vitest";
import { assessmentGuidance, type AssessmentEvidence } from "./coaching";

function evidence(over: Partial<AssessmentEvidence> = {}): AssessmentEvidence {
  return {
    stage: "detected",
    track: "confirmed",
    sensor: "visual",
    behavior: "orbiting",
    cueClear: true,
    ...over,
  };
}

describe("assessment guidance", () => {
  it("is silent unless a classification decision is open", () => {
    for (const stage of ["pending", "spawned", "classified", "responded"] as const) {
      expect(assessmentGuidance(evidence({ stage }))).toBeNull();
    }
  });

  it("recommends committing behind a confirmed visual fix", () => {
    const line = assessmentGuidance(evidence())!;
    expect(line).toContain("signature reads cleanly");
    expect(line).toContain("prior, not a verdict");
    expect(line).toContain("confirmed visual fix");
    expect(line).toContain("commit the classification your observation supports");
  });

  it("flags degraded cues distinctly, whatever the signature says", () => {
    const unclear = assessmentGuidance(evidence({ cueClear: false }))!;
    expect(unclear).toContain("unreadable under current conditions");
    expect(unclear).toContain("degraded, not absent");
    const indeterminate = assessmentGuidance(evidence({ behavior: "indeterminate" }))!;
    expect(indeterminate).toContain("unreadable under current conditions");
    expect(indeterminate).not.toContain("reads cleanly");
  });

  it("explains that radar alone cannot classify, at every track state", () => {
    for (const track of ["tentative", "confirmed", "coasting"] as const) {
      const line = assessmentGuidance(evidence({ track, sensor: "radar" }))!;
      expect(line).toContain("needs a visual fix");
      expect(line).not.toContain("commit the classification");
    }
    expect(assessmentGuidance(evidence({ track: "confirmed", sensor: "radar" })))
      .toContain("position only");
  });

  it("asks for a fix when no sensor holds the contact", () => {
    const line = assessmentGuidance(evidence({ track: "unseen", sensor: "radar" }))!;
    expect(line).toContain("No sensor holds this contact");
    expect(line).toContain("needs a visual fix");
  });

  it("treats a coasting visual fix as evidence, with a freshness warning", () => {
    const line = assessmentGuidance(evidence({ track: "coasting", sensor: "visual" }))!;
    expect(line).toContain("still evidence");
    expect(line).toContain("refresh the hold soon");
  });

  it("keeps tentative visual fixes conservative", () => {
    const line = assessmentGuidance(evidence({ track: "tentative", sensor: "visual" }))!;
    expect(line).toContain("tentative");
    expect(line).toContain("or hold a moment longer");
  });

  it("never names or maps a classification label for any signature", () => {
    const labels = ["hostile", "friendly", "civilian", "suspicious", "unknown"];
    const behaviors = [
      "steady-transit", "slow-drift", "erratic", "orbiting", "direct-approach", "indeterminate",
    ];
    for (const behavior of behaviors) {
      for (const track of ["unseen", "tentative", "confirmed", "coasting"] as const) {
        for (const sensor of ["visual", "radar"] as const) {
          const line = assessmentGuidance(evidence({ behavior, track, sensor }))!;
          const lower = line.toLowerCase();
          for (const forbidden of [...labels, "classification_label", "expected_response"]) {
            expect(lower).not.toContain(forbidden);
          }
        }
      }
    }
  });

  it("is deterministic for identical evidence", () => {
    expect(assessmentGuidance(evidence())).toBe(assessmentGuidance(evidence()));
  });
});
