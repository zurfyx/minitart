# D16: How minitart is installed: npm, Homebrew, or a clone

Status: `DEFERRED`

Today minitart is installed by cloning the repo and running it with Node. That suits the
owner and anyone who wants to read it first.

Node does not strip types from files under `node_modules`, so publishing to npm means a
build step, which [D07](D07-typescript-run-as-it-is.md) avoids. A Homebrew formula that
installs the source tree would keep D07 as it is.

Forced by: the first person who is not the owner installing it.
