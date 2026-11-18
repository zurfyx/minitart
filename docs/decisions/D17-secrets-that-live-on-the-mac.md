# D17: Jobs that need a secret that lives on the Mac

Status: `OPEN`

Some jobs sign things: an iOS archive needs a distribution certificate and a provisioning
profile. With a runner on the Mac itself, those can live in the Mac's keychain and never be
uploaded anywhere. A job in a VM cannot see the Mac's keychain; that is the point of the VM.

The options:

1. **The secret goes to GitHub** as a repository or environment secret, and the workflow
   installs it in the VM's keychain, as on a hosted runner. Nothing to build. The secret
   then lives on GitHub.
2. **The Mac hands chosen files to chosen repos' VMs**: a read-only folder per repo, mounted
   into that repo's VMs only. The secret stays on the Mac, and every job of that repo can
   read it, including a pull request's. It is the first hole in "no shared folder"
   ([D01](D01-every-job-in-a-fresh-vm.md)).
3. **The signing step runs outside the VM**, on the Mac, on the VM's output. No secret
   enters a VM. It is also a second kind of job runner, with its own trust questions.

Needs the owner's call. Forced by: the first workflow that signs with a key the owner does
not want on GitHub.
