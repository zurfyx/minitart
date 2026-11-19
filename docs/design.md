# Design

The dashboard is a tool you glance at. It follows the same rules as the owner's other
product UIs: a plain canvas, theme tokens only, one accent, few boxes, motion only when
state changes, and text lines near 70 characters.

## Tokens

Every colour, font and radius is a custom property in `dashboard/tokens.css`. Nothing else
names a colour. `site/tokens.css` is a copy, and a test keeps the two identical. Light and
dark follow `prefers-color-scheme`; the dark values are chosen, not inverted.

| Token                                   | Use                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `--bg`                                  | The page, edge to edge                                                          |
| `--ink`, `--body`, `--muted`            | Text: names, prose, everything secondary                                        |
| `--rule`, `--rule-strong`               | Hairlines between rows; control borders; chart grid                             |
| `--hover`, `--code-bg`                  | Hovered controls; the log and code                                              |
| `--accent`, `--accent-ink`              | The one accent, raspberry: the primary button, focus, the point of the headline |
| `--ok`, `--warn`, `--bad`, `--busy`     | A state, and nothing else                                                       |
| `--viz-vm`, `--viz-other`, `--viz-free` | Charts: minitart's VMs, everything else on the Mac, room to spare               |

## Rules

- **Rows, not cards.** A list is rows with a hairline between them. Boxes are for the log
  and for an alert.
- **A state is a glyph and a word in the state's colour**: `✓ Passed`, `✕ Failed`,
  `● Running`, `○ Queued`. Never the colour alone, and a status colour is never decoration.
- **Text wears text tokens.** Names are `--ink`, the rest `--muted`. The accent is not a text
  colour except on hover.
- **Numbers are tabular**, so a ticking duration does not shift its row.
- **The headline says what needs the owner**, most important first: no job can start;
  jobs wait, and why; all is flowing; idle ([D23](decisions/D23-what-the-dashboard-leads-with.md)).
  A resource is named only as the reason a job waits: a busy CPU is the Mac doing its work,
  and says nothing to do.
- **The timeline is the slots**: a lane per VM the kind may run, a bar per VM, light while
  it starts and solid while it runs its job, ending in its state's glyph.
- **Charts are one hue and a gray**: minitart's VMs in `--viz-vm`, everything else in
  `--viz-other`, so the eye goes to minitart's share. The pair is checked for colour-blind
  separation in both themes. Every chart has a legend and its numbers in text beside it,
  and a crosshair whose tooltip lists every series; the keyboard moves it too.
- **Charts are not redrawn under the pointer**, so a tooltip stays where it is read.
- **Motion only on a change of state**. Nothing pulses or spins while a job runs. All of it
  is off under `prefers-reduced-motion`.
- **Empty states are a sentence**, in `--muted`: "Nothing is running."
- **At 390px** a row wraps: the name on its own line, the facts under it.

## Words

Sentence case. Plain verbs. The dashboard says what happened ("no job came for it"), not
what a component did.
