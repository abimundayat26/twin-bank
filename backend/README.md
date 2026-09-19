# TwinBank backend

## LLM goal compiler (optional)

`POST /goals/compile` uses the rule-based compiler by default, so no key is needed.
To have Claude draft goals from the text instead, set these in `.env`:

```sh
GOAL_COMPILER=llm
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-haiku-4-5   # optional; this is the default
```

The LLM only extracts draft items. Deterministic code checks each one: the
fragment must appear in the text, the amount must appear in the fragment, and
the deadline goes through the same checks as the rules compiler. Anything that
fails a check becomes a clarification question. If the key is missing or the call
fails, the endpoint falls back to the rules compiler. The response's `compiler`
field says which one ran.
