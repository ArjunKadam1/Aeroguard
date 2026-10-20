# Aeroguard — AI-Assisted Training Mode

## 1. Purpose

Aeroguard normally asks the trainee to run the whole loop by hand:
detect a contact, classify it from observable behavior, choose a response, and
supervise the simulated measure. The optional AI-assisted mode demonstrates the
same loop end to end, driven by a decision assistant, without turning the
assistant into an answer key or a competency score.

Operator assistance is an explicit landing-page choice:

```text
Operator assistance:  [ MANUAL ]  [ AI-ASSISTED ]
```

`MANUAL` is the default and the scored training loop. `AI-ASSISTED` is a
labelled demonstration mode. It is a per-session flag (`ai_assisted`), not a
scenario property: the scenario, difficulty, scoring formulas, and event
contract are unchanged.

## 2. What the assistant does

The assistant advances each contact through the same state machine a trainee
uses, one deliberate step at a time (`ASSIST_INTERVAL_S = 0.7s`):

1. **Detect** once any sensor track exists.
2. **Orient the sensor** until a visual track resolves the contact. Detection is
   not enough: classification requires `seenVisual`, so the assistant cannot
   skip the sensor model.
3. **Classify** from the public behavior cue via the decision endpoint.
4. **Respond** with the expected-response doctrine for the chosen label.
5. **Run the simulated measure**: request the proposal, approve it, and let the
   existing processing timer resolve it. The request and approval are recorded
   with `auto: true`.

Actions are applied through `SessionController` methods (`detect`,
`classify`, `respond`, `requestResponse`, `approveProposal`). The assistant can
never bypass a gate the trainee could not bypass: a stale stage, a missing
track, a duplicate request, or an unclassified contact is refused by the
controller exactly as it would be for a click.

### Sensor orientation

Classification needs a visual track, so the assistant must point the simulated
sensor:

- **Ground station:** the mast slews toward the observed contact it is already
  working (or the first observed one awaiting a classification), at the
  trainee's own sweep rate. With nothing observed it sweeps the sector, exactly
  as the search task expects.
- **Airborne:** a proportional autopilot follows the filtered track. Thrust
  scales with nose alignment and distance, so the scout arcs toward the contact
  instead of flying out along its old heading, eases into a 70-unit standoff
  (well inside the 150-unit visual range), and brakes rather than coasting past
  it. Altitude is held by a proportional-plus-damping throttle loop, so a long
  climb settles without overshooting. The aim point is smoothed across frames so
  the airframe follows the contact rather than the track filter's step. While
  nothing is observed it flies a slow search orbit whose radar reach covers the
  contact corridor. Forward authority never exceeds the trainee's own full
  stick.

This is navigation of a simulated airframe and mast only. It controls no real
system.

## 3. Decision engine

There is one decision endpoint, so the doctrine lives in one place:

```text
POST /api/v1/assist/decide
```

Request (public evidence only):

| field | meaning |
| --- | --- |
| `stage` | `classify` or `respond` |
| `behavior` | observable behavior signature, exactly what the trainee sees |
| `cue_clear` | whether the signature read cleanly |
| `flight_pattern`, `speed_class` | trainee-visible motion context |
| `observed_via` | `visual`, `radar`, or `both` |
| `swarm` | the contact is part of a formation group |
| `classification` | the assessment already submitted (required to respond) |

The request has no field for the hidden label or expected response, and the
service never reads them. Response: `{stage, decision, source}` where `source`
is `rules` or `llm`.

### Rule engine (default, offline)

The deterministic engine follows the published cue legend:

| behavior | classification |
| --- | --- |
| `steady-transit` | `friendly` |
| `slow-drift` | `civilian` |
| `erratic` | `unknown` |
| `orbiting` | `suspicious` |
| `direct-approach` | `hostile` |
| `indeterminate` / unknown | `unknown` |

Response doctrine: `friendly`/`civilian -> monitor`, `unknown -> track`,
`suspicious -> report`, `hostile -> hold`. An unreadable signature resolves to
the unresolved label rather than guessing an identity the sensor did not
resolve.

### Optional language model

Mirroring the AAR narrator (`app/services/aar_narrator.py`), the LLM path is
provider-agnostic and off by default:

```text
AEROGUARD_LLM_BASE_URL=https://provider.example/v1
AEROGUARD_LLM_API_KEY=...
AEROGUARD_LLM_MODEL=...
AEROGUARD_LLM_TIMEOUT_S=5
```

The client sends an OpenAI-compatible `/chat/completions` request with
`temperature: 0` and a fixed prompt that contains the observable evidence and the
published doctrine. The reply must be compact JSON with a `decision` string.
Any transport error, timeout, malformed reply, or out-of-vocabulary answer falls
back to the rule engine, so an offline or misconfigured deployment still works.
Both engines' answers are validated against the fixed vocabulary before they
leave the service.

## 4. Provenance and review

Every decision made by the assistant is recorded with:

- `aid: "assisted"` on detection, classification, and response events;
- `by: "assistant"` on the decision payload;
- `auto: true` on the workflow proposal and approval records.

An operator who takes a decision by hand inside an assisted session is recorded
with `by: "operator"` (still `aid: "assisted"`), so the record never claims the
assistant did something it did not. Manual sessions keep their existing payloads
unchanged (responses still carry `aid: "manual"`), so no prior event stream
changes shape.

The After Action Review then shows:

- an `AI-ASSISTED` chip in the session header and a banner stating that the
  session is labelled and excluded from competency scoring;
- an **Assistant decisions** card with per-stage counts (`assisted/total`) for
  detection, classification, and response;
- the existing **Response handling** manual/assisted split, unchanged.

The trainee's history keeps assisted sessions with an `ASSISTED` badge. The
dashboard's headline (latest/mean/best/sessions) and score trend exclude them,
matching the server's rollup, and a footnote says how many were excluded.

## 5. Scoring and rollups

Assisted sessions are demonstrations, not competency evidence:

- the session row stores `ai_assisted` and is still listed in trainee history;
- the adaptive level and recommendation exclude assisted sessions
  (`_completed_sessions` filters them by default);
- unit performance excludes assisted sessions;
- the client dashboard excludes them from headline statistics and the trend.

Scoring itself is untouched: the assistant's events flow through the same
`score_v2` path and produce a normal score, which describes what the assistant
did. The label and exclusion are what keep it out of the training signal.

## 6. Determinism and replay

Assistant decisions are persisted as normal events, so replay stays a pure
function of `(scenario seed, timeline)`: the debrief reconstructs the same
paths without re-running the assistant or the LLM. The mode adds no randomness
to scenario generation, contact motion, observation, or scoring. With the mode
off (the default), scenario bytes, event shapes, and scores are unchanged. The
contract test verifies the new route is documented in
`docs/api/openapi.yaml`.

## 7. Safety boundaries

The assistant stays inside the project's existing safety scope
(`docs/background/safety_scope.md`):

- decisions are abstract labels and expected responses, never free text;
- the request carries no ground truth and the endpoint returns no hidden answer;
- classification still requires a visual track from the sensor model;
- approval applies to an abstract simulated measure only; nothing is executed;
- there is no targeting, firing, interception, trajectory, pursuit, or real
  drone control anywhere in the mode.

## 8. Tests

- `backend/tests/test_ai_assisted.py` — rule doctrine, vocabulary enforcement,
  LLM parsing/fallback, endpoint validation, session labelling, rollup
  exclusion.
- `client/src/sim/assist.test.ts` — action sequencing, search/aim rules,
  mast slew, autopilot, patrol orbit.
- `client/src/state/session.test.ts` — assist provenance, automatic approval
  recording, and the full driver flow through the real gates.
- `client/src/ui/metrics.test.ts`, `aarView.test.ts`, `dashboardView.test.ts` —
  per-stage split, labelling, badge and score exclusion.
