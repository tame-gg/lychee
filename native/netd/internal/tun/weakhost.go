package tun

import "strings"

const weakHostFileName = "lychee-netd-weakhost.txt"

func weakHostRestoreLine(psLine string) (string, bool) {
	f := strings.Fields(strings.ToLower(psLine))
	if len(f) != 4 {
		return "", false
	}
	line := f[0] + " " + f[1] + " weakhostsend=" + f[2] + " forwarding=" + f[3]
	if _, ok := parseWeakHostLine(line); !ok {
		return "", false
	}
	return line, true
}

func parseWeakHostLine(line string) ([]string, bool) {
	f := strings.Fields(line)
	if len(f) != 4 || (f[0] != "ipv4" && f[0] != "ipv6") || !interfaceIndex(f[1]) {
		return nil, false
	}
	seen := map[string]bool{}
	for _, kv := range f[2:] {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || (k != "weakhostsend" && k != "forwarding") || (v != "enabled" && v != "disabled") || seen[k] {
			return nil, false
		}
		seen[k] = true
	}
	return f, true
}

func interfaceIndex(s string) bool {
	if s == "" || len(s) > 9 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
