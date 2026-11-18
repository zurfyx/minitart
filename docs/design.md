# Design

The dashboard is a tool you glance at. It follows the same rules as the owner's other
product UIs: a plain canvas, theme tokens only, one accent, few boxes, motion only when
state changes, and text lines near 70 characters.

## Tokens

Every colour, font and radius is a custom property in `dashboard/tokens.css`. Nothing else
names a colour. `site/tokens.css` is a copy, and a test keeps the two identical. Light and
dark follow `prefers-color-scheme`; the dark values are chosen, not inverted.

| Token                               | Use                                                               |
| ----------------------------------- | ----------------------------------------------------------------- |
| `--bg`                              | The page, edge to edge                                            |
| `--ink`, `--body`, `--muted`        | Text: names, prose, everything secondary                          |
| `--rule`, `--rule-strong`           | Hairlines between rows; control borders; empty pips               |
| `--hover`, `--code-bg`              | Hovered controls; the log and code                                |
| `--accent`, `--accent-ink`          | The one accent, raspberry: the primary button, focus, filled pips |
| `--ok`, `--warn`, `--bad`, `--busy` | A state, and nothing else                                         |

## Rules

- **Rows, not cards.** A list is rows with a hairline between them. Boxes are for the log
  and for an alert.
- **A state is a glyph and a word in the state's colour**: `✓ Passed`, `✕ Failed`,
  `● Running`, `○ Queued`. Never the colour alone, and a status colour is never decoration.
- **Text wears text tokens.** Names are `--ink`, the rest `--muted`. The accent is not a text
  colour except on hover.
- **Numbers are tabular**, so a ticking duration does not shift its row.
- **Slots are pips**: one per VM the kind may run, filled when in use. A ratio against a
  small limit reads faster as "2 of 2" pips than as a bar.
- **Motion only on a change of state**: a pip filling. Nothing pulses or spins while a job
  runs. All of it is off under `prefers-reduced-motion`.
- **Empty states are a sentence**, in `--muted`: "Nothing is running."
- **At 390px** a row wraps: the name on its own line, the facts under it.

## Words

Sentence case. Plain verbs. The dashboard says what happened ("no job came for it"), not
what a component did.
