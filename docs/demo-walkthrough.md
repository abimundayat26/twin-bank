# TwinBank demo walkthrough

This is the credential-free, repeatable presentation path for Alex's Financial Twin. It uses
the bundled demo fixture, the rule-based goal compiler, and a fixed Monte Carlo seed. The
presenter should describe it as demo data, never as live bank data.

The story is:

> Alex → Financial Twin → $800 laptop purchase → Simulate → baseline versus counterfactual →
> alternatives and balance trajectory

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
2. No **Backend offline** banner sits under the header, and **Forecast & Data** shows a **Data
   source** card reading **Sample data**. The header carries no data-source chip by design; that
   one card is the only place the origin is named. Reachable does not mean live bank data.

The percentages may vary if a presenter deliberately removes `SIMULATION_SEED=1`. Present the
direction and tradeoffs below rather than memorizing exact percentages.

## Scripted walkthrough

Six steps, following the nav order. Every number below was produced by the seeded command above;
the presenter reads the direction and the tradeoff, never a verdict.

### 1. Introduce Alex on Overview

Start on **Overview**.

- The three tiles are **Total net balance**, **Income minus fixed bills** (captioned *Variable
  spending excluded*, so nobody reads it as spare cash) and **Goal progress**.
- **Accounts** lists **Everyday Checking** and **Savings**. Say that the total is not all free to
  spend: the goal and the reserve are commitments against it.
- **Spending** is a donut of Alex's variable categories plus one **Fixed bills** slice. Say why
  the bills are one slice: the twin records no spend category for them, and TwinBank does not
  guess one.
- **Upcoming activity** lists the next items within 30 days, income positive and bills negative.
- Explain the split the product rests on: balances, cadences and recurring bills are *observed*;
  goals and limits are *declared*. Nothing on this page was inferred about Alex's intentions.

### 2. Let the Assistant read a sentence

Open the top-left **Menu**, then **Plans & Assistant**.

The chat opens with the question TwinBank genuinely cannot answer by itself:

> What is Online Transfer To ($71.82 a month)?

- Point out the quick replies — **Savings transfer**, **Debt repayment**, **Optional spending** —
  and that they carry no probabilities. These are possibilities from observed activity, not facts
  until Alex declares one. Answer it with **Savings transfer**, or leave it for step 3.
- Type: `I want to save $2,000 for a trip by next June`
- The reply is **Here is what I understood. Nothing changes until you accept.** with a card
  reading **Add goal: Trip, $2,000 by Jun 1, 2027** and the quoted words it came from. The bubble
  is labelled **Read by rules** — no model is configured, and the label never claims otherwise.
- Press **Accept**. The card becomes **Added** and the goal appears in the **Goals & Limits**
  panel beside the chat, where its target, date and saved-so-far can be corrected in place.
- Now show the refusal to guess. Type: `I want to save for a trip`
- The reply is **I need a bit more before I can draft this.**, with two questions — *How much do
  you need for a trip?* and *When do you need the money for a trip?* — and **no card**. Missing
  financial facts stay missing.

In the **Goals & Limits** panel, point out **Emergency reserve $1,500** ("checking plus savings")
and **Minimum checking balance $200 (default)** ("checking only"). Leave the default in place;
the seeded numbers below assume it.

### 3. Correct the plan on Obligations

**Menu → Obligations**. Everything here is deterministic — no model, no explanations.

- **Recurring expenses** lists each detected bill with its category, amount and due day. If the
  transfer is still unclassified, its Category cell offers **What is this?** with the same
  choices, and no default selection.
- Toggle one bill to **Paused** and say what it means: every simulation from now on leaves it
  out. The row stays visible and dimmed.
- Add an item under **Upcoming obligations** to show one-off commitments entering the baseline.
- Un-pause the bill before continuing, so the seeded figures in step 4 hold.

Detected bills can be paused and edited but not deleted: the next rebuild from transactions
would simply bring them back.

### 4. Run the $800 laptop counterfactual

**Menu → Purchase Simulator**. Fill the single row:

- **What:** Laptop
- **Amount:** 800
- **Date:** the default, the day after the twin's as-of date
- **Pay from:** Everyday Checking

Choose **Simulate** once. The button disables while the request is in flight.

The comparison is two columns, **No Purchase** against **Purchase**, under the caption **Through
May 1, 2027** — the date every figure covers. Seeded, expect:

| Row | No Purchase | Purchase |
| --- | --- | --- |
| Predicted balance | $3,396 | $2,596 |
| Chance of low balance | 2% | 97% |
| Chance of dipping into your reserve | 0% | 18% |
| Chance of paying a bill out of savings | 0% | 51% |
| Chance your goal is met | 77% | 10% (short by $504) |
| Upcoming bills | Covered | Covered |

- The **High impact** badge sits above the comparison. Its tooltip lists the reasons the backend
  computed: low balance up 95 points, reserve up 18, goal met down 67. The level is never an
  unexplained number, and the frontend never computes it.
- Dwell on the last two rows together. Bills stay **Covered**, yet a bill is paid out of savings
  in about half of futures and the housing goal all but collapses. Covered does not mean without
  consequence, and this is exactly why TwinBank does not answer "can I afford it".
- Open **Balance over the next 90 days**. The caption says the chart shows 90 days while the
  figures above cover the full horizon; the **Full horizon** toggle switches it.

Do not turn these metrics into a yes/no verdict. The decision stays Alex's.

### 5. Compare alternatives, then decide

In **Other ways to do this**, up to three rows appear, each with predicted balance, chance of low
balance, chance the goal is met and **Keeps your limits**:

- **Buy as planned** repeats the Purchase column exactly, so one screen never shows two numbers
  for one thing.
- The best alternative in the seeded run is cutting discretionary spending by half, and it is the
  only lever that keeps every limit.
- Every delay option still breaks one: *Checking plus savings dips below the $1,500 emergency
  reserve in 16% of futures.* Read that violation aloud — waiting alone does not fix this
  purchase, which is a more honest answer than "buy it later".

Under **Decide**, show the three commitments and that each asks for confirmation first:

- **Proceed** adds the laptop to the plan as a one-off, non-mandatory obligation.
- **Sacrifice Summer housing** asks the backend for the earliest deadline that restores the
  goal's chances, rather than guessing a date.
- **Apply Compromise** is disabled here, with the tooltip *Spending cuts can't be saved yet* —
  the twin has nowhere to persist a spending target. A disabled control that says why.

Choose **Proceed** and confirm. The comparison is marked out of date, because the plan it
described has changed. Go to **Obligations**, find **Laptop** under upcoming obligations, and
delete it. That deletion is the undo.

### 6. Balance Trajectory, then Forecast & Data

**Menu → Balance Trajectory** shows the projection behind the latest simulation.

- Two medians with their **p10 to p90** bands: without the purchase, and with it. A wider band
  means more uncertainty, not a worse outcome.
- Point out the purchase marker, the goal-deadline marker and the dashed reserve line.
- Switch **Total** to **Checking**. Confirm the chart's visually hidden table exposes the same
  values to assistive technology.

**Menu → Forecast & Data** closes the loop on provenance.

- **Linked accounts & sources**: one card per account, and the **Data source** card reading
  **Sample data**. This is the only place in the UI that names the origin.
- **Financial structure**: income cadence, the fixed-bill schedule, and **Seasonal trends** —
  which month each category runs busiest and quietest, fitted from the transaction history.
- The **forecast chart** draws the baseline median and band across the horizon, with up to four
  callouts. Read one aloud and note that its reason is built only from what the twin contains —
  a bill that is due, a paycheck, heavy spending in a category. TwinBank will not name a cause
  its data does not hold.

## Presenter rehearsal checklist

Before the live presentation, complete these checks on the exact commit being shown:

- Run the whole story with the keyboard only: open and close Menu, move through every field,
  accept a card, edit a goal in the panel (Enter saves, Escape cancels), submit the laptop,
  toggle the chart view. Focus must stay visible throughout; Escape must close Menu and return
  focus to its button.
- At 320, 375, 768, 1024 and 1440 px, visit all six routes in light and dark. Check the KPI
  tiles, the collapsed **Goals & limits** toggle and its count, the obligations tables as stacked
  cards, the two-column comparison, and the chart labels. There must be no document-level
  horizontal scroll, clipped control or overlapping label.
- Confirm that **Covered / At risk / Not covered**, **Low / Moderate / High impact**, **Paused**,
  and **Keeps your limits** all read without relying on colour.
- Confirm each chart's visually hidden table carries its plotted values.
- Trigger one rejected request in a non-demo rehearsal if practical, and confirm the form shows
  the backend's own message and **no numbers**.

## Fixture and offline recovery

The canonical run uses a live local backend serving fixture data. If the backend stops:

1. Leave the frontend running and reload the page.
2. A banner reads **Backend offline. Showing saved sample data. Changes are disabled.** This is a
   transport state over bundled data; it must never be called live bank data.
3. Overview and Forecast & Data still render, from the bundled twin and the bundled forecast.
4. Every control that would write — Accept, Save, Add, Delete, the toggles, Simulate, Proceed —
   is disabled, and says why in its tooltip. Nothing pretends to succeed locally.
5. Simulation, optimization and the Assistant need the backend. They say so rather than showing a
   saved result as if it answered the question just asked.

Restart terminal 1 with the deterministic command above, reload the frontend, and confirm the
banner is gone before continuing the canonical story.

## Optional Nessie presenter smoke check

This is presenter-owned and is not part of unattended validation. Only a presenter who already
has their own private Nessie configuration should perform it.

- Keep the backend local and keep credentials out of the screen recording, shell history, logs,
  and browser.
- Start the backend using the repository's existing private configuration, with mocks disabled.
- Confirm the **Data source** card on Forecast & Data reads **Capital One Nessie** instead of
  **Sample data**.
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

### The offline banner appears

- Check terminal 1 for a running backend and confirm the health URL responds.
- Confirm the frontend's `NEXT_PUBLIC_API_URL` points to the same local backend port.
- Restart the frontend after changing its API URL.
- While offline, describe the UI as bundled sample data and use the recovery steps above.

### A request is rejected

A backend rejection is intentionally not replaced with fixture numbers. Read the error shown by
the form, correct the invalid amount, account, date, or declaration, and submit again. For the
canonical laptop story, restore the values listed in step 4. If the backend itself is no longer
reachable, use the clearly labelled offline recovery path instead of presenting the saved example
as a response to new input.

## Rehearsal screenshots

- [Checking trajectory at 375 px](screenshots/trajectory-checking-375.png)
- [Checking trajectory at 1440 px](screenshots/trajectory-checking-1440.png)
- [Forecast & Data with the long ambiguous-transfer label at 320 px](screenshots/forecast-data-320.png)
