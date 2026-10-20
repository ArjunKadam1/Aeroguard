import { describe, expect, it } from "vitest";
import {
  ALERT_CAP,
  buildAlertsHtml,
  pushAlerts,
  trackAlerts,
  type AlertEntry,
  type ObservedState,
  type TrackAlert,
} from "./alerts";

function state(id: string, track: ObservedState["track"], stage: ObservedState["stage"] = "spawned"): ObservedState {
  return { id, stage, track };
}

describe("track alerts", () => {
  it("stays silent when nothing observable changed", () => {
    const snapshot = [state("T01", "confirmed"), state("T02", "unseen")];
    expect(trackAlerts(snapshot, snapshot)).toEqual([]);
  });

  it("ignores stage-only changes: stage moves are trainee actions", () => {
    const before = [state("T01", "confirmed", "spawned")];
    const after = [state("T01", "confirmed", "detected")];
    expect(trackAlerts(before, after)).toEqual([]);
  });

  it("announces an acquisition from an unseen contact", () => {
    const alerts = trackAlerts([state("T01", "unseen")], [state("T01", "tentative")]);
    expect(alerts).toEqual([
      { id: "T01", kind: "acquired", tone: "gain", text: "T01 acquired — tentative track" },
    ]);
  });

  it("announces a direct confirmed acquisition distinctly", () => {
    const alerts = trackAlerts([state("T01", "unseen")], [state("T01", "confirmed")]);
    expect(alerts[0].kind).toBe("acquired");
    expect(alerts[0].text).toContain("track confirmed");
  });

  it("announces a tentative track firming up", () => {
    const alerts = trackAlerts([state("T01", "tentative")], [state("T01", "confirmed")]);
    expect(alerts).toEqual([
      { id: "T01", kind: "confirmed", tone: "gain", text: "T01 track confirmed" },
    ]);
  });

  it("announces coasting as a loss of hold", () => {
    const alerts = trackAlerts([state("T01", "confirmed")], [state("T01", "coasting")]);
    expect(alerts).toEqual([
      { id: "T01", kind: "coasting", tone: "loss", text: "T01 coasting — re-aim a sensor" },
    ]);
  });

  it("announces a reacquisition after coasting", () => {
    const alerts = trackAlerts([state("T01", "coasting")], [state("T01", "confirmed")]);
    expect(alerts[0]).toEqual({
      id: "T01", kind: "confirmed", tone: "gain", text: "T01 track confirmed",
    });
  });

  it("announces a lost contact", () => {
    const alerts = trackAlerts([state("T01", "coasting")], [state("T01", "unseen")]);
    expect(alerts).toEqual([
      { id: "T01", kind: "lost", tone: "loss", text: "T01 lost from the sensor picture" },
    ]);
  });

  it("treats a contact missing from the previous snapshot as unseen", () => {
    const alerts = trackAlerts([], [state("T02", "tentative")]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual({
      id: "T02", kind: "acquired", tone: "gain", text: "T02 acquired — tentative track",
    });
  });

  it("reports every transition once, in contact order", () => {
    const before = [state("T01", "confirmed"), state("T02", "tentative"), state("T03", "unseen")];
    const after = [state("T01", "coasting"), state("T02", "confirmed"), state("T03", "unseen")];
    const alerts = trackAlerts(before, after);
    expect(alerts.map((alert) => [alert.id, alert.kind])).toEqual([
      ["T01", "coasting"],
      ["T02", "confirmed"],
    ]);
    // Repeating the diff on the settled snapshot yields nothing: dedupe.
    expect(trackAlerts(after, after)).toEqual([]);
  });

  it("never names a classification or a response in any alert", () => {
    const tracks: ObservedState["track"][] = ["unseen", "tentative", "confirmed", "coasting"];
    const texts: string[] = [];
    for (const from of tracks) {
      for (const to of tracks) {
        for (const alert of trackAlerts([state("T01", from)], [state("T01", to)])) {
          texts.push(alert.text);
        }
      }
    }
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      for (const forbidden of [
        "hostile", "friendly", "civilian", "suspicious", "unknown",
        "classification", "expected_response", "label",
      ]) {
        expect(text.toLowerCase()).not.toContain(forbidden);
      }
    }
  });
});

describe("alert strip entries", () => {
  const alerts: TrackAlert[] = [
    { id: "T01", kind: "acquired", tone: "gain", text: "T01 acquired — tentative track" },
    { id: "T02", kind: "lost", tone: "loss", text: "T02 lost from the sensor picture" },
  ];

  it("prepends the newest batch and keeps prior entries below", () => {
    const older: AlertEntry[] = [{ alert: alerts[0], atMs: 1000 }];
    const next = pushAlerts(older, alerts, 2000);
    expect(next.map((entry) => entry.atMs)).toEqual([2000, 2000, 1000]);
  });

  it("caps the strip so old entries fall off", () => {
    let entries: AlertEntry[] = [];
    for (let i = 0; i < ALERT_CAP + 2; i += 1) {
      entries = pushAlerts(entries, [alerts[0]], i * 1000, ALERT_CAP);
    }
    expect(entries).toHaveLength(ALERT_CAP);
    // Newest first: the last push is the head.
    expect(entries[0].atMs).toBe((ALERT_CAP + 1) * 1000);
  });

  it("returns an unchanged copy for an empty batch", () => {
    const entries: AlertEntry[] = [{ alert: alerts[0], atMs: 1000 }];
    expect(pushAlerts(entries, [], 2000)).toEqual(entries);
  });
});

describe("alert strip html", () => {
  it("shows a monitoring placeholder before any change", () => {
    const html = buildAlertsHtml([]);
    expect(html).toContain("Alerts");
    expect(html).toContain("Monitoring");
    expect(html).not.toContain("alert-row");
  });

  it("renders rows with tone, time, text, and focus id", () => {
    const entries: AlertEntry[] = [
      { alert: { id: "T02", tone: "loss", text: "T02 lost from the sensor picture" }, atMs: 4500 },
      { alert: { id: "T01", tone: "gain", text: "T01 acquired — tentative track" }, atMs: 1000 },
    ];
    const html = buildAlertsHtml(entries);
    expect(html).toContain(`data-alert-id="T02"`);
    expect(html).toContain("alert-loss");
    expect(html).toContain("T+4.5s");
    expect(html).toContain("T02 lost from the sensor picture");
    expect(html).toContain("alert-gain");
    expect(html).toContain("T+1.0s");
    // Newest first: T02's row precedes T01's.
    expect(html.indexOf("T02")).toBeLessThan(html.indexOf("T01"));
    expect(html).toContain('role="log"');
  });
});
