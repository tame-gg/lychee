# Upstream

`native/netd` (the `lychee-netd` network helper) is a port of **net-merge** by Rohit Mahto.

- Source: https://github.com/rohit267/net-merge
- Base commit: `227c4dd` (v0.3.1)
- License: MIT (see `LICENSE-net-merge`, kept verbatim). The repo-root `NOTICE` credits it too.

## What was ported

The Go engine, unchanged in behaviour, with its tests:

- `internal/engine` — balancer, scheduler, probes, flow pinning. `socks5.go` is kept as code but
  no subcommand exposes it.
- `internal/nics` — adapter discovery, OS byte counters, `ForceEgress`.
- `internal/tun` — the virtual adapter, the gVisor stack, per-OS configure, `forward.go`, `CleanupStale`.
- `internal/platform` — `IsAdmin`, `CheckDriver`, single-instance locking, the `rootOnly`/`copyRootOwned`
  self-check helpers and the Windows scheduled-task XML.
- `internal/logx` — the shared log sink.
- `internal/control/autopause.go` (+ its test) — net-merge's `internal/tray/autopause.go`, moved
  unchanged into the control package, which drives the `paused_auto` state.

## What was dropped

`internal/tray`, `internal/icon`, `internal/state`, the `fyne.io/systray` and `godbus/dbus`
dependencies, the whole `cmd/net-merge` command line (`tray|run|on|off|quit|status|list|socks|autostart|install|uninstall`),
and `installer/`, `packaging/`, `nix/`. `lychee-netd` has exactly two subcommands, `serve` and
`version`, and one control path: the JSON channel of `docs/netd-control-channel.md`.

## Names changed in the port

So nothing of net-merge remains on a machine under its old name:

- TUN adapter `lychee-netd` (Linux, Windows; `utunN` on macOS).
- Wintun tunnel type `lychee-netd` with GUID `{1a9a5bf8-8341-44fd-89a9-04ed431a8997}`.
- Windows weak-host restore file `lychee-netd-weakhost.txt`.
- Single-instance locks `@lychee-netd` / `/var/run/lychee-netd.lock` / `Global\lychee-netd`.

net-merge's own lock names (`@net-merge`, `/var/run/net-merge.lock`, `Global\net-merge`) and its
adapter name are still recognised, only so the two tools refuse to run at once (they would install
the same `/1` routes). `nics.virtualName` skips both adapter names.

## Carrying an upstream fix over

There is no fork and no shared git history. To bring a later net-merge fix into this tree, read the
change at the upstream commit, apply the equivalent edit here by hand against the package layout
above, strip comments, and update the base commit noted in this file if the port is re-synced.
