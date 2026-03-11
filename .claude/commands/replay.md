# /replay — Time-Travel Through Sprint Evolution

You are reconstructing the historical evolution of this sprint by recompiling every version of claims.json from git history.

## Process

1. **Get the git history of claims.json**:
   ```bash
   git log --oneline claims.json
   ```
   This gives every commit that touched claims.json — the sprint event log.

2. **Extract each historical version**: For each commit hash:
   ```bash
   git show <hash>:claims.json > /tmp/wheat-replay-<N>.json
   ```

3. **Recompile each version** with the current compiler using `--input`/`--output`:
   ```bash
   node wheat-compiler.js --input /tmp/wheat-replay-<N>.json --output /tmp/wheat-comp-<N>.json
   ```
   This applies today's compiler logic to historical data — showing what the compiler *would have said* at each point.

4. **Compute deltas** between consecutive compilations:
   ```bash
   node wheat-compiler.js --diff /tmp/wheat-comp-<N-1>.json /tmp/wheat-comp-<N>.json
   ```

5. **Identify interesting moments** in each delta:
   - Phase transitions (define → research → prototype → evaluate)
   - First time compilation went "ready"
   - Peak conflict count
   - Evidence tier jumps (topic going web → tested)
   - Claims added then superseded (the sprint changed its mind)
   - New topics appearing
   - Coverage status changes (weak → moderate → strong)

6. **Build the narrative**: For each frame (commit), create a summary:
   ```
   Frame N: <commit message>
     + X new claims (types breakdown)
     + Y new topics covered
     + Z conflicts: <details>
     + Evidence changes: <topic> went <from> → <to>
     ← Pivotal moment: <why this frame matters>
   ```

7. **Generate replay HTML**: Create `output/replay.html` — a self-contained timeline visualization. Use the dark scroll-snap template style. Include:
   - Frame-by-frame scrubbing (each commit = one frame)
   - Highlighted pivotal moments
   - Coverage evolution chart (topics × evidence over time)
   - Conflict graph evolution
   - Summary statistics per frame

8. **Also print a text summary** to the terminal with the key narrative moments.

## Git commit

Commit: `wheat: /replay — generated sprint timeline (N frames)`

## Tell the user

- How many frames (commits) were found
- The most interesting moments (phase transitions, conflicts, pivotal evidence jumps)
- Point them to `output/replay.html` for the full interactive timeline
- Suggest: `/handoff` to package this narrative for a successor

## Cleanup

Remove temporary files from /tmp after generating the output:
```bash
rm -f /tmp/wheat-replay-*.json /tmp/wheat-comp-*.json
```

$ARGUMENTS
