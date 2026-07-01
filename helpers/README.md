# Helpers (deprecated)

The Python helper scripts have been replaced by the TypeScript CLI.

Use `npx video-use` from the repository root:

| Command | Purpose |
|---------|---------|
| `npx video-use transcribe <video>` | Single-file Scribe transcription |
| `npx video-use transcribe-batch <dir>` | Parallel batch transcription |
| `npx video-use pack --edit-dir <dir>` | Pack transcripts → `takes_packed.md` |
| `npx video-use timeline <video> <start> <end>` | Filmstrip + waveform PNG |
| `npx video-use render <edl.json> -o <out>` | Render from EDL |
| `npx video-use grade <in> -o <out>` | Apply color grade |
| `npx video-use redis ping` | Verify Redis connectivity |

Run `npx video-use --help` for full options. See `SKILL.md` for agent usage.
