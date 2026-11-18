# D18: Keeping VMs booted ahead of jobs

Status: `DEFERRED`

A VM is started when a job is queued, so a job waits for a poll and a boot: about ten
seconds for Linux, longer for macOS. A VM kept booted would take a job at once.

A runner is registered to one repo, so a warm VM is warm for one repo; with several repos
and two macOS slots, guessing which repo is next mostly guesses wrong. Not worth it until
boot time is what people wait for.
