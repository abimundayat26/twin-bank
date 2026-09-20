# Workstream 2 pre-demo verification

This is the backend/API preflight for the Alex demo. It complements the Workstream 3
presenter and browser walkthrough; it does not replace it.

Run from a fresh clone or clean worktree. The default path uses the bundled Alex twin,
requires no credential, and makes no network call. `TWIN_ANSWERS_PATH=''` deliberately
ignores answers saved during rehearsal, while `SIMULATION_SEED=1` makes the Monte Carlo
figures repeatable.

## 1. Fresh-clone and default-fixture checks

```bash
cd backend
uv sync
TWIN_ANSWERS_PATH='' uv run pytest -q \
  tests/test_fixtures.py \
  tests/test_frontend_mocks.py \
  tests/test_twin_fixture.py
```

- [ ] Alex validates with two accounts, one goal, five recurring obligations, and no
      confirmed one-time obligations.
- [ ] The generated frontend mocks exactly match the backend fixtures.
- [ ] The twin carries the fitted seasonal forecast from the current fixture.
- [ ] No credential or external service was required.

## 2. Backend demo-story canary

```bash
TWIN_ANSWERS_PATH='' uv run pytest -q tests/test_demo_story.py
```

- [ ] Alex's `$800` laptop lowers the projected ending balance.
- [ ] Goal, reserve, and low-balance risk all worsen in the counterfactual.
- [ ] Optimization returns at least one limit-preserving alternative and recommends
      the first such candidate.

## 3. Start the local API

```bash
TWIN_ANSWERS_PATH='' SIMULATION_SEED=1 \
  uv run uvicorn backend.main:app --port 8000
```

- [ ] Use no `--host` argument and no tunnel. Uvicorn must remain on loopback.
- [ ] For a deterministic demo, set `GOAL_COMPILER=rules`. The default is `llm`, which only runs where `ANTHROPIC_API_KEY` is set and falls back to rules otherwise.
- [ ] No model credential is needed for the rules demo.

In a second terminal:

```bash
API=http://127.0.0.1:8000
curl -s "$API/health"
curl -s "$API/twin/alex" | python3 -m json.tool | head -35
curl -s -X POST "$API/goals/compile" -H 'content-type: application/json' \
  -d '{"user_id":"alex","text":"I want to save for a car"}'
SIMULATION=$(curl -s -X POST "$API/simulate" -H 'content-type: application/json' \
  -d '{"user_id":"alex","events":[{"type":"purchase","description":"Laptop","amount":800,"date":"2026-09-20","account_id":"acc_checking"}]}')
curl -s -X POST "$API/optimize" -H 'content-type: application/json' \
  -d '{"user_id":"alex","events":[{"type":"purchase","description":"Laptop","amount":800,"date":"2026-09-20","account_id":"acc_checking"}]}'
```

Expected with the current default fixture and seed:

- [ ] `/health` returns `{"status":"ok"}`.
- [ ] `/twin/alex` reports `source: "fixture"`, total balance `$3,140`, a seasonal
      forecast, and no confirmed one-time obligations.
- [ ] The incomplete car goal produces no draft goal, asks for amount and deadline,
      and reports `compiler: "rules"`.
- [ ] `/simulate` reports baseline ending balance `$3,396.06` and laptop ending
      balance `$2,596.06`.
- [ ] `/optimize` recommends `cand_cut_discretionary_50`; two of eight candidates
      meet every declared limit and unsuccessful candidates disclose their violations.

## 4. Rejected-request and draft-only checks

```bash
curl -s -X POST "$API/simulate" -H 'content-type: application/json' \
  -d '{"user_id":"alex","events":[{"type":"purchase","description":"Laptop","amount":800,"date":"2026-09-20","account_id":"acc_nope"}]}'
curl -s "$API/twin/bob"
curl -s -X POST "$API/goals/compile" -H 'content-type: application/json' \
  -d '{"user_id":"alex","text":"I have $1,200 tuition due 2027-01-15 from checking"}'
```

- [ ] The bad account is rejected with `422`; no fixture result replaces the error.
- [ ] The unknown user is rejected with `404`.
- [ ] Tuition without mandatory/optional status produces a clarification and no
      obligation draft.
- [ ] Compiling a complete obligation still changes no twin until the explicit
      confirmation request is sent.

## 5. Offline and fallback expectations

- A stopped backend is an offline condition, not a successful live result. The frontend
  may show its bundled example only with the offline/fallback label.
- An unavailable external data source may fall back to the fixture, but the twin source
  must remain `fixture`; it must never be presented as Nessie data.
- A rejected API request must remain an error and must not be replaced by fixture numbers.
- Browser wording and the presenter flow are verified by Workstream 3's PR #119.

The automated contract checks are:

```bash
cd ../frontend
npm test -- --run lib/api.test.ts lib/provenance.test.ts
```

## 6. Presenter-owned Nessie check — separate from this preflight

The repository defaults to fixtures. If the presenter is running the official
Nessie-backed variant, only the presenter performs the Workstream 1 readback procedure
with their own local configuration. Workstream 2 does not request, inspect, copy, or
configure credentials.

Before presenting that variant, the presenter must confirm:

- [ ] the repository's Workstream 1 Nessie readback check passes;
- [ ] `/twin/alex` truthfully reports `source: "nessie"`;
- [ ] the live twin's newly computed simulation and optimization results were rehearsed;
- [ ] if Nessie becomes unavailable, the fallback is identified as a demo fixture.

Do not reuse the fixture dollar expectations above for a Nessie-built twin. Inspect the
new computed result and update only Workstream 2 expectations that depend on it; do not
edit ingestion, generation, or forecasting code during demo preflight.
