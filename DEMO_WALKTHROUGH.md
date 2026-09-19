# TwinBank Demo Walkthrough

This is the short, repeatable path for presenting TwinBank's core story:

> Alex → Financial Twin → $800 laptop → Simulate → baseline versus
> counterfactual → explanation

It uses the bundled Alex fixture and the rule-based application only. No external
service or credential is required.

## Start from a clean demo state

From the repository root, start the backend in one terminal:

```bash
cd backend
uv sync
TWIN_ANSWERS_PATH= SIMULATION_SEED=1 uv run uvicorn backend.main:app --reload --port 8000
```

`TWIN_ANSWERS_PATH=` keeps earlier saved answers out of this run, and
`SIMULATION_SEED=1` makes the Monte Carlo result repeatable. Fixture data is the
default, so do not enable Nessie, Databricks, or the optional model compiler.

Start the frontend in a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Keep both terminals running.

## Core walkthrough (about three minutes)

### 1. Introduce Alex's Financial Twin

Start on **Overview**.

Say:

> Your bank knows what happened. TwinBank shows what happens next. This is
> Alex's Financial Twin: facts observed from banking activity, alongside the
> goals and limits Alex explicitly declared.

Point out:

- The header identifies **Demo user: Alex**, a connected backend, and the demo
  fixture as the data source.
- Alex has checking and savings, recurring income and obligations, variable
  spending, a summer-housing goal, and an emergency-reserve constraint.
- The Intent Graph distinguishes observed financial structure from declared
  intent; TwinBank does not guess a personal goal from transaction history.

Click **Simulate a purchase**.

### 2. Ask the $800 laptop question

The Purchase Simulator opens with the core scenario already filled in:

- What: **Laptop**
- Amount: **$800**
- When: the twin's current date
- Paid from: **Everyday Checking**

Say:

> Alex is not asking for a yes-or-no affordability verdict. Alex wants to see
> how buying an $800 laptop changes the range of possible futures.

Click **Simulate** once and wait for **Baseline vs. this purchase** to appear.

### 3. Compare the two futures

Read across the table from **Baseline** (no purchase) to **Counterfactual** (the
laptop). Lead with the tradeoff, not every number.

Point out:

- The median ending balance is about $800 lower with the laptop.
- The chance of a low checking balance rises sharply.
- The chance of dipping into the emergency reserve rises from almost none to a
  meaningful risk.
- The chance of meeting the summer-housing goal drops substantially because the
  goal must be met on top of the reserve.
- Upcoming mandatory obligations are still covered, while the purchase makes a
  transfer from savings to cover a bill much more likely.

The exact percentages are simulation results. With the seeded startup above
they repeat; without it, describe the direction and magnitude rather than
memorizing a percentage.

Say:

> TwinBank keeps the baseline and the purchase side by side. It exposes the
> tradeoffs and leaves the decision with Alex.

### 4. Explain why the result changed

Move to the **Why?** card directly below the comparison.

Point out:

- The summary connects the purchase to the ending balance, housing goal,
  low-balance risk, reserve risk, and upcoming bills.
- **Biggest drivers** separates the one-time laptop cost from the checking low
  point, the goal impact, seasonal spending, and expected income.
- **Assumptions** makes the horizon, uncertainty, reserve definition, goal
  treatment, and bill behavior explicit.

Say:

> The model performs the money math; this explanation only translates computed
> results. It does not invent an account, goal, or risk value.

This completes the required demo story.

## Optional 30-second close

If time permits, wait for **Other ways to do this**. Point out that alternatives
are compared against Alex's declared limits, and that TwinBank still presents
tradeoffs rather than issuing a command.

Then open **See the balance trajectory** to show the same baseline and purchase
as uncertainty bands over time. Do not refresh between the simulator and the
trajectory page: the latest simulation is intentionally held in the current
browser session.

## Recovery notes

- If the backend is unavailable, the frontend labels itself **Backend offline**
  and uses the bundled $800 laptop result. The core comparison and explanation
  still work, but alternatives are unavailable because they must match the live
  request.
- If Alex's goals or limits look different, stop the backend and restart it with
  the `TWIN_ANSWERS_PATH=` command above. That starts a clean in-memory demo
  without deleting anyone's saved answers.
- If a simulation fails, keep the entered purchase visible, confirm the backend
  is running, and click **Simulate** again. Do not substitute unrelated pages or
  external integrations during the core walkthrough.

## Success checklist

Before presenting, confirm all of the following:

- Overview names Alex and shows the Financial Twin.
- The laptop form opens prefilled with $800 and checking selected.
- Simulate produces baseline and counterfactual columns.
- The comparison includes balance, low-balance risk, reserve risk, goal impact,
  and obligation coverage.
- The **Why?** card shows the summary, drivers, and assumptions.
- The demo runs with fixture data and no external credentials.
