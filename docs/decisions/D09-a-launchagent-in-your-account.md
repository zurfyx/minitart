# D09: The manager is a LaunchAgent in the owner's account

Status: `PROPOSED`

## Decision

`minitart service install` writes a LaunchAgent (`sh.rovira.minitart`) that starts the
manager at login and restarts it if it stops. It runs as the owner, in the owner's session.
There is no dedicated user and no system daemon.

## Why

A dedicated user is what protects a Mac from a runner that runs jobs on the Mac. Here jobs
run in VMs ([D01](D01-every-job-in-a-fresh-vm.md)); the process on the Mac only runs `tart`
and calls GitHub. A second account would protect the App's key from the owner's own
processes, which already hold a more powerful GitHub token.

Tart runs VMs from a logged-in session; from a system daemon with nobody logged in it is
unreliable. And one account means one home folder and no switching users to debug.

## Consequences

- The Mac must be logged in (automatic login) and must not sleep. `minitart doctor` checks
  sleep.
- Stopping the service deletes every VM; running jobs fail as "runner lost".
