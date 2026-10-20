# Aeroguard — Architecture Decision Record

## ADR-001 — Unity for simulation

### Decision

Use Unity for the desktop simulator.

### Reason

Unity provides mature 3D rendering, input, lighting, UI and future VR support.

### Rejected alternative

Building the 3D simulator entirely in Python.

Reason for rejection: unnecessary graphics complexity and weaker VR path.

---

## ADR-002 — FastAPI for backend

### Decision

Use Python + FastAPI.

### Reason

The team can rapidly build typed APIs and reuse Python for scenario generation, scoring and analytics.

---

## ADR-003 — SQLite for prototype

### Decision

Use SQLite.

### Reason

Local, simple, portable and sufficient for prototype sessions.

---

## ADR-004 — Rule-based adaptive difficulty first

### Decision

Start with explicit rules.

### Reason

The system needs explainability and there is no initial real training dataset.

ML can be evaluated later using generated session data.

---

## ADR-005 — Desktop first, VR later

### Decision

Desktop is the primary development target.

### Reason

The problem statement permits desktop or VR-capable simulation. Desktop development lowers hardware requirements and allows the team to validate the training loop first.

---

## ADR-006 — Event-based session recording

### Decision

Record important trainee actions as timestamped events.

### Reason

Events enable reproducible scoring, AAR timelines and future analytics.

---

## ADR-007 — Ground truth separated from presentation

### Decision

Threat truth lives in scenario data, not in the visible 3D model.

### Reason

This prevents graphics code from becoming the scoring authority and allows visual assets to change without changing training logic.

---

## ADR-008 — Swarms are a partition of the requested contacts

### Decision

Grouping is opt-in per request (`swarms: true`) and never adds contacts: the
requested contacts are partitioned into groups of two or more, and every member
is still detected, classified, responded to and scored on its own. Members share
one identity (label, response, pattern, spawn time, speed) and fly as a
formation. The public view carries `swarm_id`/`swarm_index`; the client derives
positions from the lead's plan and a seeded loose slot, never from hidden
classification.

### Reason

Several separately scored contacts flying as one group add realistic
multi-contact pressure without changing the difficulty model, the contact
count, or any scoring denominator. A partition keeps every existing invariant
(and every existing golden scenario) valid. Keeping the grouping flag off by
default makes the change byte-identical for all current seeds, and a dedicated
RNG stream keeps grouping from perturbing condition draws.

### Rejected alternative

Adding swarm contacts on top of the requested count.

Reason for rejection: it would create counts outside the supported
`threat_count` values, change the difficulty model, and silently change
existing scoring and calibration.

### Rejected alternative

A single closely spaced 3D formation.

Reason for rejection: tightly spaced members read as one echo and one visual
contact, which defeats separate classification, response and scoring.

## ADR-009 — AI-assisted mode is labelled and excluded from competency scoring

### Decision

The landing page offers an explicit `Operator assistance: MANUAL | AI-ASSISTED`
choice. Manual is the default and the scored training loop. In AI-assisted mode
a decision assistant drives the whole loop through the existing controller
methods:

- detection, once any sensor track exists;
- sensor orientation (mast slew or simulated-airframe autopilot) until a visual
  track supports classification;
- classification and response, answered by one backend endpoint
  (`POST /api/v1/assist/decide`) from public evidence only;
- the simulated-measure workflow (`request -> approve -> resolve`), approved
  automatically and recorded with `auto: true`.

Every decision is recorded with `aid: "assisted"` / `by: "assistant"`
provenance, and the session carries an additive `ai_assisted` flag. Assisted
sessions remain in the trainee's own history (badged `ASSISTED`) but are
excluded from the competency score rollups: adaptive level and recommendation,
unit performance, and the client dashboard's headline/trend.

### Reason

The mode demonstrates the full detect-classify-respond pipeline without turning
the assistant into an answer key or letting an automated score masquerade as
trainee competency. Applying decisions through the same methods keeps every
gate, event ordering, scoring formula and replay path untouched: the assistant
can only do what a trainee could do, and the session record says who did it. One
server endpoint keeps the decision doctrine in a single place, while the rule
engine keeps the demo deterministic and offline.

### Rejected alternative

Duplicating the decision rules in the browser.

Reason for rejection: two copies of the doctrine would drift, and the optional
LLM path would then either be client-side (exposing provider credentials) or a
second, divergent implementation.

### Rejected alternative

Scoring assisted sessions normally, with a label only.

Reason for rejection: an automated score would feed the adaptive level and unit
rollups, corrupting the training signal for real trainees. A label without
exclusion is not enough.

### Documented exception

Approval of the simulated measure is automated in this mode. This is a
deliberate, mode-scoped exception to the earlier "never auto-approves" rule for
idle automations: the measure is abstract and simulated, nothing is executed,
and the mode is labelled and excluded from competency scoring. Manual sessions
keep the explicit-approval rule unchanged.
