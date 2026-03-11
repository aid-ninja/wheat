# /merge — Combine Claim Sets Across Sprints

You are merging claims from another sprint into the current one. This is for when two teams researched the same problem independently and need to combine their findings.

## Process

1. **Parse the argument**: The user provides a path to another sprint's claims.json.
   - Example: `/merge ../auth-sprint/claims.json`
   - If no path given, ask for it.

2. **Validate both claim sets**:
   - Read the current `claims.json`
   - Read the incoming claims file
   - Validate both against the compiler schema by compiling each independently:
     ```bash
     node wheat-compiler.js --input <incoming-path> --output /tmp/wheat-merge-incoming.json
     ```
   - If either fails validation, report errors and stop.

3. **Determine the sprint slug**: Derive a short slug from the incoming sprint's `meta.question` (e.g., "How should we implement auth?" → `auth`). This prefixes incoming claim IDs to avoid collisions.

4. **Resolve ID collisions**: Prefix all incoming claim IDs with the sprint slug:
   - `r001` → `auth-r001`
   - `p003` → `auth-p003`
   - Also update all `conflicts_with` and `resolved_by` references in incoming claims.

5. **Align topics**: Present probable topic mappings for user confirmation. Use keyword overlap and Levenshtein-like similarity:
   ```
   Topic alignment:
     incoming "authentication" ↔ current "auth" — likely same, merge? [Y/n]
     incoming "scalability" — no match, add as new topic? [Y/n]
     incoming "cost" ↔ current "pricing" — possible match, merge? [y/N]
   ```
   Wait for user confirmation before proceeding. For automated runs, describe what you'd do and ask.

6. **Detect cross-sprint conflicts**: For aligned topics, check if incoming claims contradict current claims (same topic, different conclusions). Mark conflicts with `conflicts_with`.

7. **Identify evidence upgrades**: If the incoming sprint has higher-evidence claims on the same assertion as the current sprint (e.g., incoming has `tested`, current has `web`), flag these as potential auto-resolutions.

8. **Merge meta**:
   - Union `audience` arrays
   - Combine `question` fields (current question primary, note incoming question)
   - Merge `connectors`
   - Add `merged_from` to meta tracking the source:
     ```json
     "merged_from": [{
       "path": "../auth-sprint/claims.json",
       "question": "How should we implement auth?",
       "claims_count": 15,
       "merged_at": "<ISO timestamp>",
       "slug": "auth"
     }]
     ```

9. **Write merged claims.json**: Append incoming claims (with prefixed IDs and aligned topics) to current claims.

10. **Compile and report**:
    ```bash
    node wheat-compiler.js --summary
    ```

## Git commit

Commit: `wheat: /merge <slug> — merged <N> claims from <source path>`

## Tell the user

- How many claims were merged (and how many total now)
- Topic alignment results (what was matched, what's new)
- Cross-sprint conflicts detected (need `/resolve`)
- Evidence upgrades found (auto-resolved or flagged)
- Suggest: `/resolve` for conflicts, `/blind-spot` for cross-sprint gaps

## Cleanup

```bash
rm -f /tmp/wheat-merge-*.json
```

$ARGUMENTS
