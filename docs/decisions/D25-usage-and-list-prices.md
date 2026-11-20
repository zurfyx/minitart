# D25: A Usage view: minutes run here, and other providers' list prices as a reference

Status: `DECIDED`

## Decision

The dashboard has a Usage view. It shows, for the last 7, 30 or 90 days or a year:

- the minutes run here, each day, Linux and macOS apart, as GitHub would bill them: each job
  from when its runner took it, rounded up to a whole minute;
- jobs, and the hours the VMs were up, starting included;
- for reference, what the same minutes are listed at by other providers, at a runner the
  owner picks for each kind, and as a month at the range's pace;
- what this Mac costs a month: its price written off over a number of months, and its
  average draw at the owner's price of electricity, each only if the owner gives it.

The providers are GitHub-hosted, Blacksmith, Depot, Namespace, WarpBuild and Avrea, all
shown at first. A Providers menu by the table's heading, closed until opened, picks which
are in the table and its notes. Each row has a menu for its Linux runner and one for its
macOS runner, each runner written the same way for every provider: its vCPUs, its memory
and, for macOS, the chip where the provider names it, from the provider's own pages, then
its price a minute; they start at a 2 vCPU x64 Linux runner, the size of GitHub's
`ubuntu-latest`, and the provider's smallest macOS runner. A row of toggles and a plain
table with no menus were both tried first: the toggles put controls on the page for
something done once, and without menus the table no longer showed each provider's runners
and prices.

## Why

The owner wanted to see how many minutes this Mac runs against what they are priced at, to
understand what it is worth. The owner also asked that the prices be a reference and not a
case against anyone's CI: so no "saved", no "would have charged", no payback figure, and a
note that says what list prices leave out.

## How the prices are kept

`src/pricing.ts` holds each provider's runners and per-minute list prices, read from the
provider's own page on the date it names, with that page linked and a line on what changes a
bill and is not in the price: plans, free minutes and credits, rounding. Where a provider
bills in its own units (Namespace), the price is worked out from its published rate and says
which rate. A change to a price is a change to that file.

Left out:

- **Ubicloud:** Linux only, and hard to compare like for like.
- **RunsOn:** it runs in the owner's own AWS account, with no list price per minute.

## Consequences

- Prices go out of date. The page says the date they were read on; updating them is updating
  one file and its test.
- The figures count minutes as they ran here. The same job can take more or fewer minutes on
  other hardware, and the page says so.
- A month is worked out from the days minitart kept its history, not from days before it.
- The settings gain `cost`: the providers shown and the runners picked for each (`compare`),
  and the Mac's price, life, draw and electricity price. A settings file without `compare`
  shows every provider at its defaults. A saved provider or runner since taken out of the
  price list is dropped or reset, never a reason to set the settings aside.
