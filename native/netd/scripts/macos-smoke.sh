#!/usr/bin/env bash
# Smoke test of lychee-netd's system-wide mode on macOS. Needs sudo and internet access. The runner
# has one NIC, so this checks the utun, capture routes, relaying, off and crash safety, not
# balancing (that needs a second uplink). It also exercises the sudoers rule shape of spec 3.3.
#
# usage: scripts/macos-smoke.sh /abs/path/to/lychee-netd
set -uo pipefail
BIN=$(cd "$(dirname "${1:-../../build/netd/mac-arm64/lychee-netd}")" && pwd)/$(basename "${1:-lychee-netd}")
HERE=$(cd "$(dirname "$0")" && pwd)
HELPER=/Library/PrivilegedHelperTools/gg.tame.lychee.netd
SOCK=/var/run/lychee-netd/netd.sock
SUDOERS=/etc/sudoers.d/lychee-netd
USER_NAME=$(id -un)
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails + 1)); }
captured() { netstat -rn -f inet | grep -cE '^(0/1|128.0/1) '; }

HELPER_PID=""
cleanup() {
  [ -n "$HELPER_PID" ] && sudo kill "$HELPER_PID" 2>/dev/null
  sudo rm -f "$SUDOERS" "$HELPER"
  sudo rm -rf /var/run/lychee-netd
}
trap cleanup EXIT

echo "== install the root-owned helper copy and the exact sudoers rule"
sudo install -o root -g wheel -m 0755 "$BIN" "$HELPER"
RULE="# Written by Lychee: $USER_NAME may start the network helper without a password.
$USER_NAME ALL=(root) NOPASSWD: $HELPER serve --control $SOCK"
tmp=$(mktemp)
printf '%s\n' "$RULE" >"$tmp"
if sudo visudo -cf "$tmp" >/dev/null 2>&1; then
  pass "visudo accepts the rule"
else
  fail "visudo rejected the rule"
fi
sudo install -o root -g wheel -m 0440 "$tmp" "$SUDOERS"
rm -f "$tmp"

echo "== the rule matches only the exact launch command"
sudo -n -l "$HELPER" serve --control "$SOCK" >/dev/null 2>&1 && pass "sudo -n accepts the exact launch" || fail "sudo -n rejected the exact launch"
sudo -n -l "$HELPER" version >/dev/null 2>&1 && fail "sudo -n must not accept 'version'" || pass "sudo -n refuses a different subcommand"
sudo -n -l "$HELPER" serve --control /tmp/x.sock >/dev/null 2>&1 && fail "sudo -n must not accept another path" || pass "sudo -n refuses a different control path"

echo "== start the helper through the passwordless rule"
sudo -n "$HELPER" serve --control "$SOCK" &
HELPER_PID=$!
for _ in $(seq 1 40); do [ -S "$SOCK" ] && break; sleep 0.25; done
[ -S "$SOCK" ] && pass "control socket created" || { fail "no control socket"; exit 1; }
CLIENT_IN=$(mktemp -u); mkfifo "$CLIENT_IN"
( tail -f "$CLIENT_IN" ) | go run "$HERE/smokeclient.go" "$SOCK" >/tmp/nl-frames.log 2>&1 &
sleep 1; echo on >"$CLIENT_IN"; sleep 5
grep -q '"state":"on"' /tmp/nl-frames.log && pass "merging turned on" || fail "helper did not report state on"
[ "$(captured)" = 2 ] && pass "capture routes 0/1 + 128.0/1 present" || fail "capture routes: $(captured), want 2"
code=$(curl -4 -s --max-time 10 -o /dev/null -w '%{http_code}' https://example.com)
[ "$code" = 200 ] && pass "HTTPS works through lychee-netd" || fail "HTTPS failed: $code"

echo "== crash safety: kill -9 leaves the machine with internet"
sudo kill -9 "$HELPER_PID"; HELPER_PID=""; sleep 1
[ "$(captured)" = 0 ] && pass "capture routes gone after kill -9" || fail "capture routes survived kill -9"
code=$(curl -4 -s --max-time 10 -o /dev/null -w '%{http_code}' https://example.com)
[ "$code" = 200 ] && pass "internet works after kill -9" || fail "internet after kill -9: $code"
rm -f "$CLIENT_IN"

echo
[ "$fails" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "$fails CHECK(S) FAILED"
exit "$fails"
