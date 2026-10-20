# Aeroguard — Event and Data Model

## 1. Event sourcing concept

A session should be represented as a sequence of observable events.

Example:

```text
SESSION_STARTED
THREAT_SPAWNED
THREAT_DETECTED
CLASSIFICATION_SUBMITTED
RESPONSE_SUBMITTED
THREAT_RESOLVED
SESSION_COMPLETED
```

## 2. Event structure

```json
{
  "event_id": "EVT-001",
  "session_id": "SES-1001",
  "timestamp_ms": 1740,
  "type": "THREAT_DETECTED",
  "threat_id": "T01",
  "payload": {
    "confidence": 0.81
  }
}
```

## 3. Recommended event types

- SESSION_STARTED
- SCENARIO_LOADED
- THREAT_SPAWNED
- THREAT_DETECTED
- CLASSIFICATION_SUBMITTED
- RESPONSE_SUBMITTED
- FALSE_ALARM
- THREAT_MISSED
- THREAT_RESOLVED
- SESSION_PAUSED
- SESSION_RESUMED
- SESSION_COMPLETED

## 4. Session model

```text
Session
- id
- trainee_id
- scenario_id
- ai_assisted
- started_at
- completed_at
- score
- status
```

`ai_assisted` labels the optional demonstration mode. Labelled sessions are
listed in trainee history but excluded from adaptive and unit rollups; see
`docs/modules/ai_assisted_mode.md`.

## 5. Scenario model

```text
Scenario
- id
- seed
- generator_version
- environment
- time_of_day
- visibility
- sensor_quality
- difficulty
- duration
```

## 6. Score model

```text
Score
- session_id
- detection_score
- classification_score
- response_score
- timing_score
- penalty
- final_score
```

## 7. Performance profile

```text
PerformanceProfile
- trainee_id
- detection_accuracy
- classification_accuracy
- response_accuracy
- average_reaction_time
- night_performance
- low_visibility_performance
- multi_threat_performance
- current_level
```

## 8. Database recommendation

For the prototype:

SQLite.

Suggested tables:

```sql
scenarios
sessions
events
scores
performance_profiles
```

## 9. Why events matter

Events allow you to later answer:

- What happened first?
- How long did the trainee take?
- Which threat was missed?
- Which classification was wrong?
- Which condition causes the most errors?

Without events, AAR becomes guesswork.
