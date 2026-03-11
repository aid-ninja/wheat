# /brief — Compile the decision document

You are compiling the final decision brief for this Wheat sprint. This is the Bran compilation step — deterministic output from resolved claims.

## Process

1. **Run the compiler with check**:
   ```bash
   node wheat-compiler.js --check
   ```

   **If the compiler returns an error (exit code 1), STOP.** Do not generate a brief. Instead:
   - Show the user the compilation errors
   - Explain what needs to be resolved
   - Suggest specific commands to fix each blocker
   - Do NOT proceed until compilation passes

2. **Read compilation.json** — use ONLY `resolved_claims` as your source material. Never read claims.json directly for the brief.

3. **Generate the brief as markdown**: Create `output/brief.md` with this structure:

   ```markdown
   ---
   pdf_options:
     format: A4
     margin: 25mm 20mm
   css: |-
     body { font-family: system-ui, sans-serif; font-size: 11pt; line-height: 1.6; color: #111; max-width: 100%; }
     h1 { font-size: 20pt; margin-bottom: 4pt; }
     h2 { font-size: 14pt; margin-top: 16pt; margin-bottom: 6pt; border-bottom: 1px solid #ddd; padding-bottom: 4pt; }
     table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 10pt; }
     th, td { border: 1px solid #ccc; padding: 4pt 8pt; text-align: left; }
     th { background: #f5f5f5; }
     .citation { font-size: 9pt; color: #666; }
     .certificate { margin-top: 24pt; padding: 12pt; background: #f9f9f9; border-radius: 4pt; font-size: 9pt; }
   ---

   # Decision Brief: [Sprint Question]

   **Date**: [date]  |  **Audience**: [audience]  |  **Phase**: Compiled

   ## Executive Summary
   [2-3 sentences: the recommendation and why]

   ## Recommendation
   [The recommended course of action, with specific next steps]

   ## Evidence Summary
   [For each topic: key findings, evidence tier, source]
   [Every statement must cite a claim ID]

   ## Tradeoffs and Risks
   [Risks identified, with evidence tier for each]

   ## Resolved Conflicts
   [What disagreed, how it was resolved, what evidence won]

   ## Appendix: Claim Inventory
   [Table of all resolved claims: ID, type, content, evidence, source]

   ---
   <div class="certificate">
   Compilation certificate: [hash] | Compiler: wheat v[version] | Claims: [count] | Compiled: [timestamp]
   </div>
   ```

4. **Generate PDF**:
   ```bash
   node build-pdf.js output/brief.md
   ```

5. **Also generate brief as HTML**: Create `output/brief.html` — a clean, print-friendly HTML version for browser viewing.

## Key rules

- **Every statement in the brief must trace to a claim ID**. No uncited assertions.
- **Use only resolved_claims from compilation.json**. Superseded claims are excluded.
- **Include the compilation certificate** — this is the Bran determinism invariant. Same claims = same brief.
- **The brief is deterministic**: given the same compilation.json, the structure and content should be reproducible.

## Git commit

Stage all output files.

Commit: `wheat: /brief compiled — [total] claims, [conflicts resolved] conflicts resolved, certificate [hash]`

## Tell the user

- The brief is ready at `output/brief.pdf` and `output/brief.html`
- Show the compilation certificate
- Remind them they can share these with stakeholders
- Mention `/present` if they need a presentation version
- Mention `/feedback` for incorporating stakeholder responses

$ARGUMENTS
