# TwinBank demo walkthrough

This is the credential-free, repeatable presentation path for Alex's Financial Twin. It uses
the bundled demo fixture, the rule-based goal compiler, and a fixed Monte Carlo seed. The
presenter should describe it as demo data, never as live bank data.

The story is:

> Alex → Financial Twin → $800 laptop purchase → Simulate → baseline versus counterfactual →
> explanation and alternatives

## Preflight

- Use Node 22, Python 3.12, `npm`, and [`uv`](https://docs.astral.sh/uv/).
- Keep ports 8000 and 3000 free, or follow the occupied-port note below.
- Do not configure a model provider. The walkthrough explicitly keeps `GOAL_COMPILER=rules`.
- Do not configure Nessie, Databricks, or MLflow. The unattended path is fixture-backed.
- Never show credentials, environment-file contents, or terminal history during the demo.
- Never expose the backend on a public interface. Leave uvicorn on its default local interface;
  do not add a host flag or use a tunnel.
- Close old TwinBank tabs so the presenter starts at Overview and does not confuse an earlier
  browser session with the current backend process.

For an existing checkout, the start command below sets `TWIN_ANSWERS_PATH` to an empty value.
That ignores the saved-answer file and keeps this rehearsal's answers in memory only; stopping
the backend clears them without deleting anything. If the saved answers themselves need to be
reset, stop the backend and move only that file to a timestamped backup:

```bash
cd backend
if [ -f .data/answers.json ]; then
  answers_backup=".data/answers.json.before-demo-$(date +%Y%m%d-%H%M%S)"
  mv .data/answers.json "$answers_backup"
  echo "Saved the previous demo answers at $answers_backup"
fi
```

Do not remove the `.data` directory or any other files in it.

## Start from a fresh clone

Clone and install the two applications:

```bash
git clone https://github.com/abimundayat26/twin-bank.git
cd twin-bank/backend
uv sync
cd ../frontend
npm install
```

In terminal 1, start a deterministic, fixture-backed backend. With no host option, uvicorn binds
to the local machine only:

```bash
cd twin-bank/backend
USE_MOCKS=true GOAL_COMPILER=rules SIMULATION_SEED=1 TWIN_ANSWERS_PATH= \
  uv run uvicorn backend.main:app --reload --port 8000
```

In terminal 2, start the frontend:

```bash
cd twin-bank/frontend
npm run dev
```

Open <http://localhost:3000>. Before presenting, confirm the two facts separately:

1. `curl --fail http://127.0.0.1:8000/health` returns `{"status":"ok"}`. This proves only that
   the backend is reachable.
2. The header says **Backend connected · Demo fixture**. This says both that the backend answered
   and that Alex's observed data came from the fixture. Connected does not mean live bank data.

The percentages may vary if a presenter deliberately removes `SIMULATION_SEED=1`. Present the
direction and tradeoffs below rather than memorizing exact percentages.

## Scripted walkthrough

### 1. Introduce Alex on Overview

Start on **Overview**.

- Point to **Alex's Financial Twin** and explain that the twin combines facts observed in banking
  activity with facts Alex explicitly declared.
- In **Current balance**, introduce **Everyday Checking**, **Savings**, and the total. Emphasize
  the note that the total is not all free to spend because goals and the reserve are commitments
  against it.
- Point to the source badge again: this rehearsal is a connected backend serving **Demo fixture**
  data, not a live account.

### 2. Explain the Financial Intent Graph

In **Financial Intent Graph**:

- Use the solid observed links and **Observed** labels for accounts, income, bills, and spending.
- Use the dashed declared links and **You declared** labels for the housing goal and emergency
  reserve.
- State the product rule plainly: transaction history can reveal recurring structure, but it
  cannot tell TwinBank what Alex personally wants. TwinBank asks instead of inventing intent.
- The graph has a prose equivalent for assistive technology; it is not the only place the story
  is stated.

### 3. Review plans and an ambiguous payment

Open the top-left **Menu**, then **Plans & Assistant**.

- Review the declared **Summer housing** goal and its deadline.
- Review the **Minimum emergency reserve** and explain that it applies across checking plus
  savings, while the housing goal must be met on top of it.
- Leave **Minimum checking balance** unset. Point out that the simulator transparently uses its
  displayed $200 default; this keeps the seeded demo story unchanged.
- Under obligations, find the recurring transfer with an unclear purpose. Point out **What is
  this?**, the candidate labels, and their probabilities. Do not answer it during the canonical
  run. The choices are possibilities from observed activity, not facts until Alex declares one.

### 4. Demonstrate clarification instead of invention

In **Add or change a goal**, enter:

```text
I want to save for a trip
```

Choose **Read this back to me**.

Expected result:

- The review says **Read by rules**.
- **TwinBank will not guess these** asks how much is needed and when it is needed.
- Nothing is complete enough to save, and no new goal appears in the Financial Twin.

Choose **Discard**. Do not answer or confirm this sample; the purpose is to show that missing
financial facts remain missing.

### 5. Run the $800 laptop counterfactual

Use **Menu → Purchase Simulator**. The form opens with the canonical scenario:

- **What:** Laptop
- **Amount (USD):** 800
- **When:** the twin's current as-of date
- **Paid from:** Everyday Checking

Choose **Simulate** once. While it runs, the action changes to **Simulating…** and cannot submit a
second request.

Expected qualitative result in **Baseline vs. this purchase**:

- The counterfactual median ending balance is lower by the purchase amount.
- The chance of a low checking balance rises sharply.
- The chance of dipping into the emergency reserve rises.
- The chance of meeting **Summer housing** falls and the median future shows a goal shortfall.
- Mandatory obligations remain covered in the seeded result, while the chance of paying a bill
  out of savings rises. Explain both facts; “covered” does not mean “without consequence.”

Do not turn these metrics into a yes/no affordability verdict. The decision remains Alex's.

### 6. Explain the result and alternatives

In **Why?**:

- Read the concise backend-produced summary.
- Point out the purchase, lowest checking balance, housing goal, seasonal spending stretch, and
  expected income among the **Biggest drivers**.
- Explain that the text is template-based from computed results; it is not model-written advice.

In **Other ways to do this**:

- Wait for the comparison to finish.
- Find at least one option labelled **Keeps your declared limits**. In the seeded fixture run,
  reducing discretionary spending produces such an option.
- Contrast it with one option labelled **Breaks a declared limit** and read the stated violation.
- Present these as scored tradeoffs, not a recommendation. The choice remains Alex's.

### 7. Open Balance Trajectory

Choose **See the balance trajectory**.

- The solid baseline line is the future without the laptop; the dashed counterfactual line is the
  future with it. Line style, labels, and color all distinguish them.
- The shaded fans span **p10 to p90**, the middle 80% of simulated futures. The line in each fan
  is the median. A wider fan means more uncertainty, not a worse outcome by itself.
- Point out the **Laptop** purchase marker and the **Summer housing** goal-deadline marker.
- In the default **Total** view, point out the emergency-reserve reference line.
- Switch to **Checking** and point out the default low-balance reference line. It is labelled as a
  simulator default because Alex did not declare a minimum checking balance.
- Use **What this projection assumed** as the textual equivalent: it repeats the horizon, path
  count, purchase, reserve, low-balance line, goal deadline, and uncertainty explanation without
  requiring the chart.

### 8. Explain Forecast & Data

Use **Menu → Forecast & Data**.

- **Data source:** repeat **Backend connected · Demo fixture**, the as-of date, account count, and
  the fact that the fixture is not a real account.
- **Observation window and forecast method:** the hand-written fixture does not record forecast
  metadata, so these are correctly shown as unavailable rather than invented. A twin rebuilt
  from transactions would name its fitted window and method here.
- **Detected structure:** review the paycheck cadence, mandatory and optional recurring counts,
  and the unresolved transfer.
- **Forecast:** explain the seasonal factors that the fixture does carry. A factor above 1.0 is a
  busier-than-average fortnight for that category; below 1.0 is quieter. The twelve factors
  average to 1.0 and describe history, not a guarantee about a future month.
- **Processing:** the fixture path is built by the local pipeline; no Databricks job is implied.
- **Limitations:** call out the missing forecast metadata, the unresolved classification, the
  lack of exposed MLflow lineage, and the fact that the browser receives summaries rather than
  transactions or connection settings.

## Presenter rehearsal checklist

Before the live presentation, complete these checks on the exact commit being shown:

- Run the full story above with the keyboard only: open and close Menu, move through every field,
  submit the incomplete goal, discard it, submit the laptop, switch the chart view, and navigate
  to Forecast & Data. Focus must remain visible throughout; Escape must close Menu and return
  focus to its button.
- At browser widths 320, 375, 768, 1024, and 1440 px, visit all five routes and check the header,
  menu drawer, long ambiguous-transfer label, comparison grid, alternative cards, chart labels,
  seasonal factor grid, and every primary action. There must be no document-level horizontal
  scroll, clipped controls, or overlapping labels.
- Confirm that **Observed**, **You declared**, **Baseline**, **Counterfactual**, **Current page**,
  **Keeps your declared limits**, and **Breaks a declared limit** remain understandable without
  relying on color alone.
- Confirm the chart conclusion is also available in its accessible label and the assumptions
  panel, and that the graph has its prose equivalent.
- Trigger one rejected request in a non-demo rehearsal if practical and confirm **Simulation
  failed** shows the backend message instead of unrelated fixture results.

## Fixture and offline recovery

The canonical run uses a live local backend serving fixture data. If the backend stops:

1. Leave the frontend running and reload the page.
2. Confirm the header changes to **Backend offline · Bundled example**. This is a transport state
   and a bundled data origin; it must never be called live bank data.
3. Overview and Forecast & Data remain available from the bundled twin.
4. A simulation shows the saved $800 laptop example with a **Backend offline** warning. It does
   not respond to edited purchase fields or saved answers.
5. Goal compilation and optimization require the backend; the UI must say they are unavailable
   rather than inventing a draft or alternative.

Restart terminal 1 with the deterministic command above, reload the frontend, and confirm the
header returns to **Backend connected · Demo fixture** before continuing the canonical story.

## Optional Nessie presenter smoke check

This is presenter-owned and is not part of unattended validation. Only a presenter who already
has their own private Nessie configuration should perform it.

- Keep the backend local and keep credentials out of the screen recording, shell history, logs,
  and browser.
- Start the backend using the repository's existing private configuration, with mocks disabled.
- Confirm the header says **Backend connected · Nessie data** and that Forecast & Data says the
  accounts and transaction history were read from the Nessie sandbox.
- If the external service is unavailable, return to the fixture command. Do not delay or weaken
  the canonical demo; a real-service rehearsal is intentionally not an automated gate.

## Troubleshooting

### Port 8000 or 3000 is occupied

Identify the existing local process before changing anything:

```bash
ss -ltn '( sport = :8000 or sport = :3000 )'
```

Prefer stopping a stale TwinBank process. If that is not possible, keep both applications local
and choose matching ports. For example, run the backend on 8001 and start the frontend with
`NEXT_PUBLIC_API_URL=http://localhost:8001 npm run dev`. If the frontend must use 3001, start the
backend with `CORS_ORIGINS=http://localhost:3001` and run `npm run dev -- --port 3001`.

### The header says Backend offline

- Check terminal 1 for a running backend and confirm the health URL responds.
- Confirm the frontend's `NEXT_PUBLIC_API_URL` points to the same local backend port.
- Restart the frontend after changing its API URL.
- While offline, describe the UI as the bundled example and use the recovery steps above.

### A request is rejected

A backend rejection is intentionally not replaced with fixture numbers. Read the error shown by
the form, correct the invalid amount, account, date, or declaration, and submit again. For the
canonical laptop story, restore the defaults listed in step 5. If the backend itself is no longer
reachable, use the clearly labelled offline recovery path instead of presenting the saved example
as a response to new input.
