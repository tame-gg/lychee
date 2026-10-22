# lychee-netd control channel

Specification of the local control channel between `lychee-netd`, Lychee's headless, privileged
network helper (started as `lychee-netd serve --control <path>`), and an unprivileged GUI client (the
Lychee Electron app's main process). The helper's engine was ported from net-merge (v0.3.1, `227c4dd`)
into this repository under `native/netd/`; `docs/netmerge-plan.md` is the plan this implements.

|                               |                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol version              | 1                                                                                                                                                                                                                                                                                                                                                                                                             |
| Document revision             | 2026-10-22, rev. 3: the deb/rpm helper is runnable by the installing user only (group `lychee`, mode `0750`) and a peer must be the socket's owner, root included, in 2.2, 3.3, 3.6, 10.6 and 11; rev. 2 (2026-10-19) added clarifications from the fake netd (#12) in 2.7, 4.1, 4.3, 6.2, 7.11, 7.14, 8.1, 8.2, 10.1 and Appendix B (draft for review; sections 2, 3 and 11 are the security review's scope) |
| Implements                    | plan items L-1 (helper) and L-3 (client) of `docs/netmerge-plan.md` in this repository (sections 3, 4, 6, 9, 13 and "Security requirements (from review)")                                                                                                                                                                                                                                                    |
| Code this was written against | `native/netd/cmd/lychee-netd/main.go`, `native/netd/internal/{engine,nics,tun,platform,logx}` and `native/netd/internal/control/autopause.go`, as ported from net-merge commit `227c4dd` (0.3.1). Paths below are relative to `native/netd/` unless they start with `native/`, `src/` or `docs/`.                                                                                                             |

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119. Text marked
_informative_ explains intent and does not bind implementations.

Contents

1. [Overview](#1-overview)
2. [Transport](#2-transport)
3. [Authentication and threat model](#3-authentication-and-threat-model)
4. [Framing](#4-framing)
5. [Versioning and the hello handshake](#5-versioning-and-the-hello-handshake)
6. [Message envelope](#6-message-envelope)
7. [Commands](#7-commands)
8. [Events and the stats stream](#8-events-and-the-stats-stream)
9. [Error codes](#9-error-codes)
10. [Lifecycle and state machines](#10-lifecycle-and-state-machines)
11. [Security checklist](#11-security-checklist)
12. [Test plan](#12-test-plan)

- [Appendix A: SlotStats field mapping](#appendix-a-slotstats-field-mapping)
- [Appendix B: example session](#appendix-b-example-session)
- [Appendix C: TypeScript sketch](#appendix-c-typescript-sketch)

---

## 1. Overview

### 1.1 What this is

`lychee-netd` is Lychee's privileged network service: the connection-merging engine of net-merge
(`internal/engine`, `internal/tun`, `internal/nics`), ported into this repository under `native/netd/`
and built and shipped by Lychee itself. net-merge was controlled through marker files and a status file
in a per-user directory (its `internal/state`), polled by its tray. That protocol had no status while
merging was paused, no runtime toggles for IPv6, autopause, adapter selection or weights, no error
reporting and no authentication beyond directory permissions (plan section 1.7). It is not ported. A GUI
needs a real control channel.

This document specifies that channel: `lychee-netd serve --control <path>` runs the engine headless and
serves a small JSON protocol over a local, user-restricted transport. The GUI client turns merging on
and off, adjusts the few runtime options net-merge's tray exposed, and receives a per-adapter statistics
stream for its "total combined speed" and "speed from each source" display. `lychee-netd version`,
which prints the build's version and exits, is the only other subcommand.

### 1.2 Goals

- One privileged helper process per machine, started by the client, controlled only by the user who
  started it, exiting when that client goes away.
- Everything net-merge's tray could do (its `internal/tray/tray.go`, not ported) is available as a
  command: on, off, IPv6 mode, autopause, quit. Additionally: exclude/include adapters, per-adapter weights, adapter listing with skip
  reasons, stale-route cleanup.
- A statistics stream that is emitted whether merging is on or off, so the client can show live
  per-adapter speeds (from the OS counters) at all times.
- A protocol strict enough to be reviewed as a privilege boundary: fixed command allowlist, strict
  decoding, no client-supplied strings reaching a shell, an exec call or a file path.
- Testable without privileges: the server logic is exercised in Go unit tests with a temporary-directory
  socket and a fake engine.

### 1.3 Non-goals

- Localhost TCP, remote control, or any transport other than the ones in section 2. There is no
  fallback transport.
- More than one client session at a time.
- Token, password or certificate authentication. Peer credentials are the only mechanism.
- Persisting settings in the helper. The client persists its settings and re-applies them after every
  helper start (section 10.6).
- Changing the MTU, the rescan interval, probe targets or the TUN addresses at runtime.
- Force-including an adapter that discovery skipped (a VPN, a bridge). `exclude`/`include` only act on
  adapters that `nics.DiscoverNicsDetailed` returns as usable.
- Privilege separation inside the helper (dropping to the user after setup). Possible future hardening.
- The SOCKS5 front end (`engine.ServeSocks5` stays in the package as code; no subcommand exposes it) and
  a system proxy mode (plan option C).
- Windows arm64. The helper is built and tested for Windows x64 only for now; the arm64 Windows build of
  Lychee ships without it and shows "Unsupported here" (plan section 4).
- A command-line interface. `lychee-netd` has exactly two subcommands, `serve` and `version`: no on,
  off or status command, no status file, no marker files (section 10.7).

### 1.4 Terminology

| Term                       | Meaning                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| helper                     | The process started as `lychee-netd serve --control <path>` (`lychee-netd.exe` on Windows). Runs with root (macOS, Linux via `pkexec`/`sudo`), `CAP_NET_ADMIN` (Linux via `setcap`), or an elevated token (Windows). Owns the TUN, the scheduler and the single-instance lock. |
| client                     | The unprivileged process that connects to the control path: Lychee's Electron main process. Only the user who launched the helper is authorized.                                                                                                                               |
| connection                 | One accepted transport connection that passed the peer-credential check (section 3).                                                                                                                                                                                           |
| session                    | A connection on which the `hello` handshake succeeded. At most one session exists at a time.                                                                                                                                                                                   |
| authorized principal       | The uid (Linux, macOS) or user SID (Windows) allowed to open a session. Determined at helper start (section 3).                                                                                                                                                                |
| merging / capture          | The TUN adapter and its `/1` routes are installed, so new flows of every app are balanced (`tun.On`).                                                                                                                                                                          |
| grace period               | The time the helper keeps running after its session drops without a `quit`, waiting for the client to reconnect (section 10.3).                                                                                                                                                |
| request / response / event | The three message kinds (section 6). Requests flow client to helper; responses and events flow helper to client.                                                                                                                                                               |

### 1.5 Protocol constants

All constants are normative and are also reported in the `hello` response so a client never hard-codes
them.

| Constant                                                                 | Value                           |
| ------------------------------------------------------------------------ | ------------------------------- |
| Protocol version                                                         | `1`                             |
| Maximum frame size (either direction, including the terminating newline) | 65536 bytes (64 KiB)            |
| Maximum unanswered requests per session                                  | 16                              |
| `hello` timeout after connect                                            | 5000 ms                         |
| Connections awaiting `hello` at the same time                            | 4                               |
| Startup timeout (listening without any authorized connection)            | 30000 ms                        |
| Reconnect grace period                                                   | 10000 ms                        |
| Stats interval (`subscribe`)                                             | 250 to 5000 ms, default 1000 ms |
| Outbound queue per session                                               | 64 frames                       |
| Write stall limit (client not reading)                                   | 30000 ms                        |
| Manual weight range                                                      | 0.05 to 100 inclusive           |
| Deadline for `on`, `off`, `cleanup` inside the helper                    | 30 s                            |
| Maximum adapters in one `stats` event or `status` response               | 64 present plus 64 skipped      |
| Maximum length of any string in a request                                | 256 bytes                       |

### 1.6 Relationship to the ported code (informative)

- `serve` reuses what net-merge's `common.boot` did in its `cmd/net-merge/main.go` (discovery,
  `Scheduler`, `Balancer`, probes, 3 s rescan, 1 s `Tick`), now in `cmd/lychee-netd/main.go`, but must
  not `die` with zero adapters: it runs and reports an empty adapter list until something appears.
- `autoPauser` lives in `internal/control/autopause.go`, moved unchanged (with its test) from net-merge's
  `internal/tray` in plan item L-1, and drives the `paused_auto` state exactly as it drove the tray.
- `exclude`/`include` become a mutable set consulted by the rescan loop before `Scheduler.Update`;
  `set_weight` becomes a per-slot override in `Scheduler` (upstream `SetAuto` is all-or-nothing).
- The helper takes Lychee's single-instance lock (`platform.SingleInstance` with the names of section
  10.7) and also refuses to start while a standalone net-merge holds its lock, so two merging tools never
  run at once.

---

## 2. Transport

### 2.1 Common rules

- macOS and Linux: a Unix domain stream socket (`AF_UNIX`, `SOCK_STREAM`) at the path given by
  `--control`. Windows: a named pipe whose name is given by `--control`.
- There is no TCP listener of any kind. `lychee-netd` has no `-pprof` flag (net-merge's was not ported).
- `serve` accepts exactly one flag, `--control <path>` (`-control` is the same flag to Go's `flag`
  package). Any other argument is a usage error: the helper prints usage to stderr and exits with code 2.
  `lychee-netd` has no `-log`, `-include`, `-weight`, `-ipv6`, `-state-dir` or `-mtu` flag at all
  (net-merge's CLI flags were not ported). Everything the client wants to change is changed over the
  channel after `hello`.
- The helper validates the control path against the rules of its platform and privilege level before
  creating anything (sections 2.2 to 2.4). A path that fails validation is a refusal: exit code 3, a
  one-line reason on stderr, nothing created.
- Diagnostics go to stderr when stderr is open (sudo and pkexec pass stdio through; an elevated Windows
  child has none). The session also receives `log` events (section 8.4). The helper never opens a log
  file itself.

### 2.2 Linux

Two privilege models exist, and the client chooses the path according to how it launched the helper.

| Launched as                                                                                                        | Privilege    | Control path                        | Directory                                                 | Socket file                              |
| ------------------------------------------------------------------------------------------------------------------ | ------------ | ----------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| the user, a member of group `lychee`; binary `root:lychee`, mode `0750`, `cap_net_admin,cap_net_raw+ep` (deb, rpm) | capabilities | `$XDG_RUNTIME_DIR/lychee/netd.sock` | `$XDG_RUNTIME_DIR/lychee`, mode `0700`, owned by the user | mode `0600`, owned by the user           |
| root via `pkexec` or `sudo` (AppImage, no capabilities)                                                            | root         | `/run/lychee-netd/netd.sock`        | `/run/lychee-netd`, mode `0755`, owned by `root:root`     | mode `0600`, owned by the authorized uid |

Rules when the helper runs as root (effective uid 0):

1. The control path MUST be exactly `/run/lychee-netd/netd.sock`. Any other path is refused
   (exit 3). This is what keeps a root helper from ever unlinking or creating a file at a caller-chosen
   location.
2. The helper creates `/run/lychee-netd` with mode `0755` if it does not exist. Whether it created
   it or not, it then checks with `lstat` that the path is a directory (not a symlink), owned by uid 0,
   with no group or world write bit. `/run` is checked the same way. Any failure is a refusal.
3. The authorized uid is taken from the environment as described in section 3.2.

Rules when the helper runs as the user with capabilities:

1. `$XDG_RUNTIME_DIR` MUST be set to an absolute path that is, by `lstat`, a directory owned by the
   helper's uid with no group or world permission bits (systemd creates it as `0700`). If it is not set
   or fails the check, the helper refuses (exit 3). The client then falls back to the root launch.
2. The control path's parent directory (`$XDG_RUNTIME_DIR/lychee` in production) is created with mode
   `0700` if missing, then checked with `lstat`: a directory, owned by the helper's uid, no group or world
   bits. The helper does not require the production path here, only these checks, so tests can use a
   temporary directory.
3. The authorized uid is the helper's own uid.

The deb and rpm packages install the helper at `/usr/lib/lychee/lychee-netd` owned by `root:lychee`
with mode `0750` and the capabilities set (`build/linux/after-install.sh`, on every install and
upgrade, since replacing the file drops its capabilities). The script creates the system group
`lychee` when it is missing and adds the installing user, taken from `SUDO_UID` or else `PKEXEC_UID`,
to it; the membership applies from that user's next login. Any other user cannot execute the file, and
Lychee passes it over for the copy under the app's resources, which has no capabilities and so ends in
the `pkexec` launch (section 10.6).

### 2.3 macOS

The helper always runs as root, started through the sudoers rule that `Lychee`'s one-time setup
installs (section 3.3).

| Item                  | Value                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Helper binary         | `/Library/PrivilegedHelperTools/gg.tame.lychee.netd`, owned by `root:wheel`, mode `0755` |
| Exact argument vector | `serve --control /var/run/lychee-netd/netd.sock`                                         |
| Directory             | `/var/run/lychee-netd`, mode `0755`, owned by `root:wheel`                               |
| Socket file           | mode `0600`, owned by the authorized uid (`SUDO_UID`)                                    |

Rules:

1. The control path MUST be exactly `/var/run/lychee-netd/netd.sock` (exit 3 otherwise).
2. The directory is created `0755` if missing and checked with `lstat` as in Linux rule 2. The parent
   chain is checked with `rootOnly`-style ownership checks (`internal/platform/install_darwin.go`):
   every component of both `/var/run/lychee-netd` and its symlink-resolved form
   (`/private/var/run/lychee-netd`) MUST be owned by root and MUST NOT be group or world writable.
3. Before anything else, the helper checks its own binary (section 3.3, "self-check"). A helper that is
   not root-owned, or that sits under a directory writable by non-root, refuses to start.
4. The authorized uid is `SUDO_UID` (section 3.2).

### 2.4 Windows

| Item      | Value                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------- |
| Pipe name | `\\.\pipe\lychee-netd-<SID>` where `<SID>` is the authorized user's SID in string form (`S-1-5-21-...`) |
| Example   | `\\.\pipe\lychee-netd-S-1-5-21-1004336348-1177238915-682003330-1001`                                    |

Rules:

1. The authorized SID is the user SID of the helper's own process token (`TokenUser`). This equals the
   SID of the user running Lychee only when that user is an administrator: a UAC _consent_ prompt
   elevates the same account, and a scheduled task registered by that account runs as it. On a standard
   (non-administrator) account the UAC _credential_ prompt elevates as whichever administrator typed
   their password, so the helper's token user, pipe name and DACL belong to that administrator and
   Lychee, running as the standard user, cannot connect (`CreateFile` on the pipe fails with
   `ERROR_ACCESS_DENIED`; were it to get through, rule 6 would fail). This fails safe: no other user can
   control the helper, the client cannot connect, and nothing is captured, because merging is off until
   an `on` request arrives (section 10.1) and off by default in Lychee. It is still a dead end, so the
   client MUST detect it before and after launching (section 10.6) and explain it ("Combining
   connections system-wide needs an administrator account on this PC") instead of reporting the helper
   as unavailable.
2. The helper computes the expected name from that SID and MUST refuse to start (exit 3) if `--control`
   is not exactly that name. The client builds the same name from its own SID.
3. The pipe is created with `CreateNamedPipeW` and:
   - open mode `PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE` (the
     latter only on the first instance);
   - pipe mode `PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS`;
   - at most 4 instances (the pending-connection cap);
   - a protected security descriptor (`SE_DACL_PROTECTED`, no inherited ACEs) whose DACL contains
     exactly two allow ACEs: the authorized (logged-in) user's SID with `GENERIC_READ | GENERIC_WRITE`
     and `NT AUTHORITY\SYSTEM` with `GENERIC_ALL`. There is no `BUILTIN\Administrators` ACE and nobody
     else has an entry. The owner is the authorized SID. The DACL MUST NOT contain an explicit deny ACE
     for Everyone: deny ACEs are evaluated first and would also deny the two listed principals. Absence
     of an ACE is the denial. Equivalent SDDL: `O:<SID>D:P(A;;GRGW;;;<SID>)(A;;GA;;;SY)`.
4. If `CreateNamedPipeW` with `FILE_FLAG_FIRST_PIPE_INSTANCE` fails with `ERROR_ACCESS_DENIED` or
   `ERROR_PIPE_BUSY`, the name already exists (another helper, or a squatter): exit 5. The helper never
   attaches to an existing pipe.
5. After every `ConnectNamedPipe`, the peer check of section 3.4 runs before any byte is read.
6. The client MUST verify the server before sending anything: `GetNamedPipeServerProcessId` on its
   handle, open that process with `PROCESS_QUERY_LIMITED_INFORMATION`, read its token user SID and
   compare it with the client's own SID. A mismatch means a squatted name; the client closes the handle
   and reports "helper unavailable" instead of talking. (A helper that belongs to another administrator,
   rule 1, never gets this far: its DACL refuses the `CreateFile`; section 10.6 tells the two apart.)
7. Elevated token. A scheduled task with `RunLevel HighestAvailable` gives a standard user a limited
   (non-elevated) token, which cannot create the Wintun adapter or add routes. Before any other step,
   `serve` MUST check that its token is elevated (`TokenElevation`) and that `CheckTokenMembership`
   against `BUILTIN\Administrators` (`S-1-5-32-544`) succeeds; otherwise it exits 6 (`needs_admin`,
   section 2.7) without creating anything. The client maps exit 6 to the same administrator-account
   message as rule 1.

### 2.5 Creation order on Unix

The order is normative because it is what removes the windows in which someone else could connect or
could have planted something.

1. Probe net-merge's lock names, then take the single-instance lock (`platform.SingleInstance`, section
   10.7). Either held: exit 4, "another connection-merging tool is running".
2. Validate or create the directory (sections 2.2, 2.3).
3. Handle a pre-existing path (section 2.6).
4. Set the process umask to `0077`, `bind()` the socket (the file is created `0600`), then restore the
   umask. Then `chmod` the path to `0600` explicitly (umask is a belt; this is the braces).
5. When running as root, `chown` the socket file to the authorized uid, group unchanged (`chown(uid,
-1)`). With mode `0600` the group is irrelevant.
6. `listen()`. Nobody can connect before this call; between `bind()` and `listen()` a `connect()` gets
   `ECONNREFUSED`.
7. Start the accept loop and the startup timer (section 10.2).

### 2.6 Stale socket handling (Unix)

Before `bind()` the helper `lstat`s the control path.

| `lstat` result                                                                                          | Action                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| does not exist                                                                                          | continue                                                                                                                                                                   |
| a socket (`S_IFSOCK`) owned by the expected owner (root when the helper is root, else the helper's uid) | `connect()` to it. `ECONNREFUSED`: nobody listens, it is stale: `unlink` and continue. Success or any other error: another helper is live or the state is unclear: exit 4. |
| a socket owned by anyone else                                                                           | refuse, exit 3                                                                                                                                                             |
| anything else (regular file, directory, symlink, device)                                                | refuse, exit 3                                                                                                                                                             |

The helper never follows a symlink at the control path and never unlinks anything but a socket it could
have created itself. A pre-existing path is never reused.

In the root case the directory is root-owned and `0755`, so only root can create or replace entries in
it: there is no race between the `lstat` and the `unlink`/`bind`. In the user case the directory is
`0700` and owned by the user, so only the user (trusted, section 3.6) can race it.

At shutdown (section 10.4) the helper unlinks the socket only if `lstat` still shows a socket with the
same inode it created.

### 2.7 Exit codes

Exit codes are process outcomes observed by whoever launched the helper (the client's launcher), not
frames on the channel; a client sees them through its launch API, never through a response.

| Code | Meaning                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | normal exit: `quit`, SIGTERM/SIGINT/SIGHUP, grace period expired, or startup timeout with no client                                       |
| 2    | usage error (wrong arguments)                                                                                                             |
| 3    | refused: missing privilege (Unix; on Windows a non-elevated token is 6), failed self-check, no authorized principal, invalid control path |
| 4    | another `lychee-netd`, or a standalone net-merge, holds a single-instance lock or a live socket                                           |
| 5    | the transport could not be created (bind/listen failed, pipe name taken)                                                                  |
| 6    | `needs_admin` (Windows): the process token is not elevated or not a member of Administrators (section 2.4 rule 7)                         |

The client maps 3 to "needs permission / not installed", 4 to "another connection-merging tool is
running", 5 to "helper unavailable, retry" and 6 to "Combining connections system-wide needs an
administrator account on this PC".

---

## 3. Authentication and threat model

### 3.1 Principle

Authentication is the operating system's peer-credential mechanism on a local transport whose
filesystem or object permissions already restrict who can connect. There are no tokens, passwords or
nonces. Every accepted connection is checked before the helper reads a single byte from it; a
connection that fails the check is closed without any response bytes, and the rejection is logged with
the peer's uid or SID and pid.

The check is the same on every connection, including reconnects during the grace period and
connections that will be refused as `busy`.

### 3.2 Authorized principal on Linux and macOS

The authorized uid is determined once, at start, in this order:

1. `PKEXEC_UID`, if set (the helper was started by `pkexec`, which clears the environment and sets this
   itself).
2. Otherwise `SUDO_UID`, if set (the helper was started by `sudo`, which resets the environment and sets
   this itself).
3. Otherwise the helper's own real uid. For a helper started as the user with capabilities this is the
   user; for a helper started directly as root with neither variable (a root CI container) it is 0, so
   only root peers can connect.

A value that is present MUST parse as a decimal integer in `0` to `2^31-1` with no other characters;
anything else is a refusal (exit 3). No other environment variable is consulted by the helper, with the
exception of `XDG_RUNTIME_DIR` in the Linux user case (section 2.2).

On macOS the production launch is exactly
`sudo -n /Library/PrivilegedHelperTools/gg.tame.lychee.netd serve --control /var/run/lychee-netd/netd.sock`
under the sudoers rule of section 3.3, so step 2 always applies and `SUDO_UID` is the GUI user's uid.

### 3.3 Peer check on Linux and macOS

Immediately after `accept()`, before the first `read()`:

|             | Linux                                                            | macOS                                                                                                                                               |
| ----------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Call        | `getsockopt(SOL_SOCKET, SO_PEERCRED)` giving `uid`, `gid`, `pid` | `getsockopt(SOL_LOCAL, LOCAL_PEERCRED)` giving `xucred.cr_uid` (equivalently `getpeereid`), plus `getsockopt(SOL_LOCAL, LOCAL_PEERPID)` for the pid |
| Accept when | `uid == authorized uid`, and `pid != 0`                          | `cr_uid == authorized uid`                                                                                                                          |
| Otherwise   | close immediately, log `peer rejected uid=<uid> pid=<pid>`       | same                                                                                                                                                |

`pid == 0` on Linux means the peer lives in a pid namespace the helper cannot see; such peers are
rejected. The pid is for logging and for the `busy` error's `session_pid`; it is not an authorization
input on either platform.

Only the socket's owner is accepted: a root peer is refused like any other uid unless the authorized
uid is 0. Root can read the socket regardless, so the refusal costs nothing; what it buys is a single
rule on every path, capabilities, `pkexec` and `sudo` alike.

**macOS sudoers rule and self-check (S2).** Lychee's one-time setup (an admin prompt) copies the helper
to `/Library/PrivilegedHelperTools/gg.tame.lychee.netd` with `copyRootOwned` semantics
(`internal/platform/install_darwin.go`: temporary file, `chown 0:0`, mode `0755`, rename; refused if
any parent directory is writable by non-root) and installs `/etc/sudoers.d/lychee-netd`, mode `0440`,
owned by `root:wheel`, validated with `visudo -cf` on the temporary file before it is moved into place.
The file's content is written exactly, byte for byte, as these two lines (one comment, one rule, a
newline after each, nothing else):

```
# Written by Lychee: <user> may start the network helper without a password.
<user> ALL=(root) NOPASSWD: /Library/PrivilegedHelperTools/gg.tame.lychee.netd serve --control /var/run/lychee-netd/netd.sock
```

`<user>` is the installing user's short name, validated against `^[A-Za-z0-9._-]+$`. The rule MUST
match the exact argument vector as well as the binary path: no wildcards, no trailing `*`, no `""`
empty-arguments variant. sudo compares the command line exactly, so any other subcommand (including
`version`), flag, control path or binary path is refused (with `-n`, refused outright instead of
prompting). Consequently Lychee's launch MUST be exactly
`sudo -n /Library/PrivilegedHelperTools/gg.tame.lychee.netd serve --control /var/run/lychee-netd/netd.sock`
(no extra arguments, no environment options, no shell). Lychee re-reads and byte-compares the installed
file before relying on it: the elevated setup step reads `/etc/sudoers.d/lychee-netd` back immediately
after the rename and compares it with the content above (with `<user>` substituted), failing the setup on
any difference, a mode other than `0440` or an owner other than `root:wheel` (the file is unreadable to
the GUI user, so this is where a byte comparison is possible); and before every launch the unprivileged
client runs `sudo -n -l` with that exact command line, which succeeds only if sudo itself accepts it.
Anything else is "helper not installed" and offers the setup again rather than attempting the launch.
`cleanup` is not in the rule; it is performed over the channel (section 7.13).

At start, when its effective uid is 0, the helper MUST verify its own binary before doing anything
else: `os.Executable()`, resolved through symlinks, MUST be a regular file owned by uid 0 whose mode has
no group or world write bit, and every directory above it (unresolved and resolved path) MUST be owned by
uid 0 with no group or world write bit. On failure the helper exits 3 without creating anything. This
is the `rootOnly` check from `install_darwin.go` applied to the running binary; it is also applied on
Linux when the helper runs as root (where `pkexec` runs whatever path the user names, this check is
advisory: see section 3.6).

### 3.4 Peer check on Windows

After each `ConnectNamedPipe` completes and before the first `ReadFile`:

1. `GetNamedPipeClientProcessId(pipe)` gives the client pid.
2. `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)`, then `OpenProcessToken(TOKEN_QUERY)`,
   then `GetTokenInformation(TokenUser)`.
3. `EqualSid(client user SID, authorized SID)` MUST be true. Nothing else is accepted: not SYSTEM, not
   other members of Administrators. (They can take the machine over by other means; the check is about
   never confusing one user's session with another's.)
4. On any failure (the process cannot be opened, the token cannot be read, the SID differs):
   `DisconnectNamedPipe`, close the instance, log `peer rejected pid=<pid> sid=<sid or "?">`.

Implementations MAY additionally impersonate the pipe client (`ImpersonateNamedPipeClient`,
`OpenThreadToken`, `RevertToSelf`) and compare that token's user SID, which binds the identity to the
connection rather than to a pid; if they do, both checks MUST pass.

The DACL (section 2.4) already keeps other users out at `CreateFile` time. The SID check is what
matters when the DACL is wrong, and it is what the tests exercise.

**Administrator account requirement (S2).** The authorized SID is the helper's own token user (section
2.4 rule 1). When a standard account's UAC credential prompt elevates the helper as another
administrator, that administrator's SID is the authorized one, the pipe carries it in its name and DACL,
and the standard user's Lychee process is correctly refused at `CreateFile`; the peer check above would
also reject it. Nothing is captured, because merging is off until an `on` request arrives and off by
default in Lychee. The client's job is to recognise the situation (section 10.6) and say "Combining
connections system-wide needs an administrator account on this PC"; the helper's job is rule 7 of
section 2.4: refuse to run with a non-elevated token (exit 6) instead of failing later at adapter
creation.

### 3.5 Control path validation summary

| Check                                                    | Root helper (Linux, macOS)      | User helper (Linux)                 |
| -------------------------------------------------------- | ------------------------------- | ----------------------------------- |
| Path is exactly the fixed production path                | MUST                            | not required (tests use a temp dir) |
| Directory exists, is a directory by `lstat` (no symlink) | MUST                            | MUST                                |
| Directory owner                                          | uid 0                           | helper's uid                        |
| Directory mode                                           | no group/world write (`0755`)   | no group/world bits at all (`0700`) |
| Parent chain root-owned, no group/world write            | MUST (`rootOnly`)               | not required                        |
| `$XDG_RUNTIME_DIR` owned by uid, mode `0700`             | n/a                             | MUST (production path)              |
| Pre-existing path handling                               | section 2.6                     | section 2.6                         |
| Socket mode after creation                               | `0600`, owned by authorized uid | `0600`, owned by the user           |

### 3.6 Threat model

What the channel defends against, what it does not, and why.

| Actor or situation                                                                                                     | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Mechanism              |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Another local user, or malware running as another user, tries to connect                                               | Cannot connect: Unix socket mode `0600` in a directory they cannot write; Windows DACL without their SID. If they get a connection anyway, the peer check rejects it before any byte is read.                                                                                                                                                                                                                                                                                                                                                                 | Sections 2 and 3.3/3.4 |
| Another local user runs the capability helper for themselves                                                           | Cannot on deb/rpm: the binary is `root:lychee` `0750` and only the installing user is in `lychee` (section 2.2). They get the `pkexec` launch, which asks for an administrator password, and the helper it starts serves only their uid.                                                                                                                                                                                                                                                                                                                      |
| Another local user tries to pre-create the control path ("squatting")                                                  | Unix root case: impossible, the directory is root-owned `0755`. Unix user case: impossible, `$XDG_RUNTIME_DIR` is `0700`. Windows: the name is global; a squatter makes the helper fail with exit 5 instead of joining the pipe (`FILE_FLAG_FIRST_PIPE_INSTANCE`), and the client refuses to talk to a server whose process SID is not its own (section 2.4 rule 6). Denial of service by a co-located user is possible on Windows and is accepted.                                                                                                           | 2.4, 2.6               |
| Symlink planted at the control path or in its directory                                                                | Never followed: `lstat` everywhere, a symlink is a refusal, `unlink` only of a socket owned by the expected owner in a directory only that owner can write. Root helpers only operate on a fixed path in a root-owned chain, so no user-controlled component exists.                                                                                                                                                                                                                                                                                          | 2.2, 2.3, 2.6          |
| A process running as the authorized user (including malware as that user)                                              | **Trusted.** It can turn merging on and off, exclude adapters, change weights and quit the helper. It can also create further instances of the Windows pipe (the user ACE must include `GENERIC_WRITE`, which carries `FILE_CREATE_PIPE_INSTANCE`) and race the client. The channel does not protect the user from their own account. What it guarantees even then: no operation exists that takes a path, a program name or free-form text that reaches a shell, `exec`, or the filesystem, so a same-user compromise gains no privilege through the helper. | 7, 11                  |
| Root / SYSTEM / an elevated administrator                                                                              | Trusted; they can do everything the helper can without it. Root peers are still refused on Unix (section 3.3): the channel has one rule, the socket's owner.                                                                                                                                                                                                                                                                                                                                                                                                  |
| The helper binary or a parent directory is replaced by the user (macOS sudoers; Windows scheduled task; Linux deb/rpm) | The sudoers rule only names a root-owned path; install-time `copyRootOwned` and the runtime self-check refuse a non-root-owned binary or a user-writable parent. Windows: the elevated copy step places the helper in `%ProgramFiles%\Lychee\helper`, verifies its ACL (only SYSTEM and Administrators may write) and the helper's signature or SHA-256, and the task points only there. Linux deb/rpm: `/usr/lib/lychee/lychee-netd` owned by `root:lychee`, mode `0750`, with `setcap`.                                                                     | plan section 4         |
| Linux AppImage via `pkexec`                                                                                            | The binary runs from a user-writable location. Accepted because `pkexec` asks for the administrator password on every start, so a swapped binary gains nothing the user does not type the password for. The self-check of 3.3 cannot be satisfied there and is skipped when the resolved executable is not root-owned _and_ `PKEXEC_UID` is set; it still logs a warning.                                                                                                                                                                                     | plan section 4         |
| The one-time privileged install step itself (macOS admin prompt copying from the app bundle, Windows elevated copy)    | Trusts the helper binary inside the bundle at that moment. A same-user attacker who already modified the bundle before the user approves the prompt gets root/admin at that step. Inherent to any admin-prompted install from a user-writable location; mitigated by the hash/signature verification in the copy step and fixed properly by code signing plus `SMAppService`. Flagged for S2.                                                                                                                                                                 | plan section 4         |
| A standard Windows account whose UAC credential prompt elevated the helper as another administrator                    | The helper belongs to that administrator: its pipe name and DACL carry the administrator's SID, the standard user's Lychee cannot open it, and merging stays off. Fails safe; the client detects it and asks for an administrator account (sections 2.4, 10.6). A `RunLevel HighestAvailable` task started by a standard user yields a limited token: the helper exits 6 at start.                                                                                                                                                                            | 2.4, 2.7, 10.6         |
| A standalone net-merge installed on the same machine                                                                   | Both tools would install the same `/1` routes. The helper probes net-merge's lock names and exits 4 while one is held; its own adapter name and Wintun GUID differ from net-merge's, so the adapters never collide.                                                                                                                                                                                                                                                                                                                                           | 10.7                   |
| Malformed, oversized or flooding input from the authorized user                                                        | Bounded: 64 KiB frames, 16 unanswered requests, 4 pending connections, 5 s `hello` timeout, 30 s write stall limit, strict decoding. Errors close the connection where the decoder cannot recover.                                                                                                                                                                                                                                                                                                                                                            | 4, 9                   |
| Information disclosure                                                                                                 | Stats expose adapter names, addresses and traffic rates to the authorized user only. The helper never reveals environment, file contents or other users' data.                                                                                                                                                                                                                                                                                                                                                                                                | 8                      |
| Environment manipulation                                                                                               | `sudo` and `pkexec` sanitize the environment. The helper reads only `PKEXEC_UID`, `SUDO_UID` and (user case) `XDG_RUNTIME_DIR`. System tools are run by absolute path (`/sbin/route`, `/sbin/ifconfig`, `/usr/sbin/networksetup`; on Windows `%SystemRoot%\System32\netsh.exe`, `route.exe`, `WindowsPowerShell\v1.0\powershell.exe`) with arguments built only from constants and discovery results, never from client input.                                                                                                                                | 11                     |
| Crash of the helper                                                                                                    | The TUN is a file descriptor: adapter and routes vanish with the process on all three platforms. Residue: macOS scoped default routes and the Windows weak-host restore file, cleaned at the next start and by `cleanup`. The socket file stays and is handled as stale next time.                                                                                                                                                                                                                                                                            | 10.5                   |
| Out of scope                                                                                                           | Kernel or driver vulnerabilities (TUN, Wintun), physical access, other software that also installs `/1` routes (Tailscale exit nodes), and anything a root or SYSTEM attacker can do.                                                                                                                                                                                                                                                                                                                                                                         |

---

## 4. Framing

### 4.1 JSON Lines

- The byte stream in each direction is a sequence of frames. A frame is one JSON value encoded in
  UTF-8 followed by a single `\n` (0x0A). No `\r`, no BOM, no NUL bytes anywhere.
- Each frame MUST be a JSON object (RFC 8259). Any other top-level value is a protocol error.
- A frame that consists of only `\n` (an empty line) MUST be ignored by both sides.
- The newline is the only delimiter. A `\n` cannot occur inside a JSON string unescaped, so no
  escaping scheme beyond JSON's own is needed.
- Maximum frame size is 65536 bytes including the newline, in both directions. The helper MUST size its
  own frames to fit: `stats` and `status` carry at most 64 adapters and 64 skipped entries, and strings in
  them are at most 256 bytes.
- Requests MUST NOT contain duplicate object keys. The helper MAY reject them; it is not required to
  detect them (Go's decoder keeps the last value).
- Key order is not significant. Both sides MAY emit object keys in any order, and clients MUST NOT
  depend on the order of keys in any frame. The examples in this document use one fixed order for
  readability only; a test that compares frames as strings (such as the fake helper's Appendix B
  replay) relies on the fake's own order, not on the real helper's.
- Numbers: integers are JSON numbers without fraction or exponent and fit in `[-(2^53-1), 2^53-1]` so
  JavaScript clients can use `number`. Rates and counters are integers; weights are JSON numbers with
  an optional fraction.

### 4.2 Decoding errors

| Condition                                                                                            | Helper behaviour                                                            |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A line longer than 65536 bytes (detected before the newline arrives)                                 | send `{"id":null,"ok":false,"error":{"code":"frame_too_large",...}}`, close |
| Invalid UTF-8 or a NUL byte                                                                          | `bad_request`, close                                                        |
| Not valid JSON, or valid JSON that is not an object                                                  | `bad_request`, close                                                        |
| An object without a valid `id` or `cmd` (section 6.1)                                                | `bad_request` with `"id": null` (or the id if it was valid), close          |
| A valid envelope with an unknown command                                                             | `unknown_command`, connection stays open                                    |
| A valid envelope with an unknown field anywhere in the request, including inside `args`              | `unknown_field`, stays open                                                 |
| A valid envelope whose `args` have a missing required field, a wrong type, or an invalid enum string | `bad_request`, stays open                                                   |
| A valid envelope whose number is outside its documented range                                        | `out_of_range`, stays open                                                  |

On a connection that has not completed `hello`, every error closes the connection, whatever the table
says (section 5.2): there is no session to keep.

"Close" means: the error frame is written, the write side is shut down and the connection is closed.
If the connection was the session, the grace period starts (section 10.3). Clients MUST treat the close
as fatal for that connection and reconnect.

The client applies the same frame limit when reading. A helper frame over the limit or not parseable
is a bug; the client SHOULD log it, close and reconnect.

### 4.3 Pipelining and in-flight limit

- Requests are processed strictly in the order received, one at a time, including long-running ones
  (`on`, `off`, `cleanup`). Responses are therefore sent in request order.
- A client MAY send further requests before receiving responses. At most 16 requests may be unanswered
  at any time. The helper reads ahead into a queue of that size. When a 17th request arrives while 16
  are still unanswered, the helper first answers the 16 queued requests in order, then sends
  `too_many_requests` (with `id` of the 17th request) and closes the connection; the 17th request is
  never executed (section 12.2 `TestInFlightLimit`).
- Events (section 8) are not subject to this limit and may be interleaved between responses at any
  frame boundary.

### 4.4 Ordering guarantees

1. Responses arrive in request order.
2. Events caused by a request (for example the `state` events for `starting` and `on` during an `on`
   request) are sent before that request's response.
3. Events carry a per-session `seq` that increases by exactly 1 per event generated, including events
   that are later dropped for backpressure (section 8.5). A gap in `seq` therefore means events were
   dropped.
4. Frames are never interleaved at the byte level: each frame is written atomically by one writer.

---

## 5. Versioning and the hello handshake

### 5.1 Protocol version

The protocol version is an integer. This document defines version `1`. Within a major version changes
are additive only:

- The helper MAY add fields to responses and events, add event types, add enum values to fields that
  this document marks as _open_ (`state`, `autopause.status`, `capabilities`, `log.level`), and add new
  commands.
- Clients MUST ignore response and event fields they do not know, MUST ignore unknown event types, and
  MUST render unknown open-enum values neutrally instead of failing.
- The helper MUST NOT remove or rename fields, change a field's type, or change the meaning of an
  existing error code within a major version.
- The helper is strict about requests: unknown fields are errors (section 4.2). A client that wants to
  use a new field therefore needs a helper that knows it; new optional request fields MUST be announced
  through a new entry in `capabilities`.

A breaking change increments the version. A helper MAY support several versions and picks the highest
that both sides support.

### 5.2 The hello handshake

`hello` MUST be the first request on every connection, including reconnects. Until `hello` succeeds the
connection is not a session: any other request is answered with `hello_required` and the connection is
closed. A connection that has not completed `hello` within 5000 ms of being accepted is closed with
`hello_required`. A second `hello` on an established session is answered with `invalid_state`; the
session continues.

Request:

```json
{
  "id": 1,
  "cmd": "hello",
  "args": { "protocol": [1], "client": "lychee", "client_version": "0.2.0" }
}
```

| Field            | Type              | Required | Rules                                                                           |
| ---------------- | ----------------- | -------- | ------------------------------------------------------------------------------- |
| `protocol`       | array of integers | yes      | the versions the client supports, 1 to 8 entries, each `1..1000`, no duplicates |
| `client`         | string            | yes      | `^[A-Za-z0-9._-]{1,32}$`                                                        |
| `client_version` | string            | yes      | `^[A-Za-z0-9._+-]{1,32}$`                                                       |

Response:

```json
{
  "id": 1,
  "ok": true,
  "result": {
    "protocol": 1,
    "helper_version": "0.2.0",
    "os": "linux",
    "arch": "amd64",
    "pid": 48213,
    "instance": "3f9c2a7e5b1d4c6a8e0f1a2b3c4d5e6f",
    "session": 1,
    "auth": { "model": "unix_peer_uid", "privilege": "capabilities", "authorized_uid": 1000 },
    "capabilities": ["link_counters"],
    "limits": {
      "max_frame": 65536,
      "max_in_flight": 16,
      "hello_timeout_ms": 5000,
      "grace_ms": 10000,
      "startup_timeout_ms": 30000,
      "stats_interval_ms": { "min": 250, "max": 5000, "default": 1000 },
      "weight": { "min": 0.05, "max": 100 }
    },
    "capture": { "available": true, "error": null }
  }
}
```

| Field                 | Type                    | Meaning                                                                                                                                                                                                                                |
| --------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol`            | integer                 | the version chosen: the highest in the client's list that the helper supports                                                                                                                                                          |
| `helper_version`      | string                  | `main.version` as built: Lychee's `package.json` version, which the client MUST require to equal its own version (`"dev"` for unversioned builds); a mismatch is "Network helper is out of date" (plan section 4)                      |
| `os`, `arch`          | string                  | Go's `GOOS` and `GOARCH` (`linux`, `darwin`, `windows`; `amd64`, `arm64`, ...)                                                                                                                                                         |
| `pid`                 | integer                 | the helper's pid                                                                                                                                                                                                                       |
| `instance`            | string                  | 32 lowercase hex characters, random per helper process. A reconnecting client compares it with the previous value: equal means the same helper and all state is preserved; different means a new helper that must be configured again. |
| `session`             | integer                 | 1 for the first session of this helper process, incremented for each later one                                                                                                                                                         |
| `auth.model`          | string (open)           | `unix_peer_uid` or `windows_pipe_sid`                                                                                                                                                                                                  |
| `auth.privilege`      | string (open)           | `root`, `capabilities` or `elevated`                                                                                                                                                                                                   |
| `auth.authorized_uid` | integer                 | present on Linux and macOS                                                                                                                                                                                                             |
| `auth.authorized_sid` | string                  | present on Windows                                                                                                                                                                                                                     |
| `capabilities`        | array of strings (open) | optional features of this helper, section 5.3                                                                                                                                                                                          |
| `limits`              | object                  | the constants of section 1.5; clients MUST use these values rather than their own                                                                                                                                                      |
| `capture.available`   | boolean                 | `false` when `platform.CheckDriver` failed at start (no `/dev/net/tun`, no `wintun.dll`); `on` will fail with `unsupported_platform` but stats still work                                                                              |
| `capture.error`       | string or null          | the driver check's message when `available` is false                                                                                                                                                                                   |

Errors:

| Code                           | When                                                                                                                                                                                                      | Connection                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `version_unsupported`          | no entry of `protocol` is supported; `error.data.supported` lists the helper's versions                                                                                                                   | closed                                         |
| `busy`                         | a session already exists; `error.data.session_pid` is that client's pid as seen by the peer check (informative, for logs and messages; clients MUST NOT rely on it, and test fakes may use a fixed value) | closed                                         |
| `bad_request`, `unknown_field` | malformed args                                                                                                                                                                                            | closed (the connection has no session to keep) |

### 5.3 Capabilities

All commands of section 7 are mandatory in version 1 and are not capability-gated. `capabilities`
announces optional behaviour:

| Capability            | Meaning                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `link_counters`       | the helper can read the OS byte counters (`nics.Octets`) on this system, so `link_in_bps`/`link_out_bps` are meaningful   |
| `keep_adapter_on_off` | `off` keeps the TUN adapter and only removes routes (macOS `keepDevice`), so pausing does not disturb other virtual links |

Unknown capability strings MUST be ignored by clients.

---

## 6. Message envelope

### 6.1 Requests (client to helper)

```json
{ "id": 7, "cmd": "set_ipv6", "args": { "mode": "on" } }
```

| Field  | Type    | Required | Rules                                                                                                                                                                                    |
| ------ | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`   | integer | yes      | `1..2^53-1`. MUST be unique among the client's unanswered requests; reusing an id that is still unanswered is `bad_request` (connection closed). Ids of answered requests may be reused. |
| `cmd`  | string  | yes      | one of the command names in section 7, exactly, lowercase                                                                                                                                |
| `args` | object  | no       | command arguments; absent means `{}`. MUST be an object if present.                                                                                                                      |

No other top-level field is allowed (`unknown_field`).

### 6.2 Responses (helper to client)

Success:

```json
{ "id": 7, "ok": true, "result": { "mode": "on", "effective": "balanced" } }
```

Failure:

```json
{
  "id": 7,
  "ok": false,
  "error": {
    "code": "out_of_range",
    "message": "interval_ms must be between 250 and 5000",
    "data": { "field": "interval_ms", "min": 250, "max": 5000 }
  }
}
```

| Field           | Type            | Rules                                                                                     |
| --------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `id`            | integer or null | the request's id; `null` only when the request could not be decoded far enough to know it |
| `ok`            | boolean         |                                                                                           |
| `result`        | object          | present if and only if `ok` is true; `{}` when a command has nothing to return            |
| `error.code`    | string          | one of section 9; the only field clients branch on                                        |
| `error.message` | string          | human-readable English, at most 512 bytes, for logs and error dialogs; never parsed       |
| `error.data`    | object          | optional, code-specific extras listed in section 9                                        |

Exactly one response is sent per request, including requests that close the connection.

### 6.3 Events (helper to client)

```json
{ "event": "state", "seq": 12, "data": { "state": "on", "...": "..." } }
```

| Field   | Type          | Rules                                                                          |
| ------- | ------------- | ------------------------------------------------------------------------------ |
| `event` | string (open) | `stats`, `state` or `log` in version 1                                         |
| `seq`   | integer       | starts at 1 for each session, increases by 1 per event generated (section 4.4) |
| `data`  | object        | event payload, section 8                                                       |

Events have no `id`. They are only sent on a session (after `hello`).

---

## 7. Commands

### 7.1 Allowlist and general rules

The complete set of commands in protocol version 1:

| Command         | Purpose                                                                    | Changes state | Section |
| --------------- | -------------------------------------------------------------------------- | ------------- | ------- |
| `hello`         | handshake, first on every connection                                       | session       | 5.2     |
| `status`        | one snapshot of everything the stats stream carries, plus skipped adapters | no            | 7.2     |
| `subscribe`     | start or re-time the `stats` event stream                                  | subscription  | 7.3     |
| `unsubscribe`   | stop the stream                                                            | subscription  | 7.4     |
| `on`            | start merging (manual start, as the tray's "Start merging")                | merging       | 7.5     |
| `off`           | stop merging (manual stop; autopause never resumes after it)               | merging       | 7.6     |
| `set_ipv6`      | `auto`, `on` or `off`, as `-ipv6` and the tray checkbox                    | option        | 7.7     |
| `set_autopause` | enable or disable pausing by itself                                        | option        | 7.8     |
| `exclude`       | stop giving flows to an adapter                                            | adapter set   | 7.9     |
| `include`       | undo `exclude`                                                             | adapter set   | 7.10    |
| `set_weight`    | pin an adapter's weight or return it to automatic                          | weights       | 7.11    |
| `list_adapters` | usable and skipped adapters with reasons                                   | no            | 7.12    |
| `cleanup`       | remove stale routes left by a crash; only while off                        | system        | 7.13    |
| `quit`          | turn off and exit                                                          | process       | 7.14    |

Rules that apply to every command:

- Any `cmd` not in this table is `unknown_command`. There is no aliasing and no case folding.
- Every argument is validated before anything is executed. A request with any invalid argument has no
  effect at all.
- Client-supplied strings never reach a shell, an `exec` call, a file path or a log line unescaped.
  Adapter names are only compared against the names returned by the last `nics.DiscoverNicsDetailed`
  run and used as map keys; the helper logs them quoted with `%q`.
- Commands are executed one at a time in order (section 4.3). `on`, `off` and `cleanup` have an
  internal deadline of 30 s; on expiry they fail with `internal` and the helper logs the stuck step.
  Clients SHOULD allow 45 s for these three and 5 s for the others before treating the helper as hung.
- Every command except `hello` requires a session (`hello_required` otherwise).
- "Idempotent" below means that repeating the request with the same arguments succeeds and leaves the
  helper in the same state.

The `Snapshot` object referenced below is defined in section 8.2.

### 7.2 `status`

Returns the current `Snapshot` plus the skipped adapters. Does not require a subscription. Serves as
the client's liveness probe.

```json
{ "id": 2, "cmd": "status" }
```

```json
{
  "id": 2,
  "ok": true,
  "result": {
    "ts": 1760000000123,
    "state": "off",
    "state_since": 1759999990000,
    "error": null,
    "capture": { "available": true, "error": null },
    "autopause": { "enabled": true, "status": "manual_off" },
    "ipv6": {
      "mode": "auto",
      "effective": "refused",
      "detail": "auto: refused, apps fall back to IPv4 so every adapter is used (not every adapter has IPv6)"
    },
    "tun": { "name": null, "open": false },
    "totals": {
      "link_in_bps": 1312000,
      "link_out_bps": 91000,
      "relayed_in_bps": 0,
      "relayed_out_bps": 0,
      "active_flows": 0,
      "adapters_present": 2,
      "adapters_usable": 2
    },
    "adapters": ["... section 8.2 ..."],
    "discovery_seq": 3,
    "skipped": [
      { "name": "tailscale0", "reason": "looks like a virtual/VPN adapter (name)" },
      {
        "name": "docker0",
        "reason": "tunnel/virtual interface (software interface type 1, no hardware device)"
      }
    ]
  }
}
```

Args: none (`args` absent or `{}`). Errors: none specific. Idempotent.

### 7.3 `subscribe`

Starts the `stats` event stream, or changes its interval if already subscribed. The first `stats`
event is sent immediately after the response; subsequent ones every `interval_ms`.

```json
{ "id": 3, "cmd": "subscribe", "args": { "interval_ms": 1000 } }
```

| Field         | Type    | Required | Rules                       |
| ------------- | ------- | -------- | --------------------------- |
| `interval_ms` | integer | no       | `250..5000`; default `1000` |

```json
{ "id": 3, "ok": true, "result": { "interval_ms": 1000 } }
```

Errors: `out_of_range` (`data.field = "interval_ms"`). Idempotent. The subscription belongs to the
session: a reconnect starts without one.

_Informative:_ the engine samples throughput once a second (`Scheduler.Tick`), so intervals below
1000 ms repeat the same rate values; they only make `state` and flow counts visible sooner.

### 7.4 `unsubscribe`

Stops the stream. Succeeds even when not subscribed. A `stats` event already queued may still arrive
after the response.

```json
{ "id": 4, "cmd": "unsubscribe" }
```

```json
{ "id": 4, "ok": true, "result": {} }
```

### 7.5 `on`

Manual start. Equivalent to the tray's "Start merging" (`trayUI.manual(true)`): records the user's
intent for autopause (`autoPauser.userSet(true, usable)`), then installs the TUN and its routes
(`tun.On`). On macOS the first `on` creates the utun; later `off`/`on` pairs keep it (`keepDevice`).

```json
{ "id": 5, "cmd": "on" }
```

```json
{ "id": 5, "ok": true, "result": { "state": "on" } }
```

Preconditions and outcomes:

| Situation                                | Result                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture.available` is false             | error `unsupported_platform`, state unchanged                                                                                                                                           |
| no adapter is present and not excluded   | error `no_adapters`, state unchanged (capturing with nothing to send to would cut the machine off)                                                                                      |
| state is `on`                            | success, no-op (idempotent)                                                                                                                                                             |
| state is `starting`                      | cannot happen: requests are sequential                                                                                                                                                  |
| state is `off`, `paused_auto` or `error` | state becomes `starting` (a `state` event), then `on` (a `state` event) and the response is sent                                                                                        |
| `tun.On` fails                           | state becomes `error` with the message (a `state` event); error `internal` with the same message, for example `route 0.0.0.0/1: file exists` when another program holds the same routes |

Autopause interaction: after `on` with fewer than two usable adapters the helper is in the tray's
"held" condition and will not pause by itself until two usable adapters have been seen at the same time.

Errors: `unsupported_platform`, `no_adapters`, `internal`, `permission_denied` (the helper lost its
privilege; not expected, listed for completeness).

### 7.6 `off`

Manual stop. Equivalent to the tray's "Pause merging" (`manual(false)`): removes the capture routes
(and on Linux and Windows the adapter), and records that the user turned it off, so autopause does not
resume it. Always succeeds; idempotent.

```json
{ "id": 6, "cmd": "off" }
```

```json
{ "id": 6, "ok": true, "result": { "state": "off" } }
```

A `state` event with `off` precedes the response. From `error` the result is `off` and the error is
cleared. Errors: `internal` only if route deletion itself fails, in which case the state is still
reported as `off` and the message is in the `state` event's `error`.

### 7.7 `set_ipv6`

Sets the IPv6 policy (`Balancer.SetV6Mode`). Takes effect for new flows immediately; existing flows
are not touched.

```json
{ "id": 7, "cmd": "set_ipv6", "args": { "mode": "auto" } }
```

| Field  | Type   | Required | Rules                                        |
| ------ | ------ | -------- | -------------------------------------------- |
| `mode` | string | yes      | `auto`, `on` or `off` (`engine.ParseV6Mode`) |

```json
{ "id": 7, "ok": true, "result": { "mode": "auto", "effective": "refused" } }
```

`effective` is `balanced` when `Balancer.V6Allowed()` is true at that moment, else `refused`
(section 8.2). Errors: `bad_request` for any other string. Idempotent. Default at helper start: `auto`.

### 7.8 `set_autopause`

Enables or disables pausing by itself (the tray's "Pause when there is only one connection",
`autoPauser.setEnabled`).

```json
{ "id": 8, "cmd": "set_autopause", "args": { "enabled": false } }
```

| Field     | Type    | Required | Rules                    |
| --------- | ------- | -------- | ------------------------ |
| `enabled` | boolean | yes      | JSON `true`/`false` only |

```json
{ "id": 8, "ok": true, "result": { "enabled": false, "status": "disabled" } }
```

Effects, mirroring `setEnabled(enabled, on)`:

- Enabling while merging is on arms it: it pauses after the usual settling times when fewer than two
  adapters are usable.
- Enabling while off and not manually off (for example after an automatic pause that happened while
  autopause was briefly disabled) makes it wait: state becomes `paused_auto`.
- Disabling while `paused_auto` leaves merging off: state becomes `off`. It does not turn merging on;
  send `on` for that.
- Disabling never changes a running `on`.

Default at helper start: `true`. Errors: `bad_request`. Idempotent.

### 7.9 `exclude`

Stops giving flows to an adapter. The adapter is removed from the scheduler at the next rescan (within
3 s): it becomes absent for the scheduler, new flows avoid it, existing flows finish on it
(`Scheduler.Update` keeps a slot until its active flows end). It stays in `stats` with `excluded: true`
and its OS counters continue to be reported.

```json
{ "id": 9, "cmd": "exclude", "args": { "adapter": "Wi-Fi" } }
```

| Field     | Type   | Required | Rules                                                                                                                                                                             |
| --------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter` | string | yes      | 1 to 256 bytes, valid UTF-8, no control characters. MUST equal (byte for byte) a name in the current discovery result, usable or skipped, or a name already in the exclusion set. |

```json
{ "id": 9, "ok": true, "result": { "adapter": "Wi-Fi", "excluded": true } }
```

Errors: `unknown_adapter` (`data.adapter`). Excluding a skipped adapter succeeds and has no effect
beyond remembering the name. Excluding an already excluded adapter succeeds (idempotent). The exclusion
set lives for the helper process; it is not persisted. A name that is currently not present cannot be
excluded in advance: the client re-sends `exclude` when such an adapter reappears (it sees it in
`stats` with `present: true, excluded: false`), accepting that flows may be assigned to it for up to one
stats interval.

Excluding the last usable adapter while on is allowed; the engine then has no adapter to dial through
and new flows fail until `include` or `off`. Clients SHOULD warn before doing that.

### 7.10 `include`

Removes a name from the exclusion set. The adapter rejoins at the next rescan if discovery still
returns it as usable.

```json
{ "id": 10, "cmd": "include", "args": { "adapter": "Wi-Fi" } }
```

Same `adapter` rules as `exclude`. Result `{"adapter":"Wi-Fi","excluded":false}`. Errors:
`unknown_adapter` when the name is neither excluded nor in the current discovery result. Idempotent.

### 7.11 `set_weight`

Pins an adapter's balancing weight, or returns it to automatic. Applies to both address families of
the adapter (the engine tracks `weight[Fam4]` and `weight[Fam6]`; a manual weight sets both).

```json
{"id":11,"cmd":"set_weight","args":{"adapter":"Ethernet","weight":3}}
{"id":12,"cmd":"set_weight","args":{"adapter":"Ethernet","weight":"auto"}}
```

| Field     | Type                          | Required | Rules                                                                                      |
| --------- | ----------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `adapter` | string                        | yes      | as in `exclude`; MUST be in the current discovery result (usable) or in the override table |
| `weight`  | number or the string `"auto"` | yes      | a finite number in `0.05..100` inclusive, or exactly `"auto"`                              |

```json
{ "id": 11, "ok": true, "result": { "adapter": "Ethernet", "weight_mode": "manual", "weight": 3 } }
```

Semantics:

- Weights are relative: a flow goes to the adapter with the lowest `(active flows + 1) / weight` among
  those usable for its family (`Scheduler.AcquireFor`). Automatic weights are `peak / max peak`, so they
  lie in `(0.05, 1]`; a manual `3` therefore gets about three times the flows of the best automatic
  adapter.
- A manual weight is kept by name in an override table for the life of the helper, so it survives the
  adapter being unplugged and replugged. `"auto"` removes the entry.
- Setting `"auto"` on an adapter that is already automatic succeeds (idempotent); so does setting the
  same manual weight twice.
- _Implementation note:_ today `Scheduler.SetAuto` is all-or-nothing. The helper needs a per-slot
  manual flag that `Tick`'s auto loop skips, and `Update` must apply the override table instead of
  `nics.Nic.Weight`.

With `"auto"` the result is `{"adapter":..,"weight_mode":"auto","weight":<current automatic weight>}`,
where `weight` is the adapter's current automatic IPv4 weight (`Weight`), which may change at the next
tick.

Errors: `unknown_adapter`, `out_of_range` (`data.field = "weight"`, `data.min = 0.05`, `data.max =
100`), `bad_request` (not a number and not `"auto"`; `NaN`/`Infinity` are not valid JSON anyway).

### 7.12 `list_adapters`

The result of the latest discovery run: adapters the engine may use, and adapters it saw and skipped,
with the reason strings from `nics.DiscoverNicsDetailed` (`nics.Skip`).

```json
{ "id": 13, "cmd": "list_adapters" }
```

```json
{
  "id": 13,
  "ok": true,
  "result": {
    "discovery_seq": 3,
    "adapters": [
      {
        "name": "Wi-Fi",
        "index": 12,
        "ip": "192.168.1.23",
        "ip6": "2001:db8:1::23",
        "excluded": false,
        "weight_mode": "auto",
        "description": "Intel(R) Wi-Fi 6 AX201"
      },
      {
        "name": "Ethernet 3",
        "index": 7,
        "ip": "10.42.0.5",
        "ip6": null,
        "excluded": true,
        "weight_mode": "manual",
        "description": null
      }
    ],
    "skipped": [
      { "name": "tailscale0", "reason": "looks like a virtual/VPN adapter (name)" },
      { "name": "enp5s0", "reason": "no default gateway (no internet route)" }
    ]
  }
}
```

| Field                       | Type           | Meaning                                                                                                                                                                    |
| --------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].name`           | string         | `nics.Nic.Name`, the key used by every other command                                                                                                                       |
| `adapters[].index`          | integer        | `nics.Nic.Index`                                                                                                                                                           |
| `adapters[].ip`, `.ip6`     | string or null | `nics.Nic.IP` / `.IP6`                                                                                                                                                     |
| `adapters[].excluded`       | boolean        | in the exclusion set                                                                                                                                                       |
| `adapters[].weight_mode`    | string         | `auto` or `manual`                                                                                                                                                         |
| `adapters[].description`    | string or null | the OS's description of the hardware when known (driver name on Linux, System Settings name on macOS, adapter description on Windows); null if the helper does not have it |
| `skipped[].name`, `.reason` | string         | `nics.Skip`                                                                                                                                                                |
| `discovery_seq`             | integer        | increments whenever the set of names or reasons changes; also present in `Snapshot` so clients know when to call this                                                      |

Args: none. Errors: none specific. Both lists are capped at 64 entries (the first 64 by discovery
order); `truncated: true` is added at the top level when a cap was hit.

### 7.13 `cleanup`

Runs `tun.CleanupStale()`: deletes capture routes left on a surviving `lychee-netd` adapter, macOS scoped
default routes a crashed run left (`cleanupScoped`), and on Windows restores the weak-host settings a
crashed run turned off (`restoreStrongHost`). net-merge exposed this as `net-merge cleanup`; `lychee-netd`
has no command line for it, the channel is the only way.

```json
{ "id": 14, "cmd": "cleanup" }
```

```json
{ "id": 14, "ok": true, "result": {} }
```

Preconditions: state MUST be `off` or `error`; otherwise `invalid_state` (`data.state`). Not allowed
while `paused_auto` either, because on macOS the kept utun's scoped-route bookkeeping is live.
Idempotent. Errors: `invalid_state`, `internal`.

### 7.14 `quit`

Turns merging off, tears everything down and exits the process with code 0.

```json
{ "id": 15, "cmd": "quit" }
```

```json
{ "id": 15, "ok": true, "result": {} }
```

The helper first turns merging off and sends the resulting `state` event (`state: "off"`, `tun` closed;
section 4.4 rule 2, Appendix B), then sends the response, then runs the rest of the shutdown sequence
of section 10.4 and closes the connection. If merging was already off and nothing changes, no `state`
event precedes the response. The client SHOULD wait for the response, then for EOF, and MUST tolerate EOF without a
response (the helper may have been killed meanwhile). After `quit` no new session is accepted.

---

## 8. Events and the stats stream

### 8.1 Event types

| Event   | Sent when                                                                                                                                                                                                                                                                                                                                                                                                                      | Needs `subscribe` |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `stats` | every `interval_ms` while subscribed, starting right after the `subscribe` response                                                                                                                                                                                                                                                                                                                                            | yes               |
| `state` | whenever `state`, `error`, `autopause.status`, `ipv6.effective`, `tun` or `capture` changes; at most once per change, immediately. `exclude`, `include` and `set_weight` do not send a `state` event by themselves (the adapter set and weights are not part of it); their effect appears in the next `stats` event, and a `state` event is sent only if they change one of the listed fields (for example `autopause.status`) | no                |
| `log`   | a warning or error the engine logged (`logx.Printf` lines starting with `warning:` or `error:`), peer rejections, and informational lifecycle lines                                                                                                                                                                                                                                                                            | no                |

Stats timing: a `stats` tick that falls due while a command is being processed is held and sent right
after that command's response, with `ts` taken at delivery. Ticks are never sent twice to catch up.

Stats are emitted whether merging is on or off: the engine keeps running `Scheduler.Tick` (which reads
the OS counters) and the probes at all times, so per-adapter speeds and internet status are live while
off, exactly as the tray's menu shows speeds while paused.

### 8.2 `Snapshot` object

Used as the `data` of `stats` events (plus `dropped`) and as the `status` result (plus `skipped`).

```json
{
  "event": "stats",
  "seq": 42,
  "data": {
    "ts": 1760000001000,
    "state": "on",
    "state_since": 1760000000120,
    "error": null,
    "capture": { "available": true, "error": null },
    "autopause": { "enabled": true, "status": "armed" },
    "ipv6": {
      "mode": "auto",
      "effective": "refused",
      "detail": "auto: refused, apps fall back to IPv4 so every adapter is used (not every adapter has IPv6)"
    },
    "tun": { "name": "lychee-netd", "open": true },
    "totals": {
      "link_in_bps": 9875000,
      "link_out_bps": 412000,
      "relayed_in_bps": 9100000,
      "relayed_out_bps": 380000,
      "active_flows": 41,
      "adapters_present": 2,
      "adapters_usable": 2
    },
    "adapters": [
      {
        "name": "Wi-Fi",
        "ip": "192.168.1.23",
        "ip6": "2001:db8:1::23",
        "present": true,
        "excluded": false,
        "state": "up",
        "state6": "up",
        "weight": 1,
        "weight6": 1,
        "weight_mode": "auto",
        "peak_bps": 6250000,
        "peak6_bps": 2100000,
        "active_flows": 23,
        "total_flows": 1510,
        "failed_flows": 0,
        "link_in_bps": 6100000,
        "link_out_bps": 250000,
        "relayed_in_bps": 5800000,
        "relayed_out_bps": 230000,
        "bytes_in": 3141592653,
        "bytes_out": 271828182
      },
      {
        "name": "Ethernet 3",
        "ip": "10.42.0.5",
        "ip6": null,
        "present": true,
        "excluded": false,
        "state": "up",
        "state6": "none",
        "weight": 0.61,
        "weight6": 1,
        "weight_mode": "auto",
        "peak_bps": 3800000,
        "peak6_bps": 0,
        "active_flows": 18,
        "total_flows": 1204,
        "failed_flows": 2,
        "link_in_bps": 3775000,
        "link_out_bps": 162000,
        "relayed_in_bps": 3300000,
        "relayed_out_bps": 150000,
        "bytes_in": 2718281828,
        "bytes_out": 161803398
      }
    ],
    "discovery_seq": 3,
    "dropped": 0
  }
}
```

Top-level fields:

| Field               | Type           | Meaning                                                                                                                                                                                                                                                                              |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ts`                | integer        | milliseconds since the Unix epoch when the snapshot was taken                                                                                                                                                                                                                        |
| `state`             | string (open)  | `off`, `starting`, `on`, `paused_auto`, `error` (section 10.1)                                                                                                                                                                                                                       |
| `state_since`       | integer        | `ts` of the last change of `state`                                                                                                                                                                                                                                                   |
| `error`             | object or null | `{"message": "..."}` when `state` is `error` (the last failed `on`), else null                                                                                                                                                                                                       |
| `capture`           | object         | as in `hello`                                                                                                                                                                                                                                                                        |
| `autopause.enabled` | boolean        |                                                                                                                                                                                                                                                                                      |
| `autopause.status`  | string (open)  | `disabled`, `armed`, `held`, `waiting`, `manual_off`, `idle` (section 10.1)                                                                                                                                                                                                          |
| `ipv6.mode`         | string         | `auto`, `on`, `off` (`Balancer.V6Mode`)                                                                                                                                                                                                                                              |
| `ipv6.effective`    | string         | `balanced` if `Balancer.V6Allowed()` is true now, else `refused`                                                                                                                                                                                                                     |
| `ipv6.detail`       | string         | `Balancer.V6State()`, for display                                                                                                                                                                                                                                                    |
| `tun.name`          | string or null | the TUN adapter's OS name while it exists (`lychee-netd` on Linux and Windows, `utunN` on macOS), else null. Clients hide this adapter from their own interface lists.                                                                                                               |
| `tun.open`          | boolean        | the adapter exists (on macOS it stays open while `off`)                                                                                                                                                                                                                              |
| `totals`            | object         | sums over adapters with `present: true` (including excluded ones): `link_in_bps`, `link_out_bps`, `relayed_in_bps`, `relayed_out_bps`, `active_flows`; `adapters_present` counts them; `adapters_usable` counts those with `state` or `state6` equal to `up` (the tray's `usable()`) |
| `adapters`          | array          | one entry per adapter known to the scheduler or to the exclusion set, unordered; at most 64. Clients key by `name`.                                                                                                                                                                  |
| `discovery_seq`     | integer        | section 7.12                                                                                                                                                                                                                                                                         |
| `dropped`           | integer        | `stats` events only: cumulative number of events of any type dropped for backpressure on this session (section 8.5)                                                                                                                                                                  |
| `skipped`           | array          | `status` only: as in `list_adapters`                                                                                                                                                                                                                                                 |

`totals.link_in_bps` and `totals.link_out_bps` are the "total combined speed". Per-adapter
`link_in_bps`/`link_out_bps` are the "speed from each source". Both come from the OS counters and
include traffic that never passes through the helper (apps bound directly to an adapter), which is what
net-merge's tray showed too.

Adapter fields, with the `engine.SlotStats` field each comes from (full table in Appendix A):

| Field                               | Type           | Source                | Notes                                                                                                                        |
| ----------------------------------- | -------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `name`                              | string         | `Name`                | unique; the key for every command                                                                                            |
| `ip`                                | string or null | `IP`                  | null when empty                                                                                                              |
| `ip6`                               | string or null | `IP6`                 | null when empty                                                                                                              |
| `present`                           | boolean        | `Present`             | listed by the latest discovery. An adapter that vanished but still has active flows is reported with `false` until they end. |
| `excluded`                          | boolean        | exclusion set         | not in `SlotStats`                                                                                                           |
| `state`, `state6`                   | string         | `State`, `State6`     | mapped: `"-"` to `none`, `"checking"` to `checking`, `"up"` to `up`, `"no internet"` to `down`                               |
| `weight`, `weight6`                 | number         | `Weight`, `Weight6`   | `0` for an excluded adapter not in the scheduler                                                                             |
| `weight_mode`                       | string         | override table        | `auto` or `manual`                                                                                                           |
| `peak_bps`, `peak6_bps`             | integer        | `Peak`, `Peak6`       | observed capacity through the helper, bytes/s, truncated                                                                     |
| `active_flows`                      | integer        | `Active`              |                                                                                                                              |
| `total_flows`                       | integer        | `Total`               |                                                                                                                              |
| `failed_flows`                      | integer        | `Failed`              |                                                                                                                              |
| `link_in_bps`, `link_out_bps`       | integer        | `LinkIn`, `LinkOut`   | OS counters, all apps, bytes/s, truncated                                                                                    |
| `relayed_in_bps`, `relayed_out_bps` | integer        | `RateIn`, `RateOut`   | through the helper, both families summed, bytes/s                                                                            |
| `bytes_in`, `bytes_out`             | integer        | `BytesIn`, `BytesOut` | cumulative through the helper since the slot was created                                                                     |

All rates are bytes per second as integers (floats truncated toward zero). Clients multiply by 8 for
bit/s, as `tray.mbps` does. For an adapter that is excluded and therefore absent from the scheduler, the
helper samples `nics.Octets` itself so `link_in_bps`/`link_out_bps` stay meaningful; all other counters
are `0` and `state`/`state6` are `none`.

### 8.3 `state` event

The subset of `Snapshot` that describes state, sent on every change so a client with a slow stats
interval still reacts at once:

```json
{
  "event": "state",
  "seq": 43,
  "data": {
    "ts": 1760000002000,
    "state": "paused_auto",
    "state_since": 1760000002000,
    "error": null,
    "capture": { "available": true, "error": null },
    "autopause": { "enabled": true, "status": "waiting" },
    "ipv6": { "mode": "auto", "effective": "refused", "detail": "..." },
    "tun": { "name": "lychee-netd", "open": false }
  }
}
```

Fields have the meanings of section 8.2. One `state` event is sent right after a successful `hello` so
the client has the state without calling `status` (it still needs `status` or `stats` for adapters).

### 8.4 `log` event

```json
{
  "event": "log",
  "seq": 44,
  "data": { "level": "warn", "message": "IPv6 not captured: operation not permitted" }
}
```

| Field     | Type          | Rules                                                                |
| --------- | ------------- | -------------------------------------------------------------------- |
| `level`   | string (open) | `info`, `warn`, `error`                                              |
| `message` | string        | at most 1024 bytes, UTF-8, control characters other than tab removed |

`log` events are for the client's log file and diagnostics export; they are not a programmatic
interface. The helper rate-limits them to 20 per second per session; excess messages are dropped and
counted in `dropped`. Messages never contain client-supplied strings unquoted.

### 8.5 Backpressure

The engine's loops MUST never block on the control channel. Each session has an outbound queue of 64
frames and one writer goroutine that drains it to the transport.

- Responses and `state` events are never dropped. If the queue is full when one of them must be
  enqueued, the connection is considered dead: it is closed and the grace period starts.
- `stats` and `log` events are dropped when the queue is full or when the previous `stats` event has
  not been fully written yet (at most one `stats` event is ever in flight). Each dropped event still
  consumes a `seq` and increments `dropped`, which is reported in the next delivered `stats` event.
- A write that makes no progress for 30 s (the client stopped reading entirely) closes the connection.

Clients SHOULD read continuously and treat a rising `dropped` as a sign to lengthen their interval.

---

## 9. Error codes

| Code                   | Meaning                                                                                                                                    | `error.data`                                | Connection                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `bad_request`          | the frame is not valid UTF-8/JSON/object, the envelope is malformed, or an argument is missing, of the wrong type or an invalid enum value | `field` when known                          | closed when the envelope could not be decoded; stays open for argument errors |
| `frame_too_large`      | a line exceeded 65536 bytes                                                                                                                |                                             | closed                                                                        |
| `too_many_requests`    | more than 16 unanswered requests                                                                                                           |                                             | closed                                                                        |
| `unknown_command`      | `cmd` is not in the allowlist                                                                                                              | `cmd`                                       | open                                                                          |
| `unknown_field`        | a field not defined for this request or command                                                                                            | `field` (dotted path, e.g. `args.interval`) | open                                                                          |
| `hello_required`       | first request was not `hello`, or `hello` did not arrive within 5 s                                                                        |                                             | closed                                                                        |
| `version_unsupported`  | no common protocol version                                                                                                                 | `supported` (array)                         | closed                                                                        |
| `busy`                 | a session already exists                                                                                                                   | `session_pid`                               | closed                                                                        |
| `invalid_state`        | the command is not allowed in the current state (`cleanup` while not off; second `hello`)                                                  | `state`                                     | open                                                                          |
| `unknown_adapter`      | the name is not in the current discovery result or the relevant set                                                                        | `adapter`                                   | open                                                                          |
| `out_of_range`         | a number is outside its documented range                                                                                                   | `field`, `min`, `max`                       | open                                                                          |
| `no_adapters`          | `on` with no present, non-excluded adapter                                                                                                 |                                             | open                                                                          |
| `unsupported_platform` | `on` while `capture.available` is false                                                                                                    | `error` (the driver message)                | open                                                                          |
| `permission_denied`    | the operating system refused a privileged operation the helper expected to be allowed                                                      |                                             | open                                                                          |
| `internal`             | the command failed for a reason reported in `message` (`tun.On` errors, deadline expired, cleanup failure)                                 |                                             | open                                                                          |

"Closed" errors are sent as the last frame before the helper shuts the connection. If the connection
was the session, the grace period starts; if it was a connection awaiting `hello`, nothing else
changes. A client that receives a "closed" error MUST NOT retry the same frames blindly: they indicate a
client bug or an incompatible helper, except `busy`, which indicates another client.

---

## 10. Lifecycle and state machines

### 10.1 Merging state machine

The `state` field of `Snapshot` is derived from the TUN and the `autoPauser` exactly as the tray's
header is (`trayUI.refresh`), with this precedence:

| State         | Condition                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `starting`    | an `on` is executing `tun.On`                                                                    |
| `on`          | `tun.IsOn()`                                                                                     |
| `error`       | not on, and the last `on` (manual or automatic resume) failed; cleared by the next `on` or `off` |
| `paused_auto` | not on, autopause enabled, `waiting` and not `manualOff` (the tray's "Paused: one connection")   |
| `off`         | otherwise                                                                                        |

`autopause.status` is derived from `autoPauser` fields:

| Status       | Condition                                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled`   | `!enabled`                                                                                                                                                                                                                   |
| `held`       | enabled, merging on, `held`: set at `on` when fewer than two adapters are usable (present, not excluded, `state` or `state6` up); cleared as soon as two are usable at the same time while on. No automatic pause while held |
| `armed`      | enabled, merging on, not held                                                                                                                                                                                                |
| `manual_off` | enabled, merging off, `manualOff` (the user sent `off`, or nothing was ever turned on): never resumes by itself                                                                                                              |
| `waiting`    | enabled, merging off, `waiting` and not `manualOff`: resumes by itself when two adapters are usable                                                                                                                          |
| `idle`       | enabled, merging off, neither (transient)                                                                                                                                                                                    |

Transitions:

| From                          | Trigger                                                                                                                                         | To                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| any                           | helper start                                                                                                                                    | `off`, autopause `manual_off` (merging is never started without an `on` request in this helper's lifetime) |
| `off`, `paused_auto`, `error` | `on` accepted                                                                                                                                   | `starting`, then `on`; or `error` if `tun.On` fails                                                        |
| `on`                          | fewer than two usable adapters for 10 s with nothing moving, or 2 min with traffic, at least 30 s after the last automatic switch, and not held | `paused_auto`                                                                                              |
| `paused_auto`                 | two or more usable adapters for 3 s, at least 30 s after the last automatic switch                                                              | `starting`, then `on`; on failure `error`, retried after the gap                                           |
| `on`, `paused_auto`, `error`  | `off`                                                                                                                                           | `off`, autopause `manual_off`                                                                              |
| `paused_auto`                 | `set_autopause false`                                                                                                                           | `off`                                                                                                      |
| `off` (not `manual_off`)      | `set_autopause true`                                                                                                                            | `paused_auto`                                                                                              |
| any                           | `quit`, SIGTERM, grace expiry                                                                                                                   | `off`, then exit                                                                                           |

The timing constants are `internal/control/autopause.go`'s (`pauseAfterIdle` 10 s, `pauseAfterBusy` 2 min,
`resumeAfter` 3 s, `autoGap` 30 s, `quietRate` 50 000 bytes/s) and are informative here; the state
machine is the code moved unchanged from net-merge's `internal/tray` in L-1.

### 10.2 Helper process lifecycle

```
start ─► checks ─► listening ─► session ─► grace ─► exiting
                     │  ▲          │  ▲       │
                     │  └──────────┘  └───────┘ (reconnect within grace)
                     └─ startup timeout (30 s, no client) ─► exiting
```

Startup, in order (each failure exits with the code of section 2.7 and creates nothing further):

1. Parse arguments: exactly `serve --control <path>`.
2. Privilege check: `platform.IsAdmin()` (root, `CAP_NET_ADMIN`, or an elevated token). Without it:
   exit 3 with `permission_denied` on stderr. On Windows this is the elevated-token check of section 2.4
   rule 7 and its failure is exit 6 (`needs_admin`) instead. The helper never re-launches itself
   elevated.
3. Self-check of the binary when running as root (section 3.3).
4. Determine the authorized principal (sections 3.2, 2.4).
5. Single-instance lock (`platform.SingleInstance`): exit 4 if held, or if a standalone net-merge holds
   its lock (section 10.7).
6. `platform.CheckDriver()`: a failure does not exit; it is reported as `capture.available: false`.
7. Validate the control path, create the directory, handle a stale socket, bind, chmod, chown, listen
   (sections 2.2 to 2.6).
8. Start the engine: discovery, `Scheduler`, `Balancer` (`-ipv6 auto`), probes, rescan loop (3 s), tick
   loop (1 s). Zero adapters is not an error. `tun.New` with `DefaultMTU`; nothing is opened.
9. Start the accept loop and the startup timer. Log `listening on <path>` to stderr.

Accept loop:

- Each accepted connection is peer-checked (section 3). Rejected connections are closed and logged.
- At most 4 accepted connections may be awaiting `hello`; further connections are closed immediately
  without a peer check.
- A connection whose `hello` succeeds becomes the session if none exists; otherwise it receives `busy`.
- The startup timer (30 s) is cancelled by the first accepted authorized connection. If it fires, the
  helper exits 0 with `no client connected` on stderr.

### 10.3 Session loss and the grace period

Precisely:

1. The grace timer (10 000 ms) starts when the session's transport closes for any reason other than a
   completed `quit`: read EOF, read or write error, a "closed" protocol error, or the write stall limit.
   The helper logs `client disconnected, waiting 10 s`.
2. While the timer runs, merging state, options, exclusions, weights and the autopause state are
   preserved. Stats continue to be sampled; nothing is sent anywhere.
3. The timer is cancelled when a new authorized connection is accepted (peer check passed). If that
   connection then fails to complete `hello` (timeout, `version_unsupported`, decode error) or closes,
   the timer restarts with the full 10 000 ms.
4. When `hello` completes on the new connection it becomes session `n+1` with the same `instance`: the
   client sees that its settings are intact. It has no subscription and must `subscribe` again. `seq`
   restarts at 1.
5. If the timer fires, the helper logs `client gone`, runs the shutdown sequence (10.4) and exits 0.

This makes the helper stop when Lychee quits (it sends `quit` first), when Lychee crashes (its socket
closes, nobody reconnects), and when a Lychee update restarts the app (it either reconnects within 10 s
or starts a fresh helper). A client whose window is closed to the tray keeps its connection, so merging
continues; that is the intended "keep merging in the tray" behaviour.

Client expectations: on an unexpected disconnect, reconnect immediately and then every 500 ms until the
grace period has elapsed; then assume the helper exited and launch a new one. Compare `instance` after
`hello` to decide whether to re-apply settings.

### 10.4 Shutdown sequence

Triggered by `quit`, SIGTERM, SIGINT, SIGHUP, the grace timer or the startup timer:

1. Stop accepting connections; refuse new ones.
2. `tun.Close()`: delete the capture routes, remove the adapter (also a kept macOS utun), stop the
   scoped-route and weak-host bookkeeping, close the userland stack (5 s bound, as today).
3. Unix: unlink the socket if `lstat` still shows a socket with the inode created at startup. Windows:
   close all pipe instances.
4. Close the session's connection (after the `quit` response has been flushed).
5. Exit 0. The single-instance lock is released by the kernel.

Signals: SIGTERM, SIGINT and SIGHUP are all treated as `quit`. On Windows the helper has no console; a
`TerminateProcess` from the task scheduler or the client is a crash from the helper's point of view and
is safe (10.5).

### 10.5 Crash behaviour

If the helper dies without running 10.4 (kill -9, panic, power loss of the process):

- The TUN adapter and every route on it disappear with the file descriptor on all three platforms
  (Linux TUN, macOS utun, Wintun). The machine keeps its normal default route. This is verified by
  net-merge's `scripts/linux-e2e.sh` and `scripts/macos-smoke.sh`, carried over as
  `native/netd/scripts/`, and the helper changes nothing about it.
- Residue: macOS scoped default routes on primary adapters (`cleanupScoped` removes them at the next
  `tun.open`, and `cleanup` does so on request); Windows weak-host settings turned off while merging
  (restored from `lychee-netd-weakhost.txt` at the next start or by `cleanup`); the Unix socket file
  (handled as stale at the next start, section 2.6).
- The single-instance lock is released by the kernel (abstract socket, flock, mutex).
- The client sees EOF, cannot reconnect, and after the grace period launches a new helper, which cleans
  up as part of its first `on`. The client SHOULD show "helper stopped unexpectedly" with a restart
  action and keep its last 60 s of history (plan section 5).

### 10.6 Client launch procedure (informative)

- Linux: spawn the packaged helper (`/usr/lib/lychee/lychee-netd` for deb/rpm, when this user may
  execute it; a copy the user cannot execute is passed over for the one under the app's resources) as
  the user: `/usr/lib/lychee/lychee-netd serve --control $XDG_RUNTIME_DIR/lychee/netd.sock`. Exit 3
  within a second means no capabilities (an AppImage, or a user outside the `lychee` group): relaunch as
  `pkexec <abs path> serve --control /run/lychee-netd/netd.sock`.
- macOS: exactly
  `sudo -n /Library/PrivilegedHelperTools/gg.tame.lychee.netd serve --control /var/run/lychee-netd/netd.sock`.
  If `sudo -n -l` for that exact command line fails, the helper is not installed or the rule is not the
  one of section 3.3: offer the one-time setup. Compare `lychee-netd version` of the installed copy (and
  `helper_version` from `hello`) with the bundled version; a mismatch offers "Update network helper".
- Windows: before anything else, check that the current user can be elevated as themselves:
  `CheckTokenMembership` for `BUILTIN\Administrators` (`S-1-5-32-544`) against the process's linked
  token (`TokenLinkedToken`, the full token of a filtered administrator). If it fails, stop with
  "Combining connections system-wide needs an administrator account on this PC" and launch nothing.
  Otherwise run the scheduled task whose action is
  `%ProgramFiles%\Lychee\helper\lychee-netd.exe serve --control \\.\pipe\lychee-netd-<SID>`
  (`schtasks /Run`), or `ShellExecute runas` the same command line the first time. Connect to the pipe
  with retries for up to 30 s (wintun loading and elevation take time), verify the server SID (section
  2.4 rule 6), then `hello`. After launching, the same situation is recognised by any of: exit code 6; a
  helper process that is alive while `CreateFile` on the expected pipe name keeps failing with
  `ERROR_ACCESS_DENIED`; or a server whose token SID is an administrator's other than the current user.
  All three map to the administrator-account message, never to "helper unavailable" (which is reserved
  for exit 5 and squatted names).
- After `hello`: `subscribe`, `status`, then re-apply persisted settings in this order: `set_ipv6`,
  `set_autopause`, `exclude` for each persisted name present in `adapters`, `set_weight` for each
  persisted override, and finally `on` only if the user's persisted choice is on and the client decides
  to auto-start merging. The helper never turns merging on by itself.

### 10.7 Coexistence with a standalone net-merge install

- `lychee-netd` holds its own single-instance lock (`platform.SingleInstance`): the abstract Unix socket
  `@lychee-netd` on Linux, a flock on `/var/run/lychee-netd.lock` on macOS, the `Global\lychee-netd`
  mutex on Windows. A second `lychee-netd` fails with exit 4.
- Before taking its lock the helper probes net-merge's lock names (`@net-merge`,
  `/var/run/net-merge.lock`, `Global\net-merge`: the `InstanceRunning` checks of net-merge's
  `internal/platform`, kept for this purpose). If one is held, the helper exits 4 with
  `another connection-merging tool is running` on stderr, because both tools would install the same
  `/1` capture routes. Clients show that message for exit 4. A net-merge started _after_ `lychee-netd`
  does not know Lychee's lock; its own `route add` then fails (or, on Windows, the last route added
  wins) and the user removes one of the two tools.
- The adapters never collide: the helper's TUN is named `lychee-netd` (Linux, Windows) with its own fixed
  Wintun GUID; net-merge's is `net-merge`. Discovery (`nics.virtualName`) skips both names.
- There is no status file and there are no marker files: net-merge's `internal/state` is not ported, the
  channel is the only authority over merging state, and `net-merge on|off|status` from a terminal can
  neither see nor affect `lychee-netd`.

---

## 11. Security checklist

For the implementer of the PR and for the reviewers (S2 reviews the sudoers rule and the socket
security). Every line is a MUST unless marked otherwise.

**Transport and permissions**

- [ ] No TCP listener exists; `lychee-netd` has no `-pprof` flag.
- [ ] Root helpers accept exactly one control path per platform (section 2.2, 2.3); any other path is
      exit 3 before any filesystem change.
- [ ] Directory and socket checks use `lstat`; a symlink anywhere at the control path or its directory
      is a refusal.
- [ ] Root case: directory chain root-owned, no group/world write, verified on both the given and the
      symlink-resolved path (`/var` is a symlink on macOS).
- [ ] User case: `$XDG_RUNTIME_DIR` and the socket directory are owned by the uid and have no
      group/world bits.
- [ ] Stale socket: unlinked only if `S_IFSOCK`, owned by the expected owner, and `connect()` gives
      `ECONNREFUSED`; a live socket is exit 4; anything else is exit 3.
- [ ] Creation order: lock, directory, stale check, umask `0077` + `bind`, `chmod 0600`, `chown` to
      the authorized uid (root case), `listen`.
- [ ] Shutdown unlinks the socket only if its inode is the one created at startup.
- [ ] Windows: `FILE_FLAG_FIRST_PIPE_INSTANCE` on the first instance, `PIPE_REJECT_REMOTE_CLIENTS`,
      explicit DACL with only the listed principals and no deny ACE, at most 4 instances; the helper
      exits 5 instead of attaching to an existing name.
- [ ] Windows client verifies the server process SID before writing a byte.

**Authentication**

- [ ] Peer credentials are checked after `accept`/`ConnectNamedPipe` and before the first read, on
      every connection, with no exception for reconnects or `busy` refusals.
- [ ] Linux: `SO_PEERCRED` uid equals the authorized uid, and pid is non-zero; root is no exception.
- [ ] macOS: `LOCAL_PEERCRED` uid equals the authorized uid; `LOCAL_PEERPID` logged.
- [ ] Windows: `GetNamedPipeClientProcessId`, token user SID `EqualSid` to the authorized SID.
- [ ] Rejections close immediately without writing any byte and log uid/SID and pid.
- [ ] The authorized uid comes only from `PKEXEC_UID`, then `SUDO_UID`, then the real uid; values are
      validated as plain decimal integers; no other environment variable is read (plus
      `XDG_RUNTIME_DIR` in the user case).
- [ ] Windows authorized SID is the helper's own token user; the pipe name is derived from it and
      `--control` must match it exactly.

**macOS privileged install (S2)**

- [ ] Sudoers file `/etc/sudoers.d/lychee-netd`, mode `0440`, owned by `root:wheel`, exactly the two
      lines of section 3.3 (comment plus one rule), validated with `visudo -cf` on a temporary file
      before `rename`, read back and byte-compared by the setup step after the rename.
- [ ] The rule names `/Library/PrivilegedHelperTools/gg.tame.lychee.netd` with the exact argument vector
      `serve --control /var/run/lychee-netd/netd.sock`: no wildcards, no trailing `*`, no `""`
      empty-arguments variant, no `SETENV`, no second rule.
- [ ] Lychee launches exactly
      `sudo -n /Library/PrivilegedHelperTools/gg.tame.lychee.netd serve --control /var/run/lychee-netd/netd.sock`
      and checks `sudo -n -l` with that exact command line before every launch; anything else is "helper
      not installed".
- [ ] The binary is copied with `copyRootOwned` semantics (root-owned parents verified, temp file,
      `chown 0:0`, `0755`, rename).
- [ ] The helper's runtime self-check refuses a non-root-owned binary or a non-root-writable parent.
- [ ] Uninstall removes the rule, the binary and `/var/run/lychee-netd`.
- [ ] The install step verifies the helper it copies (SHA-256 against a hash embedded in the Lychee
      build, or the code signature once signing lands) and the plan's note about the window before
      that verification is acknowledged in the review.

**Windows privileged install**

- [ ] The scheduled task's action is the copy under `%ProgramFiles%\Lychee\helper`, never a path under
      `%LOCALAPPDATA%`; the elevated copy step verifies the folder ACL (write only for SYSTEM and
      Administrators) and the helper's signature or SHA-256 before registering or starting the task.
- [ ] `wintun.dll` is the unmodified WireGuard LLC-signed file, verified as `scripts/fetch-wintun.mjs`
      does (pinned SHA-256 and Authenticode signer).
- [ ] `serve` checks at start that its token is elevated and a member of Administrators and exits 6
      otherwise; a `RunLevel HighestAvailable` task started by a standard user never reaches adapter
      creation.
- [ ] The client checks Administrators membership on the linked token before launching, and maps exit 6,
      an `ERROR_ACCESS_DENIED` pipe with a live helper, and a server SID of another administrator to
      "Combining connections system-wide needs an administrator account on this PC", never to "helper
      unavailable".

**Protocol**

- [ ] Decoder: 64 KiB line limit enforced before buffering more, UTF-8 validated, NUL rejected,
      `DisallowUnknownFields` on every struct including nested `args`, numbers range-checked, booleans
      and enums strict.
- [ ] Allowlist is a closed `switch`; no reflection or dynamic dispatch on `cmd`.
- [ ] No request field is ever used as a path, program name, shell fragment, format string or
      unquoted log text. Adapter names are only compared with discovery results and used as map keys.
- [ ] Limits enforced: 16 in-flight, 4 pending connections, 5 s `hello` timeout, 30 s write stall,
      64-frame queue, 20 log events/s.
- [ ] `hello` is mandatory and first; `busy` refuses a second session; `quit` is the only way the client
      ends the helper apart from disconnecting.
- [ ] Merging starts `off`; nothing turns it on without an `on` request; `cleanup` only while
      `off`/`error`.
- [ ] Engine loops never block on the channel (dedicated writer, drop policy for `stats`/`log`).

**Process**

- [ ] `serve` accepts no flag but `--control`; `lychee-netd` has no `-log`, `-state-dir`, `-include`,
      `-weight`, `-mtu` or `-pprof` flag and no subcommand other than `serve` and `version`.
- [ ] System tools are run by absolute path with constant or discovery-derived arguments.
- [ ] The helper never re-launches itself elevated and never writes outside the control directory,
      except the Windows weak-host restore file `lychee-netd-weakhost.txt` in its own temp directory
      (section 10.5).
- [ ] No marker files or status file exist; net-merge's lock names are probed first (exit 4) and the
      single-instance lock is taken.
- [ ] Startup timeout and grace period exits are tested, so an orphaned helper never lingers.

---

## 12. Test plan

Tests for the implementation PR. Unit tests run without privileges on every platform the engine
builds on; privileged tests are gated behind the existing e2e scripts.

### 12.1 Structure

- `native/netd/internal/control` gets an `Engine` interface that the server depends on, implemented by the real
  engine wiring and by `fakeEngine` in tests:

  ```go
  type Engine interface {
      Snapshot() []engine.SlotStats
      Skipped() []nics.Skip
      DiscoverySeq() uint64
      On() error
      Off() error
      IsOn() bool
      TunName() string
      SetV6Mode(engine.V6Mode); V6Mode() engine.V6Mode; V6Allowed() bool; V6State() string
      SetExcluded(name string, excluded bool) error
      SetWeight(name string, weight float64, auto bool) error
      Cleanup() error
  }
  ```

- The server is constructed with a `net.Listener` (tests pass a Unix socket in `t.TempDir()`), a peer
  check function (tests inject one that returns chosen uids/pids), a clock (`now func() time.Time` plus
  timers that tests can fire), and the fake engine. The peer check and the transport creation of
  section 2 live in `transport_*.go` and are tested separately.

### 12.2 Framing and decoding (`native/netd/internal/control/server_frame_test.go`)

| Test                                                                    | Expectation                                                                                                                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TestFrameTooLargeCloses`                                               | a 65537-byte line gets `frame_too_large` with `id: null`, then EOF                                                                                 |
| `TestInvalidJSONCloses`                                                 | `{"id":1,` gets `bad_request`, EOF                                                                                                                 |
| `TestNonObjectCloses`                                                   | `[1,2]` and `"x"` get `bad_request`, EOF                                                                                                           |
| `TestInvalidUTF8Closes`, `TestNULByteCloses`                            | `bad_request`, EOF                                                                                                                                 |
| `TestEmptyLinesIgnored`                                                 | `\n\n{"id":1,...}` is answered normally                                                                                                            |
| `TestUnknownTopLevelField`                                              | `{"id":1,"cmd":"status","extra":1}` gets `unknown_field` with `data.field = "extra"`, connection open                                              |
| `TestUnknownArgField`                                                   | `subscribe` with `{"interval":1}` gets `unknown_field` `args.interval`                                                                             |
| `TestWrongType`                                                         | `set_autopause` with `{"enabled":"yes"}`, `{"enabled":1}` get `bad_request`                                                                        |
| `TestMissingId`, `TestZeroId`, `TestFloatId`, `TestDuplicateInFlightId` | `bad_request`, EOF                                                                                                                                 |
| `TestUnknownCommand`                                                    | `unknown_command`, open                                                                                                                            |
| `TestInFlightLimit`                                                     | 17 requests without reading responses: 16 answered, then `too_many_requests`, EOF                                                                  |
| `TestResponsesInOrder`                                                  | ids 5,3,9 sent pipelined are answered 5,3,9                                                                                                        |
| `FuzzRequestDecoder`                                                    | Go native fuzzing of the decoder: never panics, never allocates beyond the limit, every outcome is one of the documented errors or a valid request |

### 12.3 Handshake and sessions (`native/netd/internal/control/server_session_test.go`)

| Test                                | Expectation                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TestHelloRequired`                 | `status` first gets `hello_required`, EOF                                                                                                                 |
| `TestHelloTimeout`                  | no frame for 5 s (fake clock) closes with `hello_required`                                                                                                |
| `TestHelloVersionMismatch`          | `protocol:[2]` gets `version_unsupported` with `supported:[1]`, EOF                                                                                       |
| `TestHelloPicksHighest`             | `protocol:[1,7]` on a helper supporting 1 gives 1                                                                                                         |
| `TestHelloBadClientName`            | `client:"a b"` gets `bad_request`, EOF                                                                                                                    |
| `TestHelloResultFields`             | every field of section 5.2 present with the documented types; `instance` is 32 hex chars; `limits` match section 1.5                                      |
| `TestStateEventAfterHello`          | the first frame after the `hello` response is a `state` event with `seq: 1`                                                                               |
| `TestSecondHelloInvalidState`       | `invalid_state`, session continues                                                                                                                        |
| `TestBusy`                          | a second connection's `hello` gets `busy` with the first client's pid, EOF; the first session is unaffected                                               |
| `TestPendingConnectionCap`          | a fifth connection awaiting `hello` is closed without bytes                                                                                               |
| `TestGraceExitsHelper`              | session drops without `quit`; after 10 s (fake clock) the engine's `Off` was called and the server returned                                               |
| `TestGracePreservesState`           | `on`, `exclude`, `set_weight`, drop, reconnect at 9 s: `hello` reports the same `instance`, `session: 2`, `status` shows state preserved, no subscription |
| `TestGraceRestartsAfterFailedHello` | reconnect at 8 s, send garbage; timer restarts; exit at 18 s                                                                                              |
| `TestStartupTimeout`                | no connection for 30 s exits                                                                                                                              |
| `TestQuit`                          | response, then engine `Off`, then EOF; socket unlinked                                                                                                    |
| `TestSignalIsQuit`                  | SIGTERM runs the same shutdown                                                                                                                            |

### 12.4 Commands and state machine (`native/netd/internal/control/server_cmd_test.go`)

| Test                                | Expectation                                                                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TestStartsOff`                     | fresh helper: `status.state = off`, `autopause.status = manual_off`, fake engine `On` never called                                                                           |
| `TestOnOffIdempotent`               | `on` twice calls engine `On` once; `off` twice is fine                                                                                                                       |
| `TestOnEmitsStateEvents`            | `starting` then `on` events precede the response                                                                                                                             |
| `TestOnFailureSetsError`            | engine `On` returns an error: response `internal`, state `error` with the message, `off` clears it                                                                           |
| `TestOnNoAdapters`                  | empty snapshot: `no_adapters`                                                                                                                                                |
| `TestOnUnsupportedPlatform`         | `capture.available=false`: `unsupported_platform`                                                                                                                            |
| `TestAutopauseStates`               | drive `autoPauser` through `held`, `armed`, `waiting`, `manual_off`, `disabled`, `idle` with the fake clock and check `autopause.status` and `state = paused_auto`           |
| `TestAutopauseNeverStartsWithoutOn` | enabled, two usable adapters, no `on`: stays `off` forever                                                                                                                   |
| `TestSetIPv6`                       | each mode round-trips; `effective` follows `V6Allowed`; invalid string is `bad_request`                                                                                      |
| `TestExcludeInclude`                | unknown name is `unknown_adapter`; known name sets the flag, engine `SetExcluded` called; idempotent; excluded adapter appears in stats with `excluded: true` and link rates |
| `TestSetWeight`                     | 0.049 and 100.1 are `out_of_range` with `min`/`max`; `"auto"` clears; `"Auto"` and `true` are `bad_request`; `weight_mode` reported                                          |
| `TestListAdaptersCaps`              | 70 adapters: 64 returned, `truncated: true`                                                                                                                                  |
| `TestCleanupOnlyWhenOff`            | `invalid_state` with `data.state` while `on` and `paused_auto`; succeeds while `off` and `error`                                                                             |
| `TestStringsNeverReachExec`         | the fake engine records every string it receives; a request with an adapter name containing `; rm -rf` is `unknown_adapter` and the name never reaches the engine            |

### 12.5 Stats stream (`native/netd/internal/control/server_stats_test.go`)

| Test                         | Expectation                                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TestSubscribeIntervalRange` | 249 and 5001 are `out_of_range`; default is 1000; re-subscribe changes the interval                                                                                                                                          |
| `TestStatsFieldMapping`      | a `SlotStats` with every field set to a distinct value produces exactly the JSON of Appendix A, including the state string mapping and integer truncation                                                                    |
| `TestStatsWhileOff`          | stats events arrive while `off` with non-zero link rates from the fake                                                                                                                                                       |
| `TestTotals`                 | sums over present adapters only, excluded included, absent excluded                                                                                                                                                          |
| `TestStatsFrameFits`         | 64 adapters with 256-byte names stay under 65536 bytes                                                                                                                                                                       |
| `TestSeqMonotonic`           | `seq` increases by 1 across `stats`, `state` and `log` events                                                                                                                                                                |
| `TestBackpressureDropsStats` | a client that stops reading: after the queue fills, `dropped` grows, `seq` has gaps, a `state` change still closes the connection only when its enqueue fails; a `status` response is never dropped while the queue has room |
| `TestWriteStallCloses`       | a client that never reads is disconnected after 30 s and the grace timer starts                                                                                                                                              |
| `TestLogRateLimit`           | 100 warnings in a second: at most 20 delivered, the rest counted                                                                                                                                                             |

### 12.6 Transport and peer credentials (`native/netd/internal/control/transport_*_test.go`)

| Test                                                                           | Platform                | Expectation                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TestPeerCheckRejectsOtherUid`                                                 | Linux, root only        | the real `SO_PEERCRED` check on a temp socket created `0666`, with `PKEXEC_UID` naming uid 65534: a child running as 65534 completes `hello`; children running as root and as uid 1000 are closed without a byte, and both refusals are logged                        |
| `TestPeerCheckAcceptsOnlySocketOwner`, `TestRefusedPeerGetsNoBytes`            | all Unix                | injected credentials: the authorized uid accepted; uid 0 and another uid refused with uid and pid in the error; `PKEXEC_UID=0` makes root the owner; through the server, a refused connection gets no bytes and `peer rejected: uid=0 pid=1 not authorized` is logged |
| `TestPeerCheckDecision`                                                        | all                     | injected `pid: 0` rejected on Linux and ignored on macOS                                                                                                                                                                                                              |
| `TestSocketModeAndOwner`                                                       | all Unix                | after start: `lstat` mode `0600`, owner as specified; directory `0700`/`0755`                                                                                                                                                                                         |
| `TestRefusesSymlinkPath`, `TestRefusesRegularFile`, `TestRefusesForeignSocket` | all Unix                | exit 3 paths, nothing unlinked                                                                                                                                                                                                                                        |
| `TestStaleSocketReplaced`                                                      | all Unix                | a dead socket at the path is unlinked and replaced                                                                                                                                                                                                                    |
| `TestLiveSocketRefused`                                                        | all Unix                | a listening socket at the path: exit 4, not unlinked                                                                                                                                                                                                                  |
| `TestRootRequiresFixedPath`                                                    | Linux, macOS, root only | `--control /tmp/x.sock` as root: exit 3                                                                                                                                                                                                                               |
| `TestXDGRuntimeDirChecks`                                                      | Linux                   | unset, relative, wrong owner, `0755`: exit 3                                                                                                                                                                                                                          |
| `TestSelfCheck`                                                                | macOS, Linux root       | a copy of the test binary in a user-writable directory fails the self-check                                                                                                                                                                                           |
| `TestPipeFirstInstance`                                                        | Windows                 | pre-create the pipe name: helper exits 5                                                                                                                                                                                                                              |
| `TestPipeDACL`                                                                 | Windows                 | the created pipe's security descriptor, converted to SDDL, contains exactly the ACEs of section 2.4                                                                                                                                                                   |
| `TestPipeNameMustMatchSID`                                                     | Windows                 | `--control \\.\pipe\lychee-netd-S-1-5-18`: exit 3                                                                                                                                                                                                                     |
| `TestPipeClientSidCheck`                                                       | Windows                 | own process accepted; rejection of another user is a manual test (below)                                                                                                                                                                                              |
| `TestWindowsRequiresElevatedToken`                                             | Windows                 | `serve` started under a restricted token (`CreateRestrictedToken` with `DISABLE_MAX_PRIVILEGE`, or `runas /trustlevel:0x20000`) exits 6 before creating the pipe or touching Wintun; under the test's elevated token the check passes                                 |
| `TestRefusesNetMergeLock`                                                      | all                     | with `@net-merge` / `/var/run/net-merge.lock` / `Global\net-merge` pre-held by the test: exit 4, stderr `another connection-merging tool is running`, nothing created                                                                                                 |
| `TestFuzzPeerCheckInputs`                                                      | all                     | the credential parsing (`PKEXEC_UID`, `SUDO_UID`) rejects `"1000x"`, `"-1"`, `" 1000"`, `""`, `"99999999999"`                                                                                                                                                         |

### 12.7 End-to-end and manual

- `native/netd/scripts/linux-e2e.sh` gains a helper run: start `sudo lychee-netd serve --control
/run/lychee-netd/netd.sock` with `SUDO_UID` set to the test user; a small Go or Python client
  running as that user does `hello`, `subscribe`, `on`; verify traffic uses both uplinks as the existing
  test does; `kill -9` the helper; verify routes are gone and the socket is stale; start again; verify
  the stale socket was replaced; `quit`; verify exit 0 and no socket.
- `native/netd/scripts/macos-smoke.sh`: the same with `sudo -n` through a temporary sudoers file written
  exactly as section 3.3; verify `visudo -cf` passes, that `sudo -n -l` accepts exactly the launch
  command line and refuses `version`, a different control path and a trailing argument; verify a second
  user account (created for the test or documented as manual) gets EOF without bytes.
- Windows manual checklist: squat the pipe from a second account and verify exit 5 and the client's
  "helper unavailable"; connect from a second account and verify the rejection is logged; verify the
  task's action path and the folder ACL. Standard-account check: sign in as a standard
  (non-administrator) user, enable merging, answer the UAC credential prompt as an administrator, and
  verify that Lychee shows "Combining connections system-wide needs an administrator account on this
  PC" (not "helper unavailable"), that no pipe named for the standard user's SID exists, that a helper
  started by the task, if any, exited 6, and that no `lychee-netd` adapter was created.
- Lychee's fake netd for its e2e suite (plan L-3, `LYCHEE_E2E_NETD`) MUST speak exactly the frames in
  Appendix B so both implementations are tested against the same transcript.

---

## Appendix A: SlotStats field mapping

| JSON field (`adapters[]`) | `engine.SlotStats` | Conversion                                                                         |
| ------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `name`                    | `Name`             | as is                                                                              |
| `ip`                      | `IP`               | `""` becomes `null`                                                                |
| `ip6`                     | `IP6`              | `""` becomes `null`                                                                |
| `present`                 | `Present`          | as is                                                                              |
| `excluded`                | (exclusion set)    | `true` if `Name` is excluded                                                       |
| `state`                   | `State`            | `"-"`→`"none"`, `"checking"`→`"checking"`, `"up"`→`"up"`, `"no internet"`→`"down"` |
| `state6`                  | `State6`           | same mapping                                                                       |
| `weight`                  | `Weight`           | number as is                                                                       |
| `weight6`                 | `Weight6`          | number as is                                                                       |
| `weight_mode`             | (override table)   | `"manual"` if an override exists for `Name`, else `"auto"`                         |
| `peak_bps`                | `Peak`             | `int64(math.Trunc(v))`                                                             |
| `peak6_bps`               | `Peak6`            | same                                                                               |
| `active_flows`            | `Active`           | as is                                                                              |
| `total_flows`             | `Total`            | as is                                                                              |
| `failed_flows`            | `Failed`           | as is                                                                              |
| `link_in_bps`             | `LinkIn`           | truncated to integer                                                               |
| `link_out_bps`            | `LinkOut`          | truncated to integer                                                               |
| `relayed_in_bps`          | `RateIn`           | truncated to integer                                                               |
| `relayed_out_bps`         | `RateOut`          | truncated to integer                                                               |
| `bytes_in`                | `BytesIn`          | as is                                                                              |
| `bytes_out`               | `BytesOut`         | as is                                                                              |

Fields of `Snapshot` outside `adapters[]`: `totals.*` are sums of the above over `present == true`;
`ipv6.detail` is `Balancer.V6State()`; `ipv6.mode` is `Balancer.V6Mode()` as `auto`/`on`/`off`;
`ipv6.effective` is `Balancer.V6Allowed()`; `tun.name` is the name passed to `configure` (Linux,
Windows: `lychee-netd`; macOS: the kernel-assigned `utunN`); `autopause.*` from the `autoPauser`
(section 10.1).

## Appendix B: example session

Client to helper lines are marked `>`; helper to client lines `<`. Each line is one frame.

```
> {"id":1,"cmd":"hello","args":{"protocol":[1],"client":"lychee","client_version":"0.2.0"}}
< {"id":1,"ok":true,"result":{"protocol":1,"helper_version":"0.2.0","os":"darwin","arch":"arm64","pid":5120,"instance":"3f9c2a7e5b1d4c6a8e0f1a2b3c4d5e6f","session":1,"auth":{"model":"unix_peer_uid","privilege":"root","authorized_uid":501},"capabilities":["link_counters","keep_adapter_on_off"],"limits":{"max_frame":65536,"max_in_flight":16,"hello_timeout_ms":5000,"grace_ms":10000,"startup_timeout_ms":30000,"stats_interval_ms":{"min":250,"max":5000,"default":1000},"weight":{"min":0.05,"max":100}},"capture":{"available":true,"error":null}}}
< {"event":"state","seq":1,"data":{"ts":1760000000000,"state":"off","state_since":1759999999500,"error":null,"capture":{"available":true,"error":null},"autopause":{"enabled":true,"status":"manual_off"},"ipv6":{"mode":"auto","effective":"refused","detail":"auto: refused, apps fall back to IPv4 so every adapter is used (not every adapter has IPv6)"},"tun":{"name":null,"open":false}}}
> {"id":2,"cmd":"subscribe","args":{"interval_ms":1000}}
< {"id":2,"ok":true,"result":{"interval_ms":1000}}
< {"event":"stats","seq":2,"data":{"ts":1760000000010,"state":"off", ... "adapters":[{"name":"en0", ...},{"name":"en7", ...}],"discovery_seq":1,"dropped":0}}
> {"id":3,"cmd":"set_ipv6","args":{"mode":"auto"}}
< {"id":3,"ok":true,"result":{"mode":"auto","effective":"refused"}}
> {"id":4,"cmd":"exclude","args":{"adapter":"en7"}}
< {"id":4,"ok":true,"result":{"adapter":"en7","excluded":true}}
> {"id":5,"cmd":"on"}
< {"event":"state","seq":3,"data":{"ts":1760000001000,"state":"starting", ...}}
< {"event":"state","seq":4,"data":{"ts":1760000001350,"state":"on","state_since":1760000001350, ... "autopause":{"enabled":true,"status":"held"},"ipv6":{"mode":"auto", ... },"tun":{"name":"utun5","open":true}}}
< {"id":5,"ok":true,"result":{"state":"on"}}
< {"event":"stats","seq":5,"data":{ ... "state":"on", ... }}
> {"id":6,"cmd":"exclude","args":{"adapter":"en9"}}
< {"id":6,"ok":false,"error":{"code":"unknown_adapter","message":"no adapter named \"en9\"","data":{"adapter":"en9"}}}
> {"id":7,"cmd":"cleanup"}
< {"id":7,"ok":false,"error":{"code":"invalid_state","message":"cleanup is only allowed while off","data":{"state":"on"}}}
> {"id":8,"cmd":"quit"}
< {"event":"state","seq":6,"data":{"ts":1760000020000,"state":"off", ... "tun":{"name":null,"open":false}}}
< {"id":8,"ok":true,"result":{}}
(EOF)
```

A refused second client, while the session above is open:

```
> {"id":1,"cmd":"hello","args":{"protocol":[1],"client":"lychee","client_version":"0.2.0"}}
< {"id":1,"ok":false,"error":{"code":"busy","message":"another client session is active","data":{"session_pid":4098}}}
(EOF)
```

A connection from the wrong uid receives nothing and sees EOF.

Notes on this transcript (informative):

- Lines containing `...` are elided; only the parts shown are normative, in the order shown. Key order
  is not significant (section 4.1).
- Between `ts` 1760000001350 and the `quit` at 1760000020000 a real helper would send about 18 more
  `stats` events at the subscribed 1000 ms interval; they are omitted for brevity. A test replay may
  jump its clock without firing them.
- `en7` is excluded before `on`, which leaves one usable adapter, so `autopause.status` is `held`
  (section 10.1).

## Appendix C: TypeScript sketch

Informative types for the client (`src/main/network/merge/netdClient.ts`); the tables above are normative.

```ts
type Req = { id: number; cmd: Cmd; args?: object }
type Cmd =
  | 'hello'
  | 'status'
  | 'subscribe'
  | 'unsubscribe'
  | 'on'
  | 'off'
  | 'set_ipv6'
  | 'set_autopause'
  | 'exclude'
  | 'include'
  | 'set_weight'
  | 'list_adapters'
  | 'cleanup'
  | 'quit'
type Res =
  | { id: number | null; ok: true; result: object }
  | { id: number | null; ok: false; error: { code: ErrorCode; message: string; data?: object } }
type Ev =
  | { event: 'stats'; seq: number; data: Snapshot & { dropped: number } }
  | { event: 'state'; seq: number; data: StateInfo }
  | { event: 'log'; seq: number; data: { level: string; message: string } }
  | { event: string; seq: number; data: object } // unknown events are ignored
type MergeState = 'off' | 'starting' | 'on' | 'paused_auto' | 'error' | (string & {})
type AutopauseStatus =
  'disabled' | 'armed' | 'held' | 'waiting' | 'manual_off' | 'idle' | (string & {})
interface StateInfo {
  ts: number
  state: MergeState
  state_since: number
  error: { message: string } | null
  capture: { available: boolean; error: string | null }
  autopause: { enabled: boolean; status: AutopauseStatus }
  ipv6: { mode: 'auto' | 'on' | 'off'; effective: 'balanced' | 'refused'; detail: string }
  tun: { name: string | null; open: boolean }
}
interface Snapshot extends StateInfo {
  totals: {
    link_in_bps: number
    link_out_bps: number
    relayed_in_bps: number
    relayed_out_bps: number
    active_flows: number
    adapters_present: number
    adapters_usable: number
  }
  adapters: Adapter[]
  discovery_seq: number
}
interface Adapter {
  name: string
  ip: string | null
  ip6: string | null
  present: boolean
  excluded: boolean
  state: LinkState
  state6: LinkState
  weight: number
  weight6: number
  weight_mode: 'auto' | 'manual'
  peak_bps: number
  peak6_bps: number
  active_flows: number
  total_flows: number
  failed_flows: number
  link_in_bps: number
  link_out_bps: number
  relayed_in_bps: number
  relayed_out_bps: number
  bytes_in: number
  bytes_out: number
}
type LinkState = 'none' | 'checking' | 'up' | 'down'
type ErrorCode =
  | 'bad_request'
  | 'frame_too_large'
  | 'too_many_requests'
  | 'unknown_command'
  | 'unknown_field'
  | 'hello_required'
  | 'version_unsupported'
  | 'busy'
  | 'invalid_state'
  | 'unknown_adapter'
  | 'out_of_range'
  | 'no_adapters'
  | 'unsupported_platform'
  | 'permission_denied'
  | 'internal'
```
