# Aeroguard — Scenario Engine

## 1. Purpose

The scenario engine creates repeatable but variable training situations.

It must prevent rote memorization while keeping scenarios controlled enough to score objectively.

## 2. Scenario dimensions

### Environment

- urban
- rural

### Time

- day
- night

### Visibility

- clear
- reduced
- poor

### Sensor quality

Numeric value from 0 to 1.

Example:

`1.0 = clear`

`0.7 = mild degradation`

`0.4 = strong degradation`

`0.2 = severe degradation`

### Threat count

Start with:

- 1
- 2
- 3
- 5

The prototype does not need hundreds of simultaneous objects.

Contacts can optionally be grouped into swarms (`swarms: true` on the generate
request). A swarm is a partition of the requested contacts, never an extra
count: 3 contacts become one group of three or a pair plus one independent
contact; 5 become five, or three plus two. Members share identity, pattern,
spawn time and speed, fly as one formation, and are still detected, classified,
responded to and scored individually.

### Difficulty

Integer 1–10.

## 3. Threat profile

Each simulated object should have a logical profile separate from its 3D model.

Example:

```json
{
  "id": "T01",
  "category": "unknown_aerial_object",
  "classification_label": "suspicious",
  "expected_response": "report",
  "spawn_time": 18.4,
  "speed_class": "medium",
  "visibility_class": "reduced",
  "swarm_id": "S01",
  "swarm_index": 0
}
```

These labels are training abstractions.

Swarm membership is observable behavior, not an answer: `swarm_id` groups
contacts and `swarm_index` 0 marks the lead. Both fields are optional (null for
an independent contact) and are echoed in the public view. A contact sets both
or neither. Grouping is opt-in, so every existing seed stays byte-identical.

## 4. Seeded randomization

Each scenario should contain:

```json
{
  "scenario_id": "SCN-001",
  "seed": 483921,
  "generator_version": "1.0"
}
```

The seed allows the same scenario to be recreated for debugging.

## 5. Difficulty model

Difficulty can depend on:

```text
D = base
  + threat_count_factor
  + visibility_factor
  + sensor_factor
  + timing_factor
  + distraction_factor
  + motion_factor
```

Motion prices demanding flight patterns (wide-weave, erratic-jink) into
difficulty one-for-one against conditions: patterns are drawn within the
residual budget, so feasibility never depends on the draw, and calm mixes
keep byte-exact conditions. The client setup floor stays a valid lower bound
because motion is never negative.

Swarm grouping is deliberately absent from the formula. The group's most
demanding pattern is assigned to every member before the residual condition
split, so motion, conditions and the declared difficulty are identical to the
ungrouped run of the same seed.

Do not make difficulty a black box.

Every increase should have a reason.

## 6. Example generated scenario

```json
{
  "scenario_id": "SCN-104",
  "seed": 90321,
  "environment": "urban",
  "time_of_day": "night",
  "visibility": 0.55,
  "sensor_quality": 0.65,
  "difficulty": 6,
  "duration_seconds": 120,
  "threats": [
    {
      "id": "T01",
      "spawn_time": 12.4,
      "classification_label": "suspicious",
      "expected_response": "report"
    },
    {
      "id": "T02",
      "spawn_time": 48.7,
      "classification_label": "unknown",
      "expected_response": "track"
    }
  ]
}
```

## 7. Anti-repetition rules

The generator should avoid:

- same seed
- same threat count repeatedly
- same spawn positions repeatedly
- same sequence of events
- same environment for every session

It can enforce:

- cooldown on recently used configurations
- bounded randomization
- controlled difficulty variation

## 8. Scenario validation

Before a scenario is released to the trainee, validate:

- duration > 0
- threat ids unique
- spawn times inside scenario duration
- classification labels valid
- response labels valid
- difficulty inside 1–10
- sensor quality inside 0–1
- swarm groups have at least two members
- swarm indices are contiguous from 0 and unique inside their group
- swarm members share label, response, flight pattern, spawn time and speed
- a contact sets both swarm fields or neither

Invalid scenarios must be rejected before gameplay.

## 9. Swarm grouping and client flight

Grouping uses a dedicated RNG stream (`swarm:<seed>`), so enabling it never
disturbs the draws that visibility, sensor quality, duration, labels or spawn
times come from. Group ids are assigned in index order; the lead is index 0.
Every member keeps its own id, track, classification and scored response.

The client builds membership only from the public scenario. The lead flies its
normal path; each wingman rides a loose slot in the lead's local frame with a
bounded, seeded wander. Slots keep members tens of units apart so each remains
a distinct visual and sensor contact. Decorative escorts are suppressed for
real members. The whole formation is a pure function of the public scenario, so
replay stays bit-identical.
