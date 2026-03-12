# Pedagogy Research: How the Wheat Visualization Teaches

> Research sprint addressing blind-spot claims r048, r049, r050 — the sprint's biggest gap.
> Claims: r060–r068

## The Problem

The Wheat sprint produced 139+ claims about architecture, UX, and build tooling, but almost nothing about how the visualization actually *teaches* Wheat to a new developer. The sprint answered "how to build the visualization" but barely touched "how the visualization teaches" (r048). There are no learning objectives (r049), and the replay shows WHAT happened but never explains WHY (r050).

## 1. Worked Examples Effect (Sweller)

**Claim: r060**

Cognitive load theory (John Sweller, 1980s) established the **worked examples effect**: studying solved examples reduces cognitive load more effectively than solving equivalent problems. Learners who study worked examples don't resort to weak problem-solving strategies like means-ends analysis, which overwhelms working memory.

**Application to Wheat:** The replay viewer IS a worked example — it shows a complete, solved research sprint rather than asking the learner to run one from scratch. This is a strength.

**The catch:** Sweller also identified the **split-attention effect** — when text and diagrams are separated, learners must mentally integrate them, increasing extraneous cognitive load. The current replay shows claim transitions visually but provides no inline text explaining what they mean. A new developer sees a status change but must independently figure out its significance. This is exactly the split-attention problem.

**Implication:** Annotations must be integrated directly into the visualization, not in a separate panel or documentation page.

Sources:
- [Worked-example effect — Wikipedia](https://en.wikipedia.org/wiki/Worked-example_effect)
- [Cognitive Load Theory — Springer](https://link.springer.com/article/10.1007/s10648-010-9145-4)
- [Andy Matuschak's notes on Worked Examples](https://notes.andymatuschak.org/Worked_example_effect)

## 2. Progressive Disclosure vs. Scaffolding

**Claim: r061**

Progressive disclosure (Nielsen Norman Group) improves learnability, efficiency, and error rate by synchronizing revealed complexity with user involvement. The key distinction:

| Approach | What it does | Wheat status |
|----------|-------------|--------------|
| **Incremental** | Shows more over time | The replay does this — claims accumulate |
| **Scaffolded** | Gates complexity by conceptual dependency | The replay does NOT do this |

The replay is incremental but not scaffolded. A scaffolded approach would ensure the learner understands claim types before seeing evidence upgrades, and understands evidence tiers before seeing conflict resolution. The current replay shows everything at once per frame with no conceptual gating.

**Implication:** Structure the replay into conceptual acts, not just chronological frames.

Sources:
- [Progressive Disclosure — NN/g](https://www.nngroup.com/articles/progressive-disclosure/)
- [Progressive Disclosure — IxDF](https://ixdf.org/literature/topics/progressive-disclosure)

## 3. Explorable Explanations (Victor, Case)

**Claim: r062**

Bret Victor coined "explorable explanations" in 2011. Nicky Case refined the approach with concrete design patterns:

1. **Start with a compelling question** — traditional teaching fails because "it answers questions the student hasn't thought to ask"
2. **Isolate mechanics** — teach individual cause-and-effect relationships before combining them
3. **Let the reader create data** — active exploration beats passive observation
4. **End with open questions** — the learner should be able to go beyond the teacher

Case's "building-up" pattern: start simple, add one mechanic at a time, combine them, then open the sandbox. This maps directly to Wheat:
- Mechanic 1: Claims (what are they, what types exist)
- Mechanic 2: Evidence tiers (how claims get verified)
- Mechanic 3: Conflicts and challenges (how contradictions surface)
- Mechanic 4: The compiler (how quality gates produce output)
- Sandbox: Create your own claim and see what happens

Sources:
- [Explorable Explanations — Bret Victor](https://worrydream.com/ExplorableExplanations/)
- [How I Make Explorable Explanations — Nicky Case](https://blog.ncase.me/how-i-make-an-explorable-explanation/)
- [4 More Design Patterns — Nicky Case](https://blog.ncase.me/explorable-explanations-4-more-design-patterns/)

## 4. Prior Art: Tools That Teach by Showing Themselves

**Claim: r063**

Three tools exemplify self-demonstrating pedagogy:

### LearnGitBranching
- 100% client-side HTML/JS app
- Visualizes git commit trees updating in real-time as users type commands
- Dual mode: sandbox (free exploration) + structured levels (isolated mechanics)
- The visualization IS the learning — no separate docs needed

### Redux DevTools
- Makes invisible state flow visible through time-travel debugging
- Action inspection, action replay, state diff
- Developers learn state management patterns by seeing and manipulating them
- The tool teaches by making the implicit explicit

### Observable Notebooks
- Prose, code, and visualization interleaved in reactive documents
- The explanation IS the running code
- Inline annotations explain what each cell does
- Readers can modify code and see results immediately

**Shared pattern:** All three make the invisible visible, let users manipulate, and annotate what's happening. The Wheat replay does the first (makes the invisible visible) but not the second or third.

Sources:
- [LearnGitBranching](https://learngitbranching.js.org/)
- [Redux DevTools — GitHub](https://github.com/reduxjs/redux-devtools)

## 5. Proposed Learning Objectives

**Claim: r064**

After watching the Wheat replay in "Learn" mode, a first-time viewer should be able to:

1. **UNDERSTAND** that a Wheat sprint converts open-ended questions into typed, evidence-graded claims
2. **IDENTIFY** the six claim types (constraint, factual, estimate, risk, recommendation, feedback) and when each is used
3. **EXPLAIN** how evidence tiers work (stated → web → documented → tested → production) and why upgrading matters
4. **RECOGNIZE** the conflict-resolution pattern: when claims contradict, challenges force resolution
5. **DESCRIBE** how the compiler enforces quality gates before producing output artifacts

These follow Bloom's taxonomy (lower-order to higher-order cognitive skills) and are measurable via a self-check quiz at the end of the replay.

## 6. Recommendations

### Contextual Annotations (r065)
Add tooltips that trigger on key replay frames:
- First claim appears → "This is a [type] claim — it records a [description]"
- Evidence upgrades → "Upgraded from [old] to [new] because [artifact] verified it"
- Conflict created → "These claims contradict — /challenge surfaces tensions"

### Three-Act Scaffolding (r066)
Structure the replay as:
- **Act 1 (Explore):** Introduce claims and types, annotate each new type
- **Act 2 (Complicate):** Introduce evidence upgrades, conflicts, challenges
- **Act 3 (Resolve):** Show compiler gates and output, summarize what was learned

### Dual Mode (r067)
- **Learn mode:** Annotations on, gating enabled, slower autoplay
- **Review mode:** Annotations off, free scrubbing, full speed

### Sandbox Mode (r068)
Let learners create a mock claim, set its type and evidence tier, and see how the dashboard and compiler would handle it. Client-side only — no backend needed.

## Risk

Adding pedagogical features risks making the replay feel like a tutorial rather than a tool. Without dual-mode (r067), annotations will annoy experts or be invisible to novices. The prior art unanimously solves this with learn/sandbox separation.
