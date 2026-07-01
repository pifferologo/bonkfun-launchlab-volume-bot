# Repository Audit — video-use

Internal engineering summary from Phase 1 analysis of the upstream Python skill repository.

## Current Architecture

| Layer | Description |
|-------|-------------|
| **Skill docs** | `SKILL.md` and `install.md` — agent instructions for conversation-driven editing |
| **Python helpers** | Seven standalone scripts in `helpers/` — transcribe, pack, render, grade, timeline |
| **Animation skill** | Vendored `skills/manim-video/` with its own references |
| **Dependencies** | `pyproject.toml` — requests, librosa, matplotlib, pillow, numpy |
| **Config** | `.env` with `ELEVENLABS_API_KEY` only |
| **CI / tests** | None — no automated validation |

The LLM reads packed transcripts and invokes Python helpers via shell. All session outputs land in `<videos_dir>/edit/`.

## Major Weaknesses

1. **No type safety** — Python helpers lack static typing and automated tests
2. **No build toolchain** — no lint, format, or CI pipeline
3. **Duplicated config loading** — each helper reads `.env` independently
4. **No structured logging** — print statements only, no log levels
5. **No transcript cache beyond filesystem** — Redis would enable cross-session reuse
6. **Platform coupling** — timeline_view depends on PIL + numpy with manual WAV parsing
7. **No unified CLI** — seven separate entry points, harder for agents to discover
8. **Minimal error handling** — inconsistent exit codes across helpers

## Recommended Improvements

1. TypeScript strict mode with shared libraries under `src/`
2. Unified Commander CLI (`npx video-use <command>`) replacing Python helpers
3. Central config via environment variables with validation
4. Structured logging with configurable levels
5. Redis-backed cache for Scribe transcripts (optional, env-gated)
6. Vitest unit tests for pack logic and Redis integration
7. ESLint + `tsc --noEmit` in npm scripts
8. Professional README with architecture diagrams and troubleshooting
9. Cross-platform `.editorconfig` and consistent tooling

## Security Notes

- ElevenLabs API key must never be committed; `.env` stays gitignored
- Redis should default to disabled in development unless explicitly enabled
- ffmpeg subprocess calls use argument arrays (no shell interpolation)
