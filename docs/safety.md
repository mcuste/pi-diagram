# Safety model

Diagram source is written by a language model and often quotes repository text, so it is treated
as untrusted input. Two things protect the machine it runs on: a check of the source before D2
starts, and the way D2 is started.

## Why the source is checked at all

D2 is a full language with file and asset access. This is a real diagram that reads a file:

```d2
a -> b
...@secret/private
```

Given that source, D2 reads `secret/private.d2` from disk and draws its contents as part of the
diagram. Absolute paths work too, so running D2 in a private directory does not stop it. `icon`
accepts local paths and remote URLs, and `shape: image` loads whatever it is pointed at. A
diagram tool without a source check is a file-read and network-fetch tool.

## What the source check allows

| Feature | Policy |
| --- | --- |
| Nodes, edges, labels, containers | Allowed |
| Sequence diagrams, SQL tables, class shapes | Allowed |
| Built-in shapes | Allowed from a fixed list |
| `@` imports, including `...@` spreads | Refused |
| `icon:` | Refused |
| `link:` | Refused |
| `shape: image` | Refused |
| `\|...\|` block strings: Markdown, LaTeX, code | Refused |
| `d2-config`, `layout-engine` | Refused |

Refusals report a code, a line, a column, and what to do instead, so the model can correct the
source in one more call rather than guessing.

The check reads the source with a small scanner that understands comments and quoted strings
before looking for anything else. That matters in both directions:

- `a: "user@example.com"` and `# icon: https://example.com/x.svg` are ordinary text and are
  allowed. So is `a: user@example.com`, because D2 only treats `@` as an import at the start of a
  token.
- An unterminated quote, or a block string, means the scanner can no longer tell code from
  content. Both are refused rather than guessed at. D2 rejects unterminated quotes as well, so
  nothing valid is lost.

## How D2 is started

| Control | What happens |
| --- | --- |
| No shell | `execFile` with an argument array. No command string is ever built. |
| No model input in the argument list | The arguments are fixed literals. Source travels only as a file. |
| Private working directory | A fresh temporary directory holding one file, `input.d2`, removed when the call ends. |
| Minimal environment | Only `PATH`, so a bare command name can be found. Nothing else is passed on. |
| Time limit | `--timeout 10` for D2, and a process limit above it in case D2 itself hangs. |
| Output limit | The render is stopped past 512 KB, and a drawing too large for a transcript is refused. |
| Cancellation | The host's abort signal terminates the subprocess. |
| Version check | Below the supported version, the call reports how to install a supported one. No renderer is ever downloaded during a call. |
| Fixed layout | ELK, chosen here rather than in the source. |
| No path leak | D2 puts absolute paths in its render errors. They are stripped before anything is returned. |

## What is checked after D2 runs

D2 exiting zero is not taken as proof the output is usable. Before anything is displayed:

- The drawing is not blank. D2's text renderer can return an empty box instead of failing.
- Plain ASCII output really is 7-bit, so a mode that silently stopped working is caught.
- Unicode output contains box-drawing characters, so a text-only answer is not mistaken for a
  diagram.
- Nothing but newlines can control the terminal. No escape sequence reaches the transcript.

## Known limits of D2's text renderer

D2's ASCII and Unicode export is beta. Two cases are worth knowing, and both are why the source
check refuses more than security alone would require:

- Block string labels (`|md ... |`) draw an empty box, losing the text.
- `shape: text` keeps its box but loses its label.

When text cannot represent a diagram at all, the tool retries once in plain ASCII and then says
so. It never substitutes a different diagram.
