# D25: A Usage view, with other providers' list prices as a reference

Status: `DECIDED`

## Decision

The dashboard has a Usage view. It shows, for the last 7, 30 or 90 days or a year:

- the minutes run here, each day, Linux and macOS apart, as GitHub would bill them: each job
  from when its runner took it, rounded up to a whole minute;
- jobs, and the hours the VMs were up, starting included;
- for reference, what the same minutes are listed at by other providers, and as a month at
  the range's pace;
- what this Mac costs a month: its price written off over a number of months, and its
  average draw at the owner's price of electricity, each only if the owner gives it.

The providers are GitHub-hosted, Blacksmith, Depot, Namespace, WarpBuild and Avrea, all
shown, as plain text: nothing on the page to pick or switch. Each is priced like for like,
at a 2 vCPU x64 Linux runner, the size of GitHub's `ubuntu-latest`, and its smallest macOS
runner. Toggles to pick providers, and menus to pick runners, were tried and taken out: they
put controls on a page that is there to be read.

## Why

The owner wanted to see how many minutes this Mac runs against what they are priced at, to
understand what it is worth. The owner also asked that the prices be a reference and not a
case against anyone's CI: so no "saved", no "would have charged", no payback figure, and a
note that says what list prices leave out.

## How the prices are kept

`src/pricing.ts` holds each provider's two runners and their per-minute list prices, read from the
provider's own page on the date it names, with that page linked and a line on what changes a
bill and is not in the price: plans, free minutes and credits, rounding. Where a provider
bills in its own units (Namespace), the price is worked out from its published rate and
says which rate. A change to a price is a change to that file.

Left out:

- **Ubicloud:** Linux only, and hard to compare like for like.
- **RunsOn:** it runs in the owner's own AWS account, with no list price per minute.

## Consequences

- Prices go out of date. The page says the date they were read on; updating them is
  updating one file and its test.
- The figures count minutes as they ran here. The same job can take more or fewer minutes on
  other hardware, and the page says so.
- A month is worked out from the days minitart kept its history, not from days before it.
- The settings gain `cost`: the Mac's price, life, draw and electricity price. The providers
  and runners an earlier version saved as chosen are let be when the file is read.
