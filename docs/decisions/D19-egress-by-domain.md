# D19: Limiting a job's internet access to named hosts

Status: `DEFERRED`

A VM reaches the whole public internet ([D04](D04-the-internet-and-nothing-private.md)). A
job that turns hostile can therefore send what it holds (the repo's code, the secrets its
workflow was given) anywhere.

Softnet can deny everything and allow listed address ranges, but hosts like `github.com` and
package registries sit behind addresses that change daily, so a list of ranges does not
stay correct. Allowing by name needs an HTTP proxy on the Mac that VMs are forced through,
and a list per repo. That is a project of its own.

Forced by: a repo whose jobs should not reach the whole internet.
