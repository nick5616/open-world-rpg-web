# tools/soak/linux: the G5 soaks on dedicated Linux VMs

Gate G5 needs spec 14's four soak scenarios to pass. On the shared Windows
desktop scenario 1 and the thailand variants failed on machine noise
(`docs/decisions/v1-capacity.md`), so this directory runs the same soak
drivers (`tools/bots/scale-soak.mjs`, `handoff-soak.mjs`, the voice soak
`server/social/voice/voicebots`) on two temporary GCP VMs: one for the zones
(timed on dedicated cores), one for everything that loads them. Results:
`docs/evidence/g5-linux-*`, `docs/decisions/v1-capacity.md` "Dedicated Linux
measurement".

| VM | Type | Runs |
| --- | --- | --- |
| `lodestone-soak-zone` | c2d-standard-16 (AMD EPYC 7B13, 8 cores / 16 threads; SMT siblings are CPU n and n+8) | the zone processes only, pinned with `taskset` |
| `lodestone-soak-bots` | **c2d-standard-8** (the G5 runs started on a -16; 8 was enough for 1,000 bots) | bots, netsim proxies, director, Postgres + Redis + LiveKit containers, the soak drivers (Node 20) |

**Quota**: sw-viz has a global limit of 32 vCPUs (`CPUS_ALL_REGIONS`) and the live game VM
`lodestone-game` needs 2 of them to wake. Keep the soak VMs at <= 28 vCPUs together (16 + 8 = 24);
two c2d-standard-16 locked players out during the G5 runs until the bots VM was resized.

Both in us-central1-a, Ubuntu 24.04, label `purpose=g5-soak`, network tag
`lodestone-soak`; they talk over internal IPs (the default VPC's
`default-allow-internal`), and we reach them only by IAP SSH (a temporary
`lodestone-soak-iap-ssh` rule: 35.235.240.0/20, tcp:22). No ports are opened
to the internet. Cost: c2d-standard-16 ~$0.73/h + c2d-standard-8 ~$0.36/h
plus two small disks, ~$1.10 per hour of wall time; the G5 set (setup, 15
soak runs, teardown) took 68 minutes, ~$1.50.

## What changed in the drivers (flags only)

| Flag | Where | What |
| --- | --- | --- |
| `--bin-dir DIR` | scale-soak, handoff-soak, voicebots (`-bin-dir`) | prebuilt binaries instead of `go build` / `go run` (no Go toolchain on the VMs) |
| `--zone-host IP` (+ `--remote-dir`) | scale-soak, handoff-soak | start the zone(s) on that host over ssh (`tools/bots/remote.mjs`): each runs as a uniquely named copy in `/tmp`, its log streams back, and it is killed by that name (`SIGKILL` for the scenario 4 hard kill) |
| `--zone-cpus` | scale-soak (`0,1,8,9`), handoff-soak (`a;b;c;d`, one list per zone) | `taskset -c`; handoff-soak also sets each zone's `GOMAXPROCS` to its CPU count |
| `--infra-host IP` | handoff-soak | address the remote zones use for this machine's Postgres and Redis |
| `--bots-cpus` | scale-soak | `taskset` for the bots when they share the zone's machine |

On Linux, handoff-soak's hard kill is now `SIGKILL` (it was `killTree`,
which is `taskkill /F` on Windows but a graceful `SIGTERM` elsewhere).
Everything else (bots, netsim, verdicts, evidence format) is unchanged.

## Reproduce

From the repo root on the workstation (Git Bash), with `gcloud` logged in:

```bash
P="--project sw-viz --zone us-central1-a"
# 1. Build + stage: linux/amd64 binaries (zone, director, social, bots,
#    seedbots, mintworld, devdb, voicebots), worldgen.wasm, migrations,
#    the drivers and these scripts.
tools/soak/linux/build.sh /tmp/g5stage && tar -czf /tmp/g5stage.tgz -C /tmp/g5stage .

# 2. Resources (all temporary).
gcloud compute firewall-rules create lodestone-soak-iap-ssh --project sw-viz --network default \
  --source-ranges 35.235.240.0/20 --allow tcp:22 --target-tags lodestone-soak
for spec in zone:c2d-standard-16 bots:c2d-standard-8; do role=${spec%%:*}
  gcloud compute instances create lodestone-soak-$role $P --machine-type ${spec#*:} \
    --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud --boot-disk-size 30GB \
    --tags lodestone-soak --labels purpose=g5-soak --metadata soak-role=$role \
    --metadata-from-file startup-script=tools/soak/linux/vm-setup.sh
done
# vm-setup.sh: Docker + images + Node 20 on the bots VM, nofile limits, /opt/lodestone.

# 3. Copy and wire: bundle to the bots VM; an ssh key from the bots VM to the
#    zone VM (the drivers start zones with plain ssh); the bundle on to the
#    zone VM over the internal network.
gcloud compute scp /tmp/g5stage.tgz lodestone-soak-bots:/tmp/ $P --tunnel-through-iap
gcloud compute ssh lodestone-soak-bots $P --tunnel-through-iap --command \
  "tar -xzf /tmp/g5stage.tgz -C /opt/lodestone; chmod +x /opt/lodestone/bin/*; ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/soak; cat ~/.ssh/soak.pub"
gcloud compute ssh lodestone-soak-zone $P --tunnel-through-iap --command "echo '<that key>' >> ~/.ssh/authorized_keys"
gcloud compute ssh lodestone-soak-bots $P --tunnel-through-iap --command \
  "printf 'Host 10.*\n  IdentityFile ~/.ssh/soak\n' > ~/.ssh/config; scp -o StrictHostKeyChecking=no /tmp/g5stage.tgz <zone-ip>:/tmp/ &&
   ssh <zone-ip> 'tar -xzf /tmp/g5stage.tgz -C /opt/lodestone; chmod +x /opt/lodestone/bin/*'
   sudo docker run -d --name lodestone-soak-pg -e POSTGRES_USER=lodestone -e POSTGRES_PASSWORD=lodestone -e POSTGRES_DB=lodestone -p 55432:5432 postgres:16-alpine
   sudo docker run -d --name lodestone-soak-redis -p 56379:6379 redis:7-alpine redis-server --save '' --appendonly no
   cd /opt/lodestone/tools/netsim && npm install --no-audit --no-fund"

# 4. Run (on the bots VM, /opt/lodestone; ZONE_HOST=<zone internal ip>).
./run-s1.sh vcpu4-run1-clean 0,1,8,9            # scenario 1, zone on 4 vCPU (2 cores + SMT)
./run-s1.sh cores4-run1-clean 0-3               # scenario 1, zone on 4 physical cores
./run-s1.sh vcpu4-thailand 0,1,8,9 thailand     # scenario 4 / S1 (netsim proxy)
./queue-s1.sh                                   # all of the above, 3 runs each
./queue-rest.sh                                 # S2, S4/S2, S3, S4/voice, S1 under netem (resumable)
./run-s2.sh clean                               # scenario 2: 1,000 bots, 4 zones x 4 vCPU
./run-s2.sh thailand-failover                   # scenario 4 / S2 + hard kill of a pool zone
./run-s3.sh clean && ./run-s3.sh thailand       # scenario 3 and 4 / voice (LiveKit container)
sudo ./netem.sh on <peer-ip>                    # optional: real tc netem "thailand" between the VMs
                                                # (run on both VMs), then run-s1.sh ... clean

# 5. Evidence back, then delete EVERYTHING (also on failure).
gcloud compute scp "lodestone-soak-bots:/opt/lodestone/docs/evidence/g5-linux-*" docs/evidence/ $P --tunnel-through-iap
gcloud compute instances delete lodestone-soak-zone lodestone-soak-bots $P --quiet   # boot disks auto-delete
gcloud compute firewall-rules delete lodestone-soak-iap-ssh --project sw-viz --quiet
gcloud compute instances list --project sw-viz --filter="labels.purpose=g5-soak"      # must be empty
gcloud compute disks list --project sw-viz --filter="name~lodestone-soak"             # must be empty
```

The in-process benchmark can run on the zone VM too (`GOOS=linux go test -c
./server/zone/internal/game`, then `LODESTONE_BENCH_TERRAIN=1 taskset -c
<cpus> ./game.test -test.run '^$' -test.bench Scale/p300_e2000 -test.cpu 4
-test.benchtime 900x` from a directory below `/opt/lodestone`, so it finds
`worldgen/pkg/worldgen.wasm`). Since the 4 vCPU follow-up (`g5-tick-vcpu4`)
`build.sh` stages it as `bin/game.test`, and on the zone VM

```bash
cd /opt/lodestone && ./bench-inprocess.sh        # 3 runs each on 0,1,8,9 and 0-3, alternating
./bench-inprocess.sh 5 0,1,8,9                     # 5 runs, one CPU set
```

prints one `BenchmarkScale` line per run (tick p50/p99/max, phase means,
`snapshots-p99-ms`, `combat-p99-ms`, `cpu-ms` = process CPU per tick).
Compare with `docs/evidence/g5-linux-inprocess-bench.txt` (main @ 1d1f626) and
`docs/evidence/g5-linux-vcpu4-confirm-inprocess.txt` (main @ 7ac9da4, after the 4 vCPU follow-up).
`PREFIX=<name> ./run-s1.sh ...` names the evidence files `<name>-s1-<tag>.*` (default `g5-linux`); the
4 vCPU confirmation (`docs/evidence/g5-linux-vcpu4-confirm-summary.md`: 5 vcpu4 runs, 2 cores4, 1 vcpu4
thailand, 42 min, ~$0.80) used `g5-linux-vcpu4-confirm`.
The scale and handoff drivers now start their zones with
`LODESTONE_ZONE_NO_DEMONS=1` (night demons killed and teleported bots), and
zones default to GOGC 300 with a 3 GiB soft limit (`server/zone/gc.go`).

## Notes

- "4 vCPU" on a cloud VM is 2 physical cores with their SMT siblings
  (`0,1,8,9` here). Measured both that and 4 whole cores (`0-3`, siblings
  idle); the difference is the result (see the decision doc).
- netem: `tools/netsim/proxy.mjs` (the drivers' `--profile thailand`, run on
  the bots VM so the zone's cores never relay traffic) impairs the game
  sockets in user space; `netem.sh` impairs every packet between the VMs.
  Voice media under thailand is not impaired by the proxy (LiveKit runs on
  the bots VM next to the voice bots).
