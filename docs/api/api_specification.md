# Aeroguard — API Specification

## 1. API conventions

Base:

`/api/v1`

Content type:

`application/json`

Use Pydantic models for request/response validation.

## 2. Generate scenario

### Request

`POST /scenarios/generate`

```json
{
  "difficulty": 5,
  "environment": "urban",
  "time_of_day": "night",
  "threat_count": 2,
  "seed": 12345
}
```

### Response

```json
{
  "scenario_id": "SCN-100",
  "seed": 12345,
  "difficulty": 5,
  "environment": "urban",
  "time_of_day": "night",
  "sensor_quality": 0.7,
  "duration_seconds": 120,
  "threats": []
}
```

## 3. Create session

`POST /sessions`

```json
{
  "trainee_id": "TRAIN-001",
  "scenario_id": "SCN-100",
  "unit": "ALPHA-1",
  "ai_assisted": false
}
```

`ai_assisted` is optional and defaults to `false`. When true, the session is
labelled as an AI-assisted demonstration and excluded from competency rollups;
it still appears in the trainee's session history.

## 4. Submit event

`POST /sessions/{session_id}/events`

```json
{
  "type": "THREAT_DETECTED",
  "timestamp_ms": 1820,
  "threat_id": "T01",
  "payload": {}
}
```

## 5. Complete session

`POST /sessions/{session_id}/complete`

Response:

```json
{
  "session_id": "SES-1001",
  "detection_score": 30.0,
  "classification_score": 30.0,
  "response_score": 25.0,
  "timing_score": 15.0,
  "penalty": 0.0,
  "final_score": 100.0,
  "aar_available": true,
  "scoring_version": 1
}
```

## 6. Retrieve AAR

`GET /sessions/{session_id}/aar`

Response should include:

- summary
- scores
- timing
- mistakes
- strengths
- weaknesses
- recommendation

## 7. Performance

`GET /trainees/{trainee_id}/performance`

Returns historical aggregates.

## 8. Recommendation

`POST /training/recommend`

Input:

```json
{
  "trainee_id": "TRAIN-001"
}
```

Output:

```json
{
  "recommended_difficulty": 6,
  "environment": "urban",
  "time_of_day": "night",
  "threat_count": 3,
  "reason": "Recent sessions show weaker performance under night and multi-threat conditions."
}
```

## 9. AI decision assistant

`POST /assist/decide`

Optional support for the labelled AI-assisted training mode. The request carries
public observable evidence only (stage, behavior signature, flight pattern, speed
class, sensor source, formation flag, and the assessment already submitted); it
never carries the hidden label or expected response.

```json
{
  "stage": "classify",
  "behavior": "orbiting",
  "cue_clear": true,
  "flight_pattern": "orbit-hold",
  "speed_class": "medium",
  "observed_via": "visual",
  "swarm": false
}
```

```json
{
  "stage": "classify",
  "decision": "suspicious",
  "source": "rules"
}
```

`source` is `rules` for the deterministic offline engine and `llm` when a
configured OpenAI-compatible model answered. Any failure or out-of-vocabulary
reply falls back to the rules. A `respond` request additionally requires
`classification`, so the response doctrine follows the assessment actually
submitted. See `docs/modules/ai_assisted_mode.md`.

## 10. API rules

- validate every request
- reject unknown enum values
- return meaningful HTTP status codes
- never trust client-provided final scores
- calculate scores server-side when backend mode is enabled
