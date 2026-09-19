# TwinBank Frontend Specification

Status: Draft

Current decision: the official presentation requires a Nessie-backed Financial Twin. The root
specification still describes fixtures as the intended default in places and must be reconciled
with this decision before this draft becomes final.

This document defines TwinBank's frontend information architecture, page responsibilities,
visual system, responsive behavior, interaction states, accessibility requirements, and demo
experience.

The root [`SPEC.md`](../SPEC.md) remains authoritative for product behavior, financial rules,
simulation behavior, implementation phases, and team ownership. Backend Pydantic models in
`backend/src/backend/schemas.py` remain authoritative for shared contracts; TypeScript contracts
in `lib/types.ts` must mirror them.

When this document conflicts with the root specification or shared contracts, the root
specification and shared contracts win until the team explicitly updates them.

---

## 1. Frontend Goals

The TwinBank frontend should make a financial future understandable without feeling like a
traditional budgeting dashboard.

The experience should feel:

- calm,
- trustworthy,
- focused,
- easy to scan,
- explicit about assumptions and data provenance,
- useful without requiring financial or technical expertise.

The frontend should help the user answer four questions:

1. What does my financial position look like now?
2. What goals and obligations am I planning around?
3. What changes if I make a purchase?
4. Why did the projected future change?

The frontend must not:

- place the entire product in one long page,
- infer or present a personal goal that the user did not declare,
- imply that fixture data came from a live bank,
- imply that rules- or template-generated text came from an AI model,
- hide important financial tradeoffs behind a single affordability verdict,
- depend on a model provider for the official demo; Nessie is the required banking source for that
  demo.

---

## 2. Information Architecture

TwinBank uses a shared application shell and multiple focused pages. Each page has one primary
job. The user should not have to scroll through unrelated features to reach the task they want.

Primary destinations:

| Destination | Route | Primary purpose |
| --- | --- | --- |
| Overview | `/` | Understand accounts, financial intent, goals, obligations, and general status |
| Plans & Assistant | `/plans` | Manage goals, constraints, recurring-obligation questions, and one-time obligations with conversational help |
| Purchase Simulator | `/simulate` | Enter a purchase and compare baseline with counterfactual outcomes |
| Balance Trajectory | `/trajectory` | Inspect the latest projection, uncertainty bands, markers, and assumptions |
| Forecast & Data | `/insights` | Understand how Nessie data became the twin, forecast, and simulation inputs |

The route names may change during implementation if Next.js conventions require it, but the page
responsibilities must remain separated.

### 2.1 Navigation

The primary menu control is in the top-left corner on every page.

On larger screens, the menu may open a compact sidebar or remain expanded when space permits. On
small screens, it opens a drawer. The navigation must:

- identify the current page,
- be keyboard-operable,
- close predictably after navigation on mobile,
- never cover required page actions after it closes,
- include text labels rather than icon-only destinations,
- preserve the user's current twin and latest simulation while changing pages.

The top-level destinations are ordered as follows:

1. Overview
2. Plans & Assistant
3. Purchase Simulator
4. Balance Trajectory
5. Forecast & Data

### 2.2 Shared application shell

Every page uses the same shell. It contains:

- the top-left menu control,
- TwinBank product identity,
- the current page title,
- a compact TwinBank Assistant entry point near the top,
- the demo user's identity,
- backend connectivity status,
- Financial Twin data provenance.

The shell must not consume so much vertical space that the page's primary content falls below the
first viewport on a typical laptop.

---

## 3. Page Specifications

### 3.1 Overview

The Overview is the landing page. It introduces the Financial Twin and shows its major
relationships without exposing every editor and simulation control.

The Overview contains:

- a short statement explaining what TwinBank does,
- a dashboard of all accounts and current balances,
- total balance,
- the Financial Intent Graph,
- a concise active-goals summary,
- a concise upcoming-obligations summary,
- the current data source,
- a visible entry point to the TwinBank Assistant,
- calls to action for adding a goal and simulating a purchase.

The Overview does not contain:

- the full goal compiler and review form,
- the full purchase form,
- optimization results,
- the full balance trajectory chart,
- detailed simulation assumptions,
- the full obligation editor.

For the Alex demo dataset, the Overview should communicate the main story within approximately two
desktop viewport heights. Additional detail belongs on the focused pages.

#### Account dashboard

The account dashboard shows every account in a simple panel or card layout. Each account shows:

- account name,
- account type,
- current balance.

The dashboard also shows total balance. It must not suggest that all balances are freely
spendable: declared reserves and goals are shown nearby as commitments against that money.

Account identifiers intended for APIs or debugging are not shown as primary UI labels.

#### General statements

General statements are brief, deterministic summaries of structured data. Examples include:

- the number of active goals,
- the next known obligation,
- the current emergency reserve,
- whether the displayed twin uses fixture or Nessie data.

They must not invent advice, risk, or intent. A statement that depends on a simulation should not
appear until a simulation exists.

### 3.2 Plans & Assistant

This page combines goals, financial constraints, obligations, and the full TwinBank Assistant
experience. These concepts share one page because each depends on the user declaring or clarifying
intent that banking history alone cannot establish.

The page contains:

- the user's existing goals,
- the emergency reserve,
- the minimum checking constraint,
- detected recurring obligations,
- unanswered obligation-classification questions,
- user-declared one-time obligations,
- natural-language goal entry,
- natural-language obligation entry,
- clarification questions,
- compiled goal or obligation drafts,
- correction controls,
- explicit confirmation before saving,
- goal and one-time-obligation editing or removal,
- Assistant conversation for the current browser session.

The Assistant first determines whether the user is describing a goal, a constraint, a one-time
obligation, or an answer about a detected recurring obligation. If the intent is ambiguous, it asks
the user rather than choosing silently.

Every declaration uses a review-first workflow:

1. The user describes a goal, constraint, or obligation in their own words, or answers a question
   about a detected obligation.
2. TwinBank identifies the declaration type and compiles a structured draft.
3. TwinBank asks about missing or ambiguous required fields.
4. The user reviews and may correct the draft.
5. The user explicitly confirms the proposed change and the resulting declared set.
6. TwinBank saves the confirmed goals, constraints, classifications, or one-time obligations.

No goal, constraint, classification, or one-time obligation reaches the Financial Twin before the
required confirmation.

The interface must clearly distinguish:

- a saved goal or obligation,
- a draft goal or obligation,
- an unanswered clarification,
- an invalid correction,
- an in-progress save,
- a failed save.

The page should use separate summary panels for current goals and current obligations around one
shared conversation. Combining the workflows must not turn them into one undifferentiated list.

#### Recurring obligations

Detected recurring obligations show:

- name,
- expected amount,
- due day,
- confidence where useful,
- whether TwinBank needs the user to clarify the category,
- observed provenance.

The user may answer classification questions conversationally. The Assistant reads the proposed
classification back before saving it and must not silently turn a suggestion into a declared fact.

#### One-time obligations

A one-time obligation is a known future expense that is not recurring or was not detected from
banking history. Examples include tuition, a medical bill, an annual insurance payment, a security
deposit, or a scheduled repair.

The user can add, edit, or remove a declared one-time obligation through the Assistant. Its review
draft collects:

- name,
- amount,
- due date,
- funding account,
- whether the obligation is mandatory.

One-time obligations always have declared provenance. A confirmed one-time obligation belongs to
the baseline future because it is a known commitment, not a hypothetical purchase. It must
eventually appear in plan summaries, simulation, explanations, the Financial Intent Graph, and the
Balance Trajectory.

This feature requires an agreed shared backend contract, intent-routing or compilation behavior,
and simulation support before frontend implementation. The frontend must not invent a local-only
obligation contract or pretend the existing goal compiler supports obligations.

### 3.3 Purchase Simulator

The Purchase Simulator is the focused workspace for a counterfactual purchase.

It contains:

- purchase description,
- purchase amount,
- purchase date,
- funding account,
- the Simulate action,
- baseline-versus-counterfactual summary metrics,
- a short result summary,
- the most important explanation drivers,
- ranked alternative actions after a successful simulation,
- a link to the detailed Balance Trajectory.

It should help answer:

- How does the purchase change the projected ending balance?
- How does it change low-balance and reserve risk?
- Does it affect the active goal?
- Can upcoming mandatory obligations still be covered?
- What lower-impact alternatives are available?

The simulator must not reduce these results to a single "can afford" or "cannot afford" verdict.

Detailed time-series charts and full assumptions belong on the Balance Trajectory page. A compact
preview may be shown when it materially helps the user understand the result.

### 3.4 Balance Trajectory

The Balance Trajectory page shows the detailed projection from the latest successful simulation.

It contains:

- baseline and counterfactual balance bands,
- total-balance and checking-balance views,
- p10, median, and p90 values,
- purchase markers,
- goal-deadline markers,
- emergency-reserve and minimum-checking reference lines when applicable,
- simulation horizon,
- number of Monte Carlo paths,
- simulation assumptions,
- a concise explanation of uncertainty,
- a link back to change the purchase scenario.

When no simulation exists, the page shows an empty state that explains what belongs here and links
to the Purchase Simulator.

The chart must remain usable when:

- the horizon is short or long,
- reference lines fall outside the visible band,
- multiple markers share or nearly share a date,
- labels are longer than the default fixture's labels,
- balance values are negative,
- balance values have five or more digits.

### 3.5 Forecast & Data

The Forecast & Data page explains how TwinBank turned banking activity into the structured inputs
used by the simulator. It is both a trust surface for the user and a useful demonstration of the
Nessie, forecasting, Databricks, and MLflow workflow.

The page should answer:

- Where did this Financial Twin's observed data come from?
- When was the source last read?
- What observation window was used?
- Which income streams and recurring obligations were detected?
- How was variable spending estimated?
- Does spending change by season or remain flat?
- Was processing performed locally or in Databricks?
- Which tracked pipeline or model run produced the active forecast?

The initial version may use the forecast metadata already present on the Financial Twin. Later
versions should show Databricks and MLflow lineage when those integrations are implemented.

The page may contain these panels:

1. **Data source** — Nessie connection state, last successful read, account count, transaction
   window, and current as-of date.
2. **Detected structure** — income cadence, recurring obligations, ambiguous classifications, and
   variable-spending categories.
3. **Forecast** — method, observation window, recency weighting, seasonal factors, and a plain-
   language description of what those factors mean.
4. **Processing lineage** — local or Databricks execution, pipeline status, published dataset or
   model version, and MLflow run metadata when available.
5. **Limitations** — assumptions, unavailable metadata, and categories for which TwinBank found no
   reliable seasonal pattern.

Technical identifiers should be secondary details, not the main user story. Secrets, tokens,
private connection values, and raw environment configuration must never be rendered.

If Databricks or MLflow is not enabled, the page states that processing used the local pipeline. It
must not show a decorative "Databricks" or "MLflow" badge that implies an integration ran when it
did not.

Future refresh or rebuild controls may be added only after the backend exposes an authenticated,
well-defined operation. Until then, this page is read-only and must not simulate a refresh in local
frontend state.

---

## 4. TwinBank Assistant

A compact Assistant entry point appears near the top of the application shell. The complete
conversation experience lives on Plans & Assistant.

The Assistant may:

- help draft or revise a goal,
- help draft or revise a one-time obligation,
- help classify a detected recurring obligation,
- ask for a missing amount, deadline, or name,
- read back a structured goal, constraint, classification, or obligation draft,
- explain structured simulation results,
- direct the user to the relevant page,
- help the user understand the distinction between an observed and declared fact.

The Assistant must not:

- invent a financial fact or personal goal,
- infer a specific goal from transactions,
- calculate balances or risk values,
- enforce financial constraints through generated text,
- change a goal, constraint, classification, or obligation without explicit review and
  confirmation,
- represent rules- or template-generated output as model-generated output.

The official demo uses the rule-based goal compiler and template-based explanations by default, so
it requires no model credential even though it requires Nessie. The interface identifies whether
relevant output was produced by:

- rules,
- deterministic templates,
- the optional configured model.

The Assistant is not a generic financial-advice chatbot. Its scope is the user's TwinBank data,
goals, obligations, scenarios, and navigation within the product.

---

## 5. Financial Intent Graph

The Financial Intent Graph is the primary explanatory visualization on the Overview. Its purpose
is to show how accounts and expected cash flow relate to obligations, constraints, and goals.

It must be understandable without requiring the user to know graph terminology.

### 5.1 Structure

Use a stable directional structure:

```text
Accounts → Income and spending → Obligations and constraints → Goals
```

The exact number of columns may adapt to available width, but the direction and grouping should
remain predictable.

The graph shows:

- account nodes with name, type, and balance,
- income nodes with amount and cadence,
- spending nodes with category and expected range or average,
- obligation nodes with amount and due timing,
- constraint nodes with the protected amount,
- goal nodes with target, progress, and deadline.

### 5.2 Comprehension requirements

The graph must include:

- a visible plain-language legend,
- labels that distinguish observed information from declared information,
- short edge labels when the relationship would otherwise be ambiguous,
- concise tooltips or detail panels for secondary information,
- Fit view and Reset controls,
- an introductory sentence stating what the graph represents.

Observed and declared information may use different border treatments, labels, or line styles.
The distinction must not depend on color alone.

When simulation information is added, it should enhance existing nodes or open a detail panel. It
should not unexpectedly rearrange the graph.

### 5.3 Layout and interaction requirements

- Default node positions remain stable for the same twin.
- Nodes and labels must not overlap at supported desktop widths.
- Edges should not cross through unrelated node labels.
- Graph controls must not cover nodes or the legend.
- Normal page scrolling must not be trapped by the graph canvas.
- Keyboard users must be able to reach meaningful graph items.
- Selecting a node must produce a visible and described state.
- Zoom is helpful but must not be required to read the primary story.

On narrow screens, the graph may switch to a simplified vertical flow or a structured list. A
non-canvas representation must be available for accessibility and for screens where the complete
graph would be unreadable.

---

## 6. Visual System

The visual design uses a Capital One-inspired palette with exactly three color families:

1. blue,
2. red,
3. white.

Blue is the primary structural color. It is used for navigation, page headings, primary actions,
links, selected states, and the strongest financial-data emphasis. Darker blue shades may be used
for the application shell and text; lighter blue shades may be used for borders, chart fills, and
subtle panel backgrounds.

White is the primary content surface and contrast color. It is used for page backgrounds, cards,
space between panels, and text or icons placed on sufficiently dark blue or red backgrounds.

Red is an accent, not the dominant page color. It is used sparingly for important calls to
attention, counterfactual emphasis, destructive actions, warnings, and errors. Large red surfaces
should be avoided unless white foreground content meets contrast requirements.

Shades and opacity variations within blue, red, and white are permitted. Gray-looking secondary
text and borders should be produced from blue or white with controlled opacity rather than by
introducing a separate gray color family.

The interface should use spacing, typography, border weight, line style, icons, and labels before
adding stronger color emphasis. No additional decorative color family should be introduced.

Suggested semantic roles:

| Role | Color treatment |
| --- | --- |
| Application shell and navigation | Dark blue with white text |
| Primary action | Blue with white text |
| Content surface | White with dark blue text |
| Selected or focused item | Blue border, underline, or pale blue fill |
| Baseline projection | Solid blue line with a direct label |
| Counterfactual projection | Dashed red line with a direct label |
| Declared information | Red accent plus a visible `Declared` label |
| Observed information | Blue treatment plus a visible `Observed` label |
| Warning, error, or destructive action | Red icon or border with explanatory text |
| Disabled or secondary content | Blue or white at reduced emphasis while preserving contrast |

Baseline and counterfactual projections must not rely on color alone. They also use distinct line
styles, direct labels, markers, or fill patterns. Observed and declared information likewise uses
text labels and structural differences in addition to blue and red.

All color combinations must meet the applicable WCAG contrast requirements. Color opacity must
not be reduced so far that text, focus indicators, chart lines, or interactive boundaries become
difficult to perceive.

### 6.1 Typography

- Use a small, consistent type scale.
- Page titles, panel titles, labels, values, and help text must have visibly different roles.
- Financial values use tabular numerals where alignment matters.
- Avoid long all-caps labels.
- Avoid presenting large paragraphs inside dashboard panels.

### 6.2 Panels

Pages use a small number of clearly separated panels. Each panel has:

- one primary purpose,
- a short title,
- consistent padding,
- a predictable action area,
- appropriate loading, empty, and error states.

Desktop pages may use two or three columns when every panel remains readable. Mobile pages collapse
to one column.

Avoid nested cards unless the inner element is an independently interactive item with a clear
purpose.

### 6.3 Controls

- One primary action per panel receives the strongest emphasis.
- Secondary actions should not visually compete with the primary action.
- Destructive actions, such as removing a goal or obligation, require an explicit label and an
  appropriate confirmation pattern.
- Loading labels must not resize buttons enough to collide with nearby controls.
- Disabled controls must remain legible and explain their dependency when it is not obvious.

---

## 7. Responsive Layout and Collision Prevention

The interface must be reviewed at these viewport widths:

- 320 px,
- 375 px,
- 768 px,
- 1024 px,
- 1440 px.

At every supported width:

- text, controls, badges, panels, nodes, and legends do not overlap,
- no panel escapes the viewport,
- the document has no unintended horizontal scrolling,
- buttons remain readable and tappable,
- long names wrap or truncate predictably,
- chart legends do not cover plotted data,
- graph controls do not cover nodes or legends,
- drawers, dialogs, and menus remain fully reachable,
- focused controls remain visible,
- error text expands the layout instead of covering adjacent content,
- empty and loading states reserve sensible space without causing large layout shifts.

Charts and graphs may scroll inside a clearly bounded panel when a meaningful minimum width is
required. The overall document must not horizontally scroll.

### 7.1 Collision regression checks

Any change to the shell, navigation, graph, chart, badges, or form actions should be checked with:

- the default Alex fixture,
- long account, goal, obligation, and purchase names,
- multiple goals,
- multiple clarification questions,
- a backend error,
- an offline fallback notice,
- the maximum expected number of navigation badges or status labels.

A layout is not complete if it works only with the shortest fixture strings.

---

## 8. Data and Simulation Provenance

The UI presents backend connectivity and financial-data origin as separate facts.

Required combinations include:

| Backend state | Twin source | Presentation |
| --- | --- | --- |
| Connected | Nessie | Backend connected · Nessie data |
| Connected | Fixture | Backend connected · Demo fixture |
| Offline fallback | Bundled fixture | Backend offline · Bundled example |
| Connected | Unknown or absent | Backend connected · Data source unavailable |

Fixture-derived information must never be described as live bank data.

Simulation provenance is separate from twin provenance. A simulation may be:

- computed by the connected backend,
- a saved example shown because the backend is unavailable.

When a saved simulation example is shown, the UI must state that the user's current purchase and
answers were not applied.

---

## 9. State and Navigation Behavior

The frontend should preserve the current Financial Twin and latest simulation when navigating
between pages during the session.

Required behavior:

- A successful twin update invalidates any simulation based on the previous twin.
- A new simulation replaces the previous simulation and its optimization results.
- Optimization results belong to the simulation that produced them.
- An older asynchronous response must not overwrite newer state.
- Goals and obligations remain drafts until explicitly confirmed.
- A failed save keeps recoverable user input on screen.
- A page that depends on missing state shows a useful empty state and a link to the prerequisite
  page.

Examples:

- Balance Trajectory without a simulation links to Purchase Simulator.
- Plans & Assistant without a backend explains which compilation and saving operations require the
  backend.
- Plans & Assistant distinguishes no goals or obligations from a loading or API failure.

The implementation may initially keep this state in a shared client provider. It does not need a
new global state dependency unless the existing React and Next.js primitives become insufficient.

---

## 10. Loading, Empty, Error, and Offline States

Every data-dependent page defines four states:

1. loading,
2. loaded,
3. empty where applicable,
4. error.

Offline fallback is not presented as an error if the bundled demo can continue, but its limitations
must be visible.

Error messages should:

- identify the action that failed,
- appear near the initiating control when practical,
- preserve the user's input,
- avoid replacing a rejected request with unrelated fixture results,
- offer a useful next action when one exists.

Loading states should not block unrelated navigation. Only the control or panel performing the
operation should show its active waiting state unless the whole page truly depends on the result.

---

## 11. Accessibility

The frontend must provide:

- keyboard-operable menus, forms, graph items, and chart controls,
- visible focus indicators,
- explicit labels for form fields,
- logical heading hierarchy,
- sufficient text and control contrast,
- status text that does not rely on color alone,
- appropriately announced asynchronous results where practical,
- reduced-motion behavior for animated transitions,
- a non-canvas representation of important graph information,
- accessible names for icon buttons,
- touch targets suitable for mobile use.

Financial charts must include a textual summary of the conclusion they are intended to support.
The user must not be required to distinguish two similar colors to understand baseline versus
counterfactual results.

---

## 12. Required Demo Walkthrough

The official demo requires a connected backend and a Financial Twin built from Capital One Nessie.
Fixture mode remains available for local frontend development, automated tests, and failure
recovery, but a fixture-backed session does not count as a complete official demo.

Before presenting, the presenter must:

1. configure their own Nessie credentials without exposing them to the browser or repository,
2. seed or otherwise confirm the Alex demo data in the Nessie sandbox,
3. run the repository's Nessie readback check,
4. start the backend with Nessie enabled,
5. confirm that the frontend reports `Backend connected · Nessie data`.

The presenter should then be able to:

1. Open Overview and introduce TwinBank's purpose.
2. Show Alex's accounts and total balance.
3. Explain the Financial Intent Graph and the difference between observed and declared data.
4. Point out that the Financial Twin was built from Nessie data.
5. Open Plans & Assistant and review or add a declared goal.
6. Show that incomplete input produces a clarification instead of an invented fact.
7. In the same conversation, review a detected recurring obligation and answer its classification
   question.
8. Add a declared one-time obligation once its shared compiler and contract are implemented.
9. Open Purchase Simulator and enter the $800 laptop purchase.
10. Compare baseline and counterfactual results.
11. Review explanation drivers and alternative actions.
12. Open Balance Trajectory and explain the uncertainty bands, purchase marker, goal deadline, and
    reserve line.
13. Open Forecast & Data and show that the twin came from Nessie, how the forecast was produced,
    and, once Phase 6 is implemented, the Databricks and MLflow lineage behind it.

If Nessie becomes unavailable, TwinBank may fall back to fixtures so the application remains
inspectable. The UI must label that state truthfully, and the presenter must not describe it as the
official live-data demo. The walkthrough should include a pre-demo verification checklist and a
clearly marked recovery appendix rather than treating fallback mode as an equivalent path.

---

## 13. Page-Level Acceptance Criteria

### Overview is complete when

- all accounts and total balance are visible,
- the Intent Graph has a legend and plain-language introduction,
- goals and obligations are summarized without embedding their full editors,
- connectivity and data origin are both truthful,
- the default layout has no collisions at supported widths,
- primary tasks are reachable through obvious navigation or calls to action.

### Plans & Assistant is complete when

- the user can compile, clarify, correct, confirm, and remove goals and one-time obligations,
- the user can answer detected-obligation classification questions in the same conversation,
- the Assistant distinguishes goal, constraint, classification, and obligation intent or asks when
  it is ambiguous,
- unchanged declarations are not accidentally discarded,
- nothing is saved without review,
- rule-, template-, and model-produced output are labelled honestly,
- failures preserve recoverable input,
- goals and obligations remain visibly distinct despite sharing one Assistant,
- the layout remains usable with multiple goals, obligations, and clarification questions.

### Purchase Simulator is complete when

- the user can enter and submit the laptop scenario,
- rejected simulations show the backend error rather than fixture numbers,
- baseline and counterfactual metrics are clearly paired,
- alternatives remain associated with the current simulation,
- a detailed-trajectory link is visible after success.

### Balance Trajectory is complete when

- the latest simulation appears after navigation,
- baseline and counterfactual are distinguishable without color alone,
- markers and reference lines do not collide with legends or controls,
- assumptions and uncertainty are explained in text,
- the no-simulation state links back to the simulator.

### Forecast & Data is complete when

- the Nessie source, as-of date, and observation window are visible,
- detected structure is described without presenting uncertain classifications as facts,
- forecast method, recency weighting, and seasonality are explained in plain language,
- missing metadata produces an honest unavailable state,
- local and Databricks processing are labelled accurately,
- MLflow lineage appears only when supplied by the backend,
- no secret or private connection information can reach the browser.

---

## 14. Implementation Sequence

The multi-page redesign should be delivered in small increments while preserving a functioning
end-to-end demo.

### Increment 1: Application shell and routes

- Add the shared shell and top-left menu.
- Create each destination with useful temporary empty states.
- Preserve the current single-page experience until its features have been moved.

### Increment 2: Overview and provenance

- Move account summaries and the Intent Graph to Overview.
- Add goal and obligation summaries.
- distinguish backend connectivity from fixture/Nessie data origin.

### Increment 3: Plans & Assistant

- Move the existing goal and recurring-obligation clarification workflows without changing their
  behavior.
- Add one Assistant conversation layout with visibly separate goal and obligation summaries.
- Add intent-routing UI states without pretending the current goal compiler handles obligations.

### Increment 4: Purchase Simulator

- Move purchase input, scenario metrics, explanation drivers, and alternatives.
- Add navigation to the detailed trajectory.

### Increment 5: Balance Trajectory

- Move the full chart and assumptions.
- Add a useful empty state and preserve the latest simulation across routes.

### Increment 6: One-time obligations in Plans & Assistant

- Add conversational drafting and review only after the shared obligation contract and compilation
  behavior are agreed and available.
- Include confirmed one-time obligations in plan summaries and every relevant simulation surface.

### Increment 7: Intent Graph redesign

- Apply the stable directional layout.
- Add legend, explanations, accessible fallback, and collision handling.

### Increment 8: Responsive and demo polish

- Test supported widths and long-content cases.
- Fix collisions and unintended scrolling.
- Complete accessibility review.
- Write and rehearse the Nessie-required walkthrough and its pre-demo verification checklist.

### Increment 9: Forecast presentation

- Add Forecast & Data using the Financial Twin's forecast metadata.
- Visualize seasonal spending without implying certainty the forecast does not contain.
- Connect forecast assumptions to the simulator and trajectory explanations.

### Increment 10: Databricks and MLflow integration surface

- Add processing-location and pipeline-status presentation after backend contracts exist.
- Show dataset, forecast, or model lineage supplied by Databricks and MLflow.
- Add loading, stale-run, failed-run, and local-fallback states.
- Verify that the browser receives identifiers and metadata only, never credentials.

### Increment 11: Model-assisted experience

- Preserve rules and templates as the reliable default and fallback.
- If the team enables model-generated goal drafting or explanation wording, label it accurately.
- Keep computed numbers and hard-constraint decisions outside generated text.
- Test timeout, refusal, malformed-output, and fallback states without real model calls.

### Increment 12: Approved stretch features

- Add frontend entry points for ANS or another stretch feature only after the root specification
  defines its behavior and the core product is stable.
- Keep stretch features separated from the primary demo path until they meet the same provenance,
  accessibility, error-state, and testing standards as the core experience.

Each increment must keep fixture fallback usable for development and recovery while preserving the
Nessie-backed official demo. Existing behavior should be moved before it is removed from the old
page.

---

## 15. Full Product Roadmap Coverage

The frontend specification covers both implemented behavior and planned capabilities from the root
product specification. A planned capability must have a visible status or honest absence; it must
not be represented as working before its backend path exists.

| Root capability | Current maturity | Frontend responsibility | Current or planned surface |
| --- | --- | --- | --- |
| Capital One Nessie integration | Backend path exists; complete official-demo verification and frontend source presentation remain | Show source, connectivity, freshness, and failure fallback truthfully | Application shell, Overview, Forecast & Data |
| Transaction normalization | Implemented in backend | Summarize the normalized categories and observation window without exposing provider-specific payloads | Forecast & Data |
| Financial Twin | Implemented; multi-page presentation planned | Present accounts, income, obligations, spending, goals, constraints, provenance, and metadata | Overview and focused pages |
| Recurring-structure detection | Implemented in backend; combined planning page planned | Show detected income and obligations, confidence where useful, and conversational clarification requests | Plans & Assistant, Forecast & Data |
| User-declared goals and constraints | Implemented in current single-page UI; relocation and Assistant layout planned | Provide draft, clarification, correction, confirmation, editing, and removal | Plans & Assistant |
| Financial forecasting | Backend implementation exists; expanded presentation planned | Explain baseline estimates, recency weighting, seasonal profiles, and forecast limitations | Forecast & Data, Balance Trajectory |
| Deterministic simulation | Implemented | Present the structured expected-value result where used, without calling it AI-generated | Purchase Simulator and explanations |
| Monte Carlo simulation | Implemented, including fan chart | Present probability metrics, uncertainty bands, simulation count, and assumptions | Purchase Simulator, Balance Trajectory |
| Counterfactual purchases | Implemented in current single-page UI; relocation planned | Keep the hypothetical purchase distinct from known baseline obligations | Purchase Simulator |
| Explanation | Template-based implementation exists; page integration will expand | Translate computed results into concise drivers and assumptions without changing the numbers | Purchase Simulator, Balance Trajectory, Assistant |
| Optimization | Implemented in current single-page UI; relocation planned | Present ranked alternatives, tradeoffs, violations, and the recommended feasible option | Purchase Simulator |
| Databricks processing | Planned; not implemented | Show whether the active twin or forecast came through the Databricks workflow, including honest pending and failure states | Forecast & Data |
| MLflow tracking | Planned; not implemented | Show backend-supplied run, version, timing, and relevant evaluation metadata | Forecast & Data |
| Optional model goal compiler | Implemented behind a flag; rules remain the default | Label model versus rules, require review, and preserve rule fallback | Plans & Assistant |
| Optional model-written explanations | Not enabled; templates are the decided behavior | Rephrase structured outputs only if the team changes the root decision, and identify their origin | Assistant and explanation panels |
| One-time declared obligations | Newly specified; shared backend, intent-routing, compilation, and simulation support required | Collect, review, save, display, and include them in the baseline after shared support exists | Plans & Assistant and all simulation surfaces |
| ANS or other stretch work | Undefined and deferred | Add only after its behavior is defined and the core experience is stable | Future, route unspecified |

### 15.1 Capability maturity labels

During implementation and demos, a capability may be described as:

- **Available** — the complete frontend-to-backend path is implemented and verified,
- **Fallback active** — a real integration failed or is disabled and the labelled fallback is in
  use,
- **Planned** — specified but not implemented,
- **Unavailable** — expected metadata or a required service is not currently accessible.

"Planned" features must not use active-looking controls. "Available" must not be inferred merely
because a card or badge exists.

### 15.2 Databricks workflow presentation

The target data path is:

```text
Capital One Nessie
→ raw banking events
→ Databricks processing
→ normalized financial data
→ detected recurring structure and forecasts
→ Financial Twin
→ simulation and optimization
→ FastAPI
→ Next.js frontend
```

The frontend should present this as a small understandable lineage flow, not as an infrastructure
diagram dominating the product. Each stage may show a status and timestamp when the backend makes
that information available.

The interface should support these future states:

- Databricks completed and published the active output,
- Databricks is processing a newer run while the last successful twin remains active,
- the latest run failed and the last successful twin remains active,
- the local processing fallback produced the active twin,
- processing lineage is unavailable from an older backend.

A failed or in-progress pipeline must not blank the current Financial Twin if a last successful
version exists. The UI should distinguish data freshness from service availability.

### 15.3 MLflow presentation

MLflow metadata is evidence of how a forecast or processing run was tracked; it is not itself a
financial recommendation. When supplied by the backend, the frontend may show:

- run or model display name,
- version,
- start and completion time,
- training or observation window,
- forecast method,
- evaluation metrics selected by the data workstream,
- whether the run is the currently published version.

Raw artifact paths, internal hostnames, credentials, and unrestricted external links must not be
exposed. Metric names require plain-language descriptions before being shown to a general user.

### 15.4 Future-contract discipline

Future UI must be driven by shared contracts rather than guessed frontend objects. Databricks,
MLflow, one-time obligations, pipeline status, and new forecast details may require additive fields
or endpoints. Before implementation:

1. identify which workstream owns the source data,
2. agree on the backend schema and unavailable-state behavior,
3. mirror the schema in TypeScript,
4. implement fixture or fake coverage without pretending the integration ran,
5. add the UI and its tests,
6. verify the real path required by the official demo.

---

## 16. Open Frontend Decisions

These decisions require team agreement before the draft becomes final:

| Question | Proposed default |
| --- | --- |
| May the frontend introduce a fourth color family? | No by default; use blue, red, white, their shades, opacity, line styles, labels, and icons |
| Is the desktop menu persistent or opened on demand? | A compact sidebar may remain visible at wide widths; the top-left control remains available |
| Where does shared route state live? | A small React provider using existing dependencies |
| Does the Assistant persist conversations across restarts? | No for MVP; only confirmed goals and constraints persist |
| Is the Assistant a generic financial-advice chatbot? | No; it is scoped to TwinBank goals, obligations, scenarios, explanations, and navigation |
| Is a one-time obligation part of the baseline? | Yes, after explicit confirmation |
| Can one-time obligations ship frontend-only? | No; they require an agreed shared contract and simulation support |
| How should a mid-demo Nessie outage be handled? | Show the honestly labelled fixture fallback, explain that live data is unavailable, and do not present it as the complete official demo |
