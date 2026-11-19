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
- **Three views, named in the address**: Now (`#now`), Jobs (`#jobs`, with its page and
  filters: `#jobs?repo=octo/app&page=2`) and This Mac (`#mac`). A link, the back button and an
  installed app's reload land where they were.
- **The Jobs view is every job kept**, 50 a page, with how many there are, since when, and
  what they take on disk. Nothing is cut for its size; This Mac's Storage says what each
  thing minitart and Tart keep takes.
- **A log opens in a dialog**, over whichever view it was opened from. Escape, the Close
  button or a click outside closes it.
- **Motion only on a change of state**. Nothing pulses or spins while a job runs. All of it
  is off under `prefers-reduced-motion`.
- **Empty states are a sentence**, in `--muted`: "Nothing is running."
- **At 390px** a row wraps: the name on its own line, the facts under it.

## Icons

The mark is a cup with a ball over it, in the accent. `favicon.svg` is the mark alone, for
tabs and the page's header. The app icon, `dashboard/icons/app-icon.svg`, is the mark in
white on the accent, edge to edge: as the maskable icon, a system cuts its own shape from it
and the mark stays inside any of them. The PNGs are rendered from those two files by Chrome:
192 and 512 pixels (square for maskable, rounded for any), 180 for Apple, which rounds it
itself, and 16 and 32 for `favicon.ico` and browsers that do not draw SVG in a tab. The
website has copies, and a test keeps them the same.

## Words

Sentence case. Plain verbs. The dashboard says what happened ("no job came for it"), not
what a component did.
