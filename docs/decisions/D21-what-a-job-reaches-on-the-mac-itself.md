# D21: What a job reaches on the Mac itself, at the VM's gateway

Status: `OPEN`

Softnet keeps a VM off the home network and the tailnet ([D04](D04-the-internet-and-nothing-private.md)),
and lets it reach one address of the Mac: the gateway of its own virtual network, where DHCP
and DNS are served. Anything else the Mac serves to every network is reachable there too.
Measured on the Mac this was built on, from inside a VM on Softnet: Kerberos (88), AirPlay
Receiver (5000 and 7000) and Handoff's `rapportd` answered; SSH and Screen Sharing did not,
because a firewall rule the owner already had limits those to the tailnet.

`minitart selftest` finds these and fails, and the docs say to turn off what is not used.
That leaves the owner to notice each new service, which is the kind of list D04 exists to
avoid.

The fix that needs no list is a firewall rule on the Mac (`pf`): from a VM's network, allow
DHCP and DNS to the Mac and block everything else to it. Open questions:

1. Whether minitart installs it (a `sudo` step, like Softnet's) or documents it.
2. How the rule names the VMs' networks: Softnet gives each VM its own small network and
   macOS names the interfaces as they come (`bridge100`, `bridge101`, …).
3. Whether `selftest` should then require it.

Forced by: the first run of `selftest` on Softnet, which found four open ports.
