# /handoff — Package Sprint for Transfer

You are generating a self-contained briefing optimized for a **successor** — someone who needs to continue this sprint, not a stakeholder making a decision. Read CLAUDE.md, claims.json, and compilation.json.

## Key distinction from other output commands

| Command | Audience | Optimized for |
|---------|----------|---------------|
| `/brief` | Decision-makers | "What should we do?" |
| `/present` | External audiences | Persuasion |
| `/status` | Current researcher | Snapshot |
| `/handoff` | Successor | "What do I need to know to continue?" |

## Process

1. **Run the compiler**:
   ```bash
   node wheat-compiler.js --summary
   ```

2. **Read all data sources**:
   - `compilation.json` — current state
   - `claims.json` — all claims including superseded ones (the full history)
   - `git log --oneline claims.json` — the event log
   - `CLAUDE.md` — sprint context and conventions

3. **Build the reasoning chain**: For each topic, reconstruct the narrative:
   - What constraint or question initiated work on this topic?
   - What did research find?
   - Did prototyping confirm or contradict research?
   - Were there conflicts? How were they resolved?
   - What feedback changed direction?
   - Where does this topic stand now?

   Infer causality from timestamps, `conflicts_with` references, phase transitions, and `resolved_by` links. Turn the bag of claims into a story.

4. **Identify open questions**: From compilation.json:
   - Unresolved conflicts (both sides, presented fairly)
   - Coverage gaps (topics with weak evidence)
   - Unmitigated risks (risk-type claims with no corresponding resolution)
   - Dismissed blind spots (from meta, if any)

5. **Generate the handoff document**: Create `output/handoff.md` with this structure:

```markdown
# Sprint Handoff: [question]

## Where Things Stand
- Phase: [current phase]
- Status: [ready/blocked]
- Claims: [total] total, [active] active, [conflicts] unresolved conflicts
- Last activity: [date from most recent git commit]

## The Reasoning Chain
[For each topic with substantial activity:]

### [Topic Name]
1. Started with: [constraint/initial claim]
2. Research found: [key research findings]
3. Prototyping showed: [key prototype results]
4. Conflicts resolved: [what conflicted, who won, why]
5. Feedback said: [key stakeholder input]
6. Current state: [where this stands now]

## Unresolved Questions
[Bulleted list of open conflicts, coverage gaps, unmitigated risks]

## How to Continue
[Specific actionable commands:]
- `/resolve X Y` to handle [conflict description]
- `/research Z` to fill [gap description]
- `/challenge [id]` to stress-test [assumption]
- `/witness [id] [url]` to corroborate [uncorroborated claim]

## Sprint Mechanics
- Claims file: claims.json ([N] claims)
- Compile: `node wheat-compiler.js --summary`
- Full status: Run `/status`
- Git log = event log: `git log --oneline claims.json`
```

6. **Generate HTML version**: Also create `output/handoff.html` using the dark scroll-snap template. Make it self-contained and visually clean.

7. **Print a summary** to the terminal.

## Git commit

Commit: `wheat: /handoff — generated sprint handoff document`

## Tell the user

- Point them to `output/handoff.md` and `output/handoff.html`
- Highlight the most important open questions
- Note the total claim count and how many topics have full reasoning chains
- Suggest: `/replay` for detailed timeline, `/blind-spot` for gap analysis

$ARGUMENTS