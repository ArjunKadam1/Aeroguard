import { describe, expect, it } from "vitest";
import {
  buildSelectedPanelHtml,
  type ResponseAssistantView,
  type SelectedContact,
} from "./selectedPanel";

describe("buildSelectedPanelHtml", () => {
  it("shows an empty state when nothing is selected", () => {
    const html = buildSelectedPanelHtml(null);
    expect(html).toContain("No contact selected");
  });

  it("renders the selected contact's evidence and next step", () => {
    const html = buildSelectedPanelHtml({
      state: { id: "T01", stage: "spawned", behavior: "orbiting", track: "confirmed" },
      behaviorHint: "circling a point of interest — often suspicious",
      observer: "station",
      sensor: "visual",
      tracked: true,
      firstSeenMs: 2300,
      pos: { x: 123.4, z: -456.7, alt: 78.2 },
      speedClass: "fast",
      flightPattern: "wide-weave",
    });
    expect(html).toContain("T01");
    expect(html).toContain("spawned");
    expect(html).toContain("orbiting");
    expect(html).toContain("station · visual");
    expect(html).toContain("first seen 2.3s");
    expect(html).toContain("DETECT");
    expect(html).toContain("X +123 · Z -457 · ALT 78u");
    expect(html).toContain("fast");
    expect(html).toContain("wide-weave");
  });

  it("reports a lost track instead of a stale state", () => {
    const html = buildSelectedPanelHtml({
      state: { id: "T02", stage: "detected", behavior: "erratic", track: "coasting" },
      behaviorHint: "unpredictable maneuvers — identity unclear",
      observer: "airborne",
      sensor: "radar",
      tracked: false,
      firstSeenMs: null,
      pos: null,
      speedClass: null,
      flightPattern: null,
    });
    expect(html).toContain("no track");
    expect(html).toContain("first seen —");
  });

  it("never renders hidden answers", () => {
    const html = buildSelectedPanelHtml({
      state: { id: "T01", stage: "classified", behavior: "steady-transit", track: "confirmed" },
      behaviorHint: "steady, level flight — often friendly",
      observer: "station",
      sensor: "visual",
      tracked: true,
      firstSeenMs: 1000,
      pos: { x: 0, z: 0, alt: 45 },
      speedClass: "medium",
      flightPattern: "straight-transit",
    });
    expect(html).not.toContain("classification_label");
    expect(html).not.toContain("expected_response");
  });

  it("renders advisory guidance when one is provided", () => {
    const html = buildSelectedPanelHtml({
      state: { id: "T03", stage: "detected", behavior: "erratic", track: "tentative" },
      behaviorHint: "unpredictable maneuvers — identity unclear",
      observer: "station",
      sensor: "visual",
      tracked: true,
      firstSeenMs: 900,
      pos: null,
      speedClass: "fast",
      flightPattern: "erratic-jink",
      guidance: "The signature reads cleanly; treat the doctrine meaning as a prior, not a verdict.",
    });
    expect(html).toContain("sel-guidance");
    expect(html).toContain("prior, not a verdict");
    // The action line still follows: guidance advises, it never replaces the step.
    expect(html).toContain("Choose a <b>classification</b> below.");
  });

  it("never renders geographic coordinates", () => {
    // Position is a sim-grid reference, not a real-world fix.
    const html = buildSelectedPanelHtml({
      state: { id: "T01", stage: "spawned", behavior: "orbiting", track: "confirmed" },
      behaviorHint: "",
      observer: "station",
      sensor: "visual",
      tracked: true,
      firstSeenMs: 500,
      pos: { x: -70, z: 20, alt: 45 },
      speedClass: "slow",
      flightPattern: "orbit-hold",
    }).toLowerCase();
    for (const leaked of ["latitude", "longitude", "gps", "classification_label", "expected_response"]) {
      expect(html).not.toContain(leaked);
    }
    expect(html).toContain("x -70");
  });
});

describe("response assistant section", () => {
  function contact(assistant: ResponseAssistantView | null): SelectedContact {
    return {
      state: { id: "T01", stage: "classified", behavior: "steady-transit", track: "confirmed" },
      behaviorHint: "",
      observer: "station",
      sensor: "visual",
      tracked: true,
      firstSeenMs: 1000,
      pos: null,
      speedClass: "medium",
      flightPattern: "straight-transit",
      assistant,
    };
  }

  function view(overrides: Partial<ResponseAssistantView>): ResponseAssistantView {
    return {
      state: "ready",
      responseClass: null,
      measure: null,
      basis: null,
      outcome: null,
      cause: null,
      reason: null,
      ...overrides,
    };
  }

  it("renders nothing until the contact is classified", () => {
    // No assistant field at all, and an explicit null, both omit the section.
    expect(buildSelectedPanelHtml(contact(null))).not.toContain("Response assistant");
    const withoutField = contact(null);
    delete withoutField.assistant;
    expect(buildSelectedPanelHtml(withoutField)).not.toContain("Response assistant");
  });

  it("offers both request classes from the ready state", () => {
    const html = buildSelectedPanelHtml(contact(view({ state: "ready" })));
    expect(html).toContain("Response assistant");
    expect(html).toContain(`data-ra-action="request" data-ra-class="mitigation"`);
    expect(html).toContain(`data-ra-action="request" data-ra-class="weapon-class"`);
    expect(html).toContain("Mitigation (simulated)");
    expect(html).toContain("Weapon-class (simulated)");
    expect(html).toContain("training simulation");
    expect(html).not.toContain(`data-ra-action="approve"`);
  });

  it("renders the proposal with explicit approve and reject", () => {
    const html = buildSelectedPanelHtml(contact(view({
      state: "awaiting_approval",
      responseClass: "mitigation",
      measure: "simulated controlled mitigation",
      basis: "Proposed from what you can observe: you assessed T01 as hostile; a sensor track is held.",
    })));
    expect(html).toContain(`<p class="ra-class-chip">mitigation</p>`);
    expect(html).toContain("simulated controlled mitigation");
    expect(html).toContain("you assessed T01 as hostile");
    expect(html).toContain(`data-ra-action="approve"`);
    expect(html).toContain(`data-ra-action="reject"`);
  });

  it("marks a weapon-class proposal as an abstract authorization", () => {
    const html = buildSelectedPanelHtml(contact(view({
      state: "awaiting_approval",
      responseClass: "weapon-class",
      measure: "simulated weapon-class authorization",
      basis: "Proposed from what you can observe: you assessed T01 as hostile; a sensor track is held. "
        + "Weapon-class authorization is an abstract training decision; nothing is executed.",
    })));
    expect(html).toContain(`<p class="ra-class-chip">weapon-class</p>`);
    expect(html).toContain("simulated weapon-class authorization");
    expect(html).toContain("nothing is executed");
    expect(html).toContain(`data-ra-action="approve"`);
  });

  it("renders processing with a cancel affordance and no approve", () => {
    const html = buildSelectedPanelHtml(contact(view({ state: "in_progress" })));
    expect(html).toContain("Processing the approved simulated response");
    expect(html).toContain(`data-ra-action="cancel"`);
    expect(html).not.toContain(`data-ra-action="approve"`);
  });

  it("renders the resolved outcome with its cause, never a probability", () => {
    const html = buildSelectedPanelHtml(contact(view({
      state: "neutralized",
      outcome: "neutralized",
      cause: "The simulated measure resolved under clear visibility and high sensor fidelity.",
    })));
    expect(html).toContain("Simulated neutralization confirmed");
    expect(html).toContain("resolved under clear visibility");
    expect(html).toContain("ra-gain");
    const failed = buildSelectedPanelHtml(contact(view({
      state: "failed",
      outcome: "failed",
      cause: "The simulated measure did not resolve under reduced visibility.",
    })));
    expect(failed).toContain("Simulation unsuccessful");
    expect(failed).toContain("ra-loss");
    for (const htmlText of [html, failed]) {
      expect(htmlText).not.toContain("chance");
      expect(htmlText).not.toContain("probability");
    }
  });

  it("shows no fabricated result for aborted and offers a reopen only after rejection", () => {
    const aborted = buildSelectedPanelHtml(contact(view({ state: "aborted" })));
    expect(aborted).toContain("no result");
    expect(aborted).not.toContain("data-ra-action");
    const rejected = buildSelectedPanelHtml(contact(view({ state: "rejected" })));
    expect(rejected).toContain(`data-ra-action="reopen"`);
    expect(rejected).not.toContain(`data-ra-action="approve"`);
  });

  it("explains unavailability instead of offering an action", () => {
    const html = buildSelectedPanelHtml(contact(view({
      state: "unavailable",
      reason: "Simulated response resolution is unavailable: sensor fidelity is below the simulation threshold for this scenario.",
    })));
    expect(html).toContain("sensor fidelity is below the simulation threshold");
    expect(html).not.toContain("data-ra-action");
  });

  it("never renders hidden answers or real-engagement language in the assistant", () => {
    // "weapon-class" is a sanctioned authorization label (sim/response.ts):
    // the ban list keeps only ground-truth and real-action terms, so the class
    // name can render while firing/targeting wording still cannot.
    const states: ResponseAssistantView[] = [
      view({ state: "ready" }),
      view({
        state: "awaiting_approval",
        responseClass: "weapon-class",
        measure: "simulated weapon-class authorization",
        basis: "Proposed from what you can observe: you assessed T01 as hostile; a sensor track is held.",
      }),
      view({ state: "in_progress" }),
      view({ state: "neutralized", outcome: "neutralized", cause: "The simulated measure resolved." }),
      view({ state: "rejected" }),
      view({ state: "aborted" }),
    ];
    for (const assistant of states) {
      const html = buildSelectedPanelHtml(contact(assistant)).toLowerCase();
      for (const leaked of [
        "classification_label", "expected_response", "engage", "intercept",
        "trajectory", "pursuit", "fire", "target", "kill", "latitude", "longitude",
      ]) {
        expect(html).not.toContain(leaked);
      }
    }
  });
});
