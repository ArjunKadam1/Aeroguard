# Aeroguard — Safety and Scope

## Purpose

Aeroguard is a simulated training and assessment system.

The engineering scope should remain focused on:

- recognition
- classification
- observation
- abstract response decisions
- performance assessment
- training adaptation

## Explicitly out of scope

Do not implement:

- weapon targeting
- weapon firing
- interception trajectories
- autonomous physical engagement
- real-world target coordinates
- guidance for defeating real counter-drone systems
- operational attack planning
- real physical drone control

## Why

The problem statement can be solved convincingly without these components.

The value of the prototype is the training loop:

`observe -> identify -> decide -> measure -> review -> improve`

## Data safety

Use synthetic trainee ids in the prototype.

Do not store sensitive personal information unless there is a clear requirement.

## Demonstration data

Use simulated scenarios and clearly label them as synthetic.

## Explainability

Scores and recommendations must be based on recorded simulator events, not opaque claims.

## AI policy for the prototype

AI should support:

- scenario generation
- adaptive difficulty
- performance analysis
- an optional, labelled decision assistant for demonstration

AI should not be used to create operational engagement instructions.

## AI-assisted training mode

The optional AI-assisted mode automates the training loop
(`detect -> classify -> respond`) inside the simulator only.

Its boundaries:

- The assistant is fed public, trainee-visible evidence only. It never reads
  the scenario's hidden label or expected response, so it cannot leak the
  answer key into the session record.
- Output is restricted to the existing abstract vocabulary: five classification
  labels and four expected responses. No free text reaches the trainee.
- Decisions still pass through the same session gates as a trainee's clicks,
  are recorded with assist provenance, and are labelled in the After Action
  Review.
- Assisted sessions are excluded from competency scoring, adaptive level, and
  unit rollups. They remain visible in the trainee's own history with an
  ASSISTED badge.
- The assistant may orient the simulated sensor (mast slew or simulated
  airframe autopilot) to obtain a visual track. That is simulation navigation,
  not control of any real system.
- Approval of a simulated measure is automatic in this mode, as a documented
  demonstration exception to the otherwise explicit-approval rule. The measure
  is abstract and simulated; nothing is executed, and no targeting, firing,
  interception, or pursuit is implemented.

The deterministic rule engine is the default and always available offline. The
optional language-model path is configuration-gated (`AEROGUARD_LLM_*`) and any
error, timeout, or out-of-vocabulary reply falls back to the rules.
