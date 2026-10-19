#!/usr/bin/env bash
# End-to-end test of lychee-netd's system-wide mode on Linux. Needs sudo and internet access. A
# machine with one NIC gets a second "uplink": a veth pair into a network namespace that NATs back
# out through the real NIC. The helper is driven over its control channel, not a status file.
#
#   host nlup-h 10.77.0.1  <->  ns nlup-n 10.77.0.2   (the second uplink to balance over)
#   ns   nlgw-n 10.88.0.2  <->  host nlgw-h 10.88.0.1 (the namespace's way out, NATed by the host)
#
# usage: scripts/linux-e2e.sh /abs/path/to/lychee-netd
set -uo pipefail
BIN=$(realpath "${1:-../../build/netd/linux-x64/lychee-netd}")
HERE=$(cd "$(dirname "$0")" && pwd)
SOCK=/run/lychee-netd/netd.sock
REAL=$(ip -4 route show default | awk '{print $5; exit}')
fails=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; fails=$((fails + 1)); }

CLIENT_IN=$(mktemp -u)
HELPER_PID=""
cleanup() {
  [ -n "$HELPER_PID" ] && sudo kill "$HELPER_PID" 2>/dev/null
  rm -f "$CLIENT_IN"
  sudo ip netns del nlup 2>/dev/null
  sudo ip link del nlup-h 2>/dev/null
  sudo ip link del nlgw-h 2>/dev/null
  sudo ip rule del iif nlgw-h lookup 100 2>/dev/null
  sudo ip route flush table 100 2>/dev/null
  sudo iptables -t nat -D POSTROUTING -s 10.88.0.0/24 -o "$REAL" -j MASQUERADE 2>/dev/null
}
trap cleanup EXIT

echo "== real uplink: $REAL"
echo "== building the second uplink"
sudo ip netns add nlup
sudo ip link add nlup-h type veth peer name nlup-n netns nlup
sudo ip link add nlgw-h type veth peer name nlgw-n netns nlup
sudo ip addr add 10.77.0.1/24 dev nlup-h && sudo ip link set nlup-h up
sudo ip addr add 10.88.0.1/24 dev nlgw-h && sudo ip link set nlgw-h up
sudo ip netns exec nlup sh -ec '
  ip link set lo up
  ip addr add 10.77.0.2/24 dev nlup-n && ip link set nlup-n up
  ip addr add 10.88.0.2/24 dev nlgw-n && ip link set nlgw-n up
  ip route add default via 10.88.0.1
  sysctl -qw net.ipv4.ip_forward=1 net.ipv4.conf.all.rp_filter=0
  iptables -t nat -A POSTROUTING -o nlgw-n -j MASQUERADE'
sudo sysctl -qw net.ipv4.ip_forward=1 net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.nlup-h.rp_filter=0
sudo iptables -t nat -A POSTROUTING -s 10.88.0.0/24 -o "$REAL" -j MASQUERADE
gw=$(ip -4 route show default dev "$REAL" | awk '{print $3; exit}')
sudo ip route add default ${gw:+via $gw} dev "$REAL" table 100
sudo ip rule add iif nlgw-h lookup 100 priority 90

echo "== starting lychee-netd serve as root (SUDO_UID = $(id -u))"
mkfifo "$CLIENT_IN"
sudo SUDO_UID="$(id -u)" "$BIN" serve --control "$SOCK" &
HELPER_PID=$!
for _ in $(seq 1 40); do [ -S "$SOCK" ] && break; sleep 0.25; done
[ -S "$SOCK" ] && pass "control socket created at $SOCK" || { fail "no control socket"; exit 1; }

# A long-lived control session: keep the fifo open, feed it commands, collect frames.
( tail -f "$CLIENT_IN" & echo $! >/tmp/nl-tail.pid ) | go run "$HERE/smokeclient.go" "$SOCK" >/tmp/nl-frames.log 2>&1 &
sleep 1
echo subscribe >"$CLIENT_IN"
echo on >"$CLIENT_IN"
sleep 5
grep -q '"state":"on"' /tmp/nl-frames.log && pass "merging turned on over the control channel" || fail "helper did not report state on"

routes=$(ip -4 route show dev lychee-netd)
grep -q '0.0.0.0/1' <<<"$routes" && grep -q '128.0.0.0/1' <<<"$routes" &&
  pass "capture routes present on lychee-netd" || fail "capture routes missing: $routes"
mtu=$(cat /sys/class/net/lychee-netd/mtu 2>/dev/null)
[ "$mtu" = 9000 ] && pass "TUN MTU is 9000" || fail "TUN MTU is $mtu, want 9000"

code=$(curl -4 -s --max-time 10 -o /dev/null -w '%{http_code}' https://example.com)
[ "$code" = 200 ] && pass "HTTPS works through lychee-netd" || fail "HTTPS through lychee-netd: $code"

echo "== off: adapter and routes go away, internet still works"
echo off >"$CLIENT_IN"
sleep 2
ip link show lychee-netd >/dev/null 2>&1 && fail "adapter still exists after off" || pass "adapter removed after off"
code=$(curl -4 -s --max-time 10 -o /dev/null -w '%{http_code}' https://example.com)
[ "$code" = 200 ] && pass "internet works after off" || fail "internet after off: $code"

echo "== crash: kill -9 the helper must not leave the machine offline, and the socket is stale"
echo on >"$CLIENT_IN"; sleep 3
sudo kill -9 "$HELPER_PID"; HELPER_PID=""
sleep 1
ip link show lychee-netd >/dev/null 2>&1 && fail "adapter survived kill -9" || pass "adapter gone after kill -9"
code=$(curl -4 -s --max-time 10 -o /dev/null -w '%{http_code}' https://example.com)
[ "$code" = 200 ] && pass "internet works after kill -9" || fail "internet after kill -9: $code"

echo "== restart replaces the stale socket, then quit exits cleanly"
sudo SUDO_UID="$(id -u)" "$BIN" serve --control "$SOCK" &
HELPER_PID=$!
for _ in $(seq 1 40); do [ -S "$SOCK" ] && break; sleep 0.25; done
go run "$HERE/smokeclient.go" "$SOCK" quit >/dev/null 2>&1 || true
sleep 1
kill -0 "$HELPER_PID" 2>/dev/null && fail "helper still running after quit" || { pass "helper exited after quit"; HELPER_PID=""; }
[ -S "$SOCK" ] && fail "socket left behind after quit" || pass "socket unlinked after quit"

echo
[ "$fails" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "$fails CHECK(S) FAILED"
exit "$fails"
