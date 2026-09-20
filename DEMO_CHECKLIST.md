# Pre-demo verification checklist

Run this before presenting. It is meant to be run by **someone who did not write the
code** — every step is a command with an expected result, not a judgement call.

Companion to the presenter script. This document answers *"is the machine ready?"*;
the script answers *"what do I say?"*. If both are open at once, run this one first.

Everything here was executed end to end on **2026-09-19** from a **fresh clone of
`main` at `04850a8`**, with **no `.env` and no credentials of any kind**. Results below
are what it actually printed, not what it ought to print.

---

## 0. The one thing most likely to go wrong

**TwinBank remembers answers between runs, in `backend/.data/answers.json`, and they
change the numbers on screen.**

This bit during rehearsal. Answering one classification question — *"the recurring
transfer is savings"* — moved the projected balance by **$525** ($75 × 7 occurrences,
because a declared savings transfer moves money inside the twin instead of spending
it). Nothing on screen says the numbers moved, and the file survives a restart.

So: **rehearse, then clear, then present.**

```bash
rm -rf backend/.data          # forget every answer from rehearsal
```

Second: **Monte Carlo is unseeded by default**, so every `/simulate` returns slightly
different figures. Quoting a number from rehearsal and having the live run disagree is
avoidable:

```bash
SIMULATION_SEED=1 uv run uvicorn backend.main:app --port 8000
```

Measured, on the fresh clone:

| State | Baseline ending balance | Counterfactual |
| --- | --- | --- |
| No seed | moves every run (saw $3,764) | moves every run |
| `SIMULATION_SEED=1`, `backend/.data` cleared | **$3,280.51** | **$2,480.51** |
| `SIMULATION_SEED=1`, one classification answered | $3,805.51 | $3,005.51 |

The middle row matches `backend/fixtures/simulation.json` **to the cent**. That is the
state to present in: the numbers on screen are then the numbers in the repository, and
they are the same every time you press Simulate.

---

## 1. Fresh clone

```bash
git clone <repo> twinbank && cd twinbank
```

- [ ] no `.env` file is present, and you have not created one
- [ ] `ls backend/.data` says no such directory

## 2. Backend

```bash
cd backend
uv sync
uv run pytest -q
```

- [ ] **554 passed** (or more — the number only ever grows)
- [ ] the run needed no credential and reached no network

## 3. Frontend

```bash
cd frontend
npm install
npm test && npm run typecheck && npm run lint && npm run build
```

- [ ] **535 passed** across 32 files (or more)
- [ ] typecheck, lint and build all clean

*Measured: all four clean on the fresh clone.*

## 4. Start both, on this machine only

```bash
cd backend && SIMULATION_SEED=1 uv run uvicorn backend.main:app --port 8000
cd frontend && npm run dev
```

- [ ] **no `--host` flag.** With none, uvicorn binds `127.0.0.1` and nothing outside
      this machine can reach it. Verify:

```bash
ss -ltn | grep 8000     # must show 127.0.0.1:8000, never 0.0.0.0:8000
```

*Measured: `LISTEN 127.0.0.1:8021` — loopback only, confirmed.*

- [ ] no tunnel (ngrok, cloudflared) is running

## 5. API smoke pass

Six calls, in the order the demo makes them. Copy-paste and compare.

```bash
B=http://127.0.0.1:8000
curl -s $B/health
curl -s $B/twin/alex | python3 -m json.tool | head -30
curl -s -X POST $B/goals/compile -H 'content-type: application/json' \
  -d '{"user_id":"alex","text":"I want to save for a car"}'
SIM=$(curl -s -X POST $B/simulate -H 'content-type: application/json' \
  -d '{"user_id":"alex","events":[{"type":"purchase","description":"Laptop","amount":800,"date":"2026-09-20","account_id":"acc_checking"}]}')
echo "$SIM" | python3 -c 'import json,sys;print(json.load(sys.stdin)["simulation_id"])'
curl -s $B/explain/<that id>
curl -s -X POST $B/optimize -H 'content-type: application/json' \
  -d '{"user_id":"alex","events":[{"type":"purchase","description":"Laptop","amount":800,"date":"2026-09-20","account_id":"acc_checking"}]}'
```

- [ ] `/health` → `{"status":"ok"}`
- [ ] `/twin/alex` → `source: "fixture"`, total `3140.0`, Everyday Checking `1340.0`,
      Savings `1800.0`, one goal (Summer housing, 2027-05-01), five obligations
- [ ] `/goals/compile` with an incomplete goal → **zero goals** and two clarifications
      (`amount`, `deadline`), `compiler: "rules"`. *This is the honesty demo: it asks
      instead of inventing.*
- [ ] `/simulate` → baseline **$3,280.51**, counterfactual **$2,480.51**
- [ ] `/explain/{id}` → five drivers, starting with the laptop at `-800.0`
- [ ] `/optimize` → `recommended_id: cand_cut_discretionary_50`, and at least one
      candidate with `meets_constraints: true`

*All six measured green on the fresh clone.*

## 6. Negative rehearsals

A demo is only safe if you have already seen it fail.

- [ ] **A rejected simulation shows the backend's error, not fixture numbers.**

```bash
curl -s -X POST $B/simulate -H 'content-type: application/json' \
  -d '{"user_id":"alex","events":[{"type":"purchase","description":"Laptop","amount":800,"date":"2026-09-20","account_id":"acc_nope"}]}'
```
*Measured: `422 {"detail":"Unknown account_id 'acc_nope'"}`.* The frontend surfaces the
error rather than falling back — `lib/api.ts` throws `ApiError` on a backend error and
only falls back when the backend is **unreachable**.

- [ ] **An unknown user is refused.** *Measured: `404 {"detail":"No twin for user 'bob'"}`.*

- [ ] **No model credential is needed.** With `GOAL_COMPILER` unset, every compile
      reply says `compiler: "rules"`. *Measured.* Never set `GOAL_COMPILER=llm` for a
      demo: it needs a key, and the rules compiler is what has been rehearsed.

- [ ] **Backend stopped → the frontend shows the offline state, not fixture numbers
      presented as live.** ⚠️ **Confirm this one in a browser.** The page is
      client-rendered, so a `curl` of the served HTML shows none of the labels and
      proves nothing. Stop the backend, reload, and read the badge: it must say
      **"Backend offline · Bundled example"**. The logic is unit-tested
      (`lib/provenance.test.ts`), but only a human can confirm what is on the screen.

---

## Recovery appendix — **not the official demo**

> Read this only if something has already broken. `frontend/SPEC.md` §12 is explicit
> that a fixture-backed session **does not count as a complete official demo**, and
> that fallback must never be described as an equivalent path. Say out loud what you
> are showing.

| Symptom | Recovery | What you must say |
| --- | --- | --- |
| Numbers differ from rehearsal | `rm -rf backend/.data`, restart with `SIMULATION_SEED=1` | nothing — fix it before you start |
| Backend will not start | present the frontend alone; it falls back to bundled fixtures | *"the backend is down, these are bundled example figures"* |
| Backend up, Nessie failing | it already falls back to fixtures and labels itself `Demo fixture` | *"this twin is from a demo fixture, not live bank data"* |
| A simulation returns an error | show the error; it is the honest behaviour | *"TwinBank refuses rather than inventing a number"* |
| The forecast page has no metadata | expected — Alex's hand-written twin has `forecast: null` | *"this twin was written by hand, so there is no fitted forecast to show"* |

**Never** improvise a fix by setting `GOAL_COMPILER=llm`, exporting a key, or binding
the backend to `0.0.0.0`. None of those is rehearsed and the first two need a
credential that only the group lead holds.

---

## Open question this checklist cannot close

**Does the official demo run on fixtures or on live Nessie?** The two specs disagree —
`SPEC.md` §5 says *"the demo stays on fixtures by default"*, `frontend/SPEC.md` §12 says
the official demo *"requires a connected backend and a Financial Twin built from
Capital One Nessie"*. `SPEC.md` §13 lists it as **open**, default fixtures, owned by
Workstream 1.

**Until the team decides, this checklist verifies the fixture path**, which is the
recorded default and the only one that can be verified without a credential.

If the team chooses Nessie, five steps are added ahead of section 4 — they are already
written out in `frontend/SPEC.md` §12 and each needs the presenter's **own** Nessie
key, which nobody else configures for them:

1. configure your own Nessie credentials, never in the browser or the repository
2. seed or confirm the Alex demo data in the sandbox
3. run the repository's Nessie readback check
4. start the backend with Nessie enabled
5. confirm the frontend reports **"Backend connected · Nessie data"** — if it says
   anything else, you are on the fixture path and must say so

Nothing else in this document changes: the smoke pass, the negative rehearsals and the
recovery appendix apply either way. Only the expected figures in section 5 move, because
they would then come from live data.
