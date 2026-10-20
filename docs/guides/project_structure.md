# Aeroguard — Recommended Project Structure

```text
Aeroguard/
│
├── README.md
├── LICENSE
├── .gitignore
│
├── docs/
│   ├── background/
│   │   ├── problem_and_scope.md
│   │   └── safety_scope.md
│   ├── modules/
│   │   ├── blueprint.md
│   │   ├── system_architecture.md
│   │   ├── scenario_engine.md
│   │   ├── scoring_engine.md
│   │   ├── event_and_data_model.md
│   │   ├── aar_and_adaptive_training.md
│   │   ├── ai_assisted_mode.md
│   │   ├── ai_implementation.md
│   │   ├── unity_prototype.md
│   │   ├── fastapi_backend.md
│   │   └── ui_ux.md
│   ├── api/
│   │   ├── api_specification.md
│   │   └── openapi.yaml
│   ├── project-management/
│   │   ├── product_requirements.md
│   │   ├── decisions.md
│   │   ├── development_checklist.md
│   │   ├── build_order.md
│   │   ├── git_workflow.md
│   │   ├── demo_validation.md
│   │   └── troubleshooting.md
│   ├── guides/
│   │   ├── start_here.md
│   │   ├── local_setup.md
│   │   ├── testing_validation.md
│   │   ├── project_structure.md
│   │   └── first_vertical_slice.md
│   └── plans/
│       ├── 00-master-roadmap.md
│       └── phase-0-environment.md
│
├── simulator/
│   └── UnityProject/
│
├── backend/
│   ├── app/
│   ├── tests/
│   ├── requirements.txt
│   └── .env.example
│
├── dashboard/
│   └── web/
│
├── data/
│   ├── scenarios/
│   └── fixtures/
│
└── scripts/
```

## Important

Do not create every directory before it is needed.

Start with:

```text
docs/
backend/
simulator/
```

Then grow the project as functionality is implemented.

## Separation

### simulator/

Only Unity-related code and assets.

### backend/

Scenario, scoring, storage, AAR and adaptive logic.

### dashboard/

Optional analytics UI.

### data/

Test fixtures and scenario definitions that are safe to distribute with the prototype.

### docs/

Engineering truth: requirements, architecture and decisions.
