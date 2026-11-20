# D09: The manager is a LaunchAgent in whichever account runs it

Status: `DECIDED`

## Decision

The manager runs as a LaunchAgent: Homebrew's (`brew services start minitart`), or, from a
checkout, the one `minitart service install` writes (`sh.rovira.minitart`). Either starts it
at login and restarts it if it stops. It runs as the user who installed it, in that user's
session. minitart creates no user; its one system daemon only loads the firewall rule at
boot ([D21](D21-what-a-job-reaches-on-the-mac-itself.md)).

Which user is the owner's choice. Their own account is the simple one. A macOS user made for
the purpose works the same way: everything minitart keeps (`~/.minitart`, Tart's images) is
under the home of whoever runs it, and nothing assumes an administrator.

## Why

A dedicated user is what protects a Mac from a runner that runs jobs on the Mac. Here jobs
run in VMs ([D01](D01-every-job-in-a-fresh-vm.md)); the process on the Mac only runs `tart`
and calls GitHub. What a second account adds is keeping the App's key and Tart's images away
from the owner's everyday processes, and those usually hold a more powerful GitHub token
already. So minitart does not set one up or ask for one. It costs something, too: that user
has to be the one logged in at the Mac, which on a Mac someone also works at means two
sessions.

Tart runs VMs from a logged-in session; from a system daemon with nobody logged in it is
unreliable. And one account means one home folder and no switching users to debug.

## Consequences

- The Mac must be logged in (automatic login) and must not sleep. `minitart doctor` checks
  sleep.
- Stopping the service deletes every VM; running jobs fail as "runner lost".
