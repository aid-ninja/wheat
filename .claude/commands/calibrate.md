# /calibrate — Score Past Predictions Against Reality

You are checking what actually happened after a sprint's recommendations were implemented. This closes the feedback loop by comparing predictions to outcomes.

## Process

1. **Parse the outcome**: The user provides outcome data, either as:
   - Free text: `/calibrate --outcome "Shipped Auth0. Took 3 weeks not 2. Costs $18K/year not $15K."`
   - Claim-specific: `/calibrate e003 "actual: 3 weeks, $18K/year"`
   - If no outcome given, ask the user what happened after the sprint concluded.

2. **Read the sprint data**:
   - `claims.json` — the original predictions, estimates, recommendations
   - `compilation.json` — what was compiled and recommended

3. **Parse outcomes into calibration claims**: For each distinct outcome:
   - Create a `cal###` prefixed claim
   - Type: `factual` (these are real-world observations)
   - Evidence: `production` (these are measured from reality)
   - Source origin: `calibration`

```json
{
  "id": "cal001",
  "type": "factual",
  "topic": "<matched topic>",
  "content": "<what actually happened>",
  "source": {
    "origin": "calibration",
    "calibrated_claim": "<original claim ID>",
    "artifact": null,
    "connector": null
  },
  "evidence": "production",
  "status": "active",
  "phase_added": "evaluate",
  "timestamp": "<ISO timestamp>",
  "conflicts_with": [],
  "resolved_by": null,
  "tags": ["calibration", "outcome"]
}
```

4. **Match outcomes to original predictions**: For each calibration claim, identify which original claim it validates or invalidates:
   - Estimates: compare predicted vs actual (compute % variance)
   - Factuals: still true in production?
   - Risks: did they materialize?
   - Recommendations: did they succeed when implemented?

5. **Compute accuracy scorecard**:

   **By evidence tier:**
   ```
   stated:     X% accurate (N claims)
   web:        X% accurate (N claims)
   documented: X% accurate (N claims)
   tested:     X% accurate (N claims)
   ```

   **By source origin:**
   ```
   stakeholder: X% accurate (N claims)
   research:    X% accurate (N claims)
   prototype:   X% accurate (N claims)
   ```

   **By claim type:**
   ```
   estimates:       X% within 20% of actual
   factuals:        X% confirmed true
   risks:           X/N materialized
   recommendations: X/N succeeded
   ```

6. **Write/update calibration.json**: Store calibration results at repo level (persists across sprints):

```json
{
  "calibrations": [{
    "sprint_question": "<question>",
    "calibrated_at": "<ISO timestamp>",
    "claims_calibrated": 5,
    "accuracy": {
      "by_tier": { ... },
      "by_source": { ... },
      "by_type": { ... }
    },
    "details": [
      { "original": "e003", "outcome": "cal001", "accurate": false, "variance": "50%" }
    ]
  }],
  "aggregate": {
    "total_calibrated": 5,
    "overall_accuracy": 0.80,
    "tier_reliability": { "stated": 0.40, "web": 0.75, "documented": 1.0, "tested": 1.0 }
  }
}
```

7. **Add calibration claims to claims.json** and compile:
   ```bash
   node wheat-compiler.js --summary
   ```

8. **Print the scorecard** to the terminal.

## The meta-insight

This is the only command that validates the framework itself. If `tested` claims are right 95% of the time and `web` 65%, the tier system works. If both are 70%, the evidence hierarchy isn't adding value and needs rethinking.

## Git commit

Commit: `wheat: /calibrate — scored <N> predictions against outcomes`

## Tell the user

- The accuracy scorecard (by tier, by source, by type)
- Which predictions were wrong and by how much
- Whether the evidence tier hierarchy is predictive
- Where the sprint's reasoning was weakest
- Suggest: future sprints should weight evidence tiers based on this data

$ARGUMENTS
