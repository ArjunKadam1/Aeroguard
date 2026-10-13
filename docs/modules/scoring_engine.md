# Aeroguard — Scoring Engine

## 1. Purpose

The scoring engine converts observable trainee actions into objective performance metrics.

It should be deterministic and explainable.

## 2. Recommended initial score

Use 100 points:

- Detection: 30
- Classification: 30
- Response decision: 25
- Timing: 15

This is a starting configuration, not a scientifically validated operational score.

## 3. Detection

Possible outcomes:

- correct detection
- missed threat
- invalid/false detection

Example:

```text
Correct detection: +30
Missed threat: 0
False alarm: -5
```

Penalties can be configured separately.

## 4. Classification

```text
Correct: full classification points
Incorrect: zero classification points
```

Do not make the scoring depend on how "close" two labels sound unless you have a justified taxonomy.

## 5. Response

The scenario stores an expected abstract response category.

Example:

```text
expected_response = "report"
trainee_response = "report"
```

=> correct.

The system should not expose operational response logic.

## 6. Timing

Use a configurable response-time curve.

Example:

```text
<= target time: 15
<= target + tolerance: 10
<= maximum time: 5
> maximum time: 0
```

Avoid making a single arbitrary threshold the only determinant.

## 7. Final score

```text
final_score =
    detection_score
  + classification_score
  + response_score
  + timing_score
  - penalties
```

Clamp the displayed score to 0–100.

## 8. Decision tree

```text
Threat present?
|
+-- No --> False-alarm check
|
+-- Yes --> Detected?
             |
             +-- No --> Missed threat
             |
             +-- Yes --> Classification correct?
                           |
                           +-- No --> Classification error
                           |
                           +-- Yes --> Response correct?
                                        |
                                        +-- No --> Decision error
                                        |
                                        +-- Yes --> Timing evaluation
```

## 9. Metrics

At minimum calculate:

- detection accuracy
- classification accuracy
- response accuracy
- false-alarm rate
- missed-threat count
- mean detection time
- mean decision time
- final score

## 10. Example

```text
Detection = 30/30
Classification = 30/30
Response = 25/25
Timing = 12/15
Penalty = 5

Final = 92
```

## 11. Important implementation rule

Do not let Unity directly decide:

`if button == correct then score += 30`

Instead, Unity records the trainee action and the scoring engine evaluates it against the scenario ground truth.

This keeps the scoring system testable and auditable.

## 12. Version history

- **v1:** timing rewards the detection→response latency only. Spawn→detection
  is measured in the AAR but unscored.
- **v2:** timing is the mean of the acquisition curve (spawn→detection) and
  the decision curve (detection→response) on the same tier scale.
  Component maxima (30/30/25/15) are unchanged, so v1 and v2 scores share
  one 0–100 interpretation. Historical v1 rows keep their version and are
  returned as stored; only new completions score under v2.
