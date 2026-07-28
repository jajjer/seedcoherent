# Demo GIF

`demo.gif` (embedded at the top of the main README) is generated from
[`demo.tape`](demo.tape) with [vhs](https://github.com/charmbracelet/vhs), so it
regenerates deterministically instead of being a hand-captured one-off.

## Regenerate

```bash
brew install vhs          # one-time (also needs ffmpeg + ttyd; brew pulls them in)
npm run demo              # == npm run build && vhs demo/demo.tape
```

This rebuilds `dist/`, recreates a throwaway SQLite database from
[`../examples/demo-sqlite.sql`](../examples/demo-sqlite.sql), runs `seedcoherent`
against it, and writes `demo/demo.gif`.

The tape uses `--seed 42`, so the generated rows are byte-identical every run;
only terminal timing varies. Commit the regenerated `demo.gif` alongside any
change to the tape or the demo schema.
