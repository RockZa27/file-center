# Report shapes
Agents end their work with ONE JSON block. The exact shapes are the TypeScript types in `scripts/qa/types.ts`
(`RunnerReport`, `AuditorReport`, `VerifierReport`, `DevReport`, `UxReport`); each `.claude/agents/<agent>.md` shows its own example.
The orchestrator saves the block as `qa/reports/<round>/<agent>.json`; `bun run qa:score <round>` reads it.
