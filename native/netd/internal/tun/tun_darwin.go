package tun

import (
	"fmt"
	"net"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/tame-gg/lychee/native/netd/internal/logx"
	"github.com/tame-gg/lychee/native/netd/internal/nics"
)

const openHint = "needs root"

func init() {
	openName = "utun"
	staleHook = cleanupScoped
	keepDevice = true
}

func configure(name string, _ int) (int, []string, error) {
	ifc, err := net.InterfaceByName(name)
	if err != nil {
		return 0, nil, fmt.Errorf("adapter %q did not appear: %w", name, err)
	}

	if err := startScopedSync(); err != nil {
		return ifc.Index, nil, err
	}
	if err := run("/sbin/ifconfig", name, "inet", tunIP, tunIP, "up"); err != nil {
		return ifc.Index, nil, err
	}
	for _, dst := range routes4 {
		if err := run("/sbin/route", "-q", "-n", "add", "-inet", dst, "-interface", name); err != nil {
			return ifc.Index, nil, err
		}
	}

	if err := run("/sbin/ifconfig", name, "inet6", tunIP6, "prefixlen", "64", "alias"); err != nil {
		return ifc.Index, []string{fmt.Sprintf("warning: IPv6 not captured: %v", err)}, nil
	}
	var notes []string
	for _, dst := range routes6 {
		if err := run("/sbin/route", "-q", "-n", "add", "-inet6", dst, "-interface", name); err != nil {
			notes = append(notes, fmt.Sprintf("warning: IPv6 route %s: %v", dst, err))
		}
	}
	return ifc.Index, notes, nil
}

func delRoutes(idx int) {
	defer stopScopedSync()
	ifc, err := net.InterfaceByIndex(idx)
	if err != nil {
		return
	}
	for _, dst := range routes4 {
		run("/sbin/route", "-q", "-n", "delete", "-inet", dst, "-interface", ifc.Name)
	}
	for _, dst := range routes6 {
		run("/sbin/route", "-q", "-n", "delete", "-inet6", dst, "-interface", ifc.Name)
	}
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

var realName = regexp.MustCompile(`^(en|feth)\d+$`)

type scopedKey struct {
	name string
	v6   bool
}

var scoped struct {
	mu    sync.Mutex
	added map[scopedKey]string
	stop  chan struct{}
}

func scopedArgs(verb string, k scopedKey, gw string) []string {
	fam := "-inet"
	if k.v6 {
		fam, gw = "-inet6", gw+"%"+k.name
	}
	return []string{"-q", "-n", verb, fam, "default", gw, "-ifscope", k.name}
}

func startScopedSync() error {
	stop := make(chan struct{})
	scoped.mu.Lock()
	scoped.stop, scoped.added = stop, map[scopedKey]string{}
	scoped.mu.Unlock()
	if err := syncScoped(stop); err != nil {
		stopScopedSync()
		return fmt.Errorf("scoped routes: %w", err)
	}
	go func() {
		t := time.NewTicker(3 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if err := syncScoped(stop); err != nil {
					logx.Printf("warning: scoped routes: %v\n", err)
				}
			}
		}
	}()
	return nil
}

func stopScopedSync() {
	routes, _ := nics.DefaultRoutes()
	scoped.mu.Lock()
	defer scoped.mu.Unlock()
	if scoped.stop != nil {
		close(scoped.stop)
		scoped.stop = nil
	}
	primary := map[scopedKey]bool{}
	for _, r := range routes {
		if !r.Scoped && r.GW != nil {
			primary[scopedKey{r.Name, r.V6}] = true
		}
	}
	for k, gw := range scoped.added {

		if routes == nil || primary[k] {
			run("/sbin/route", scopedArgs("delete", k, gw)...)
		}
	}
	scoped.added = nil
}

func syncScoped(stop chan struct{}) error {
	routes, err := nics.DefaultRoutes()
	if err != nil {
		return err
	}
	want := map[scopedKey]string{}
	have := map[scopedKey]bool{}
	for _, r := range routes {
		if !realName.MatchString(r.Name) {
			continue
		}
		k := scopedKey{r.Name, r.V6}
		if r.Scoped {
			have[k] = true
		} else if r.GW != nil {
			want[k] = r.GW.String()
		}
	}
	scoped.mu.Lock()
	defer scoped.mu.Unlock()
	if scoped.stop != stop {
		return nil
	}
	var first error
	for k, gw := range want {
		old, ours := scoped.added[k]
		switch {
		case ours && old == gw && have[k]:
			continue
		case !ours && have[k]:
			continue
		case ours:
			run("/sbin/route", scopedArgs("delete", k, old)...)
			delete(scoped.added, k)
		}
		if err := run("/sbin/route", scopedArgs("add", k, gw)...); err != nil && !strings.Contains(err.Error(), "File exists") {
			if first == nil {
				first = err
			}
			continue
		}
		scoped.added[k] = gw
	}
	for k, gw := range scoped.added {
		if _, ok := want[k]; !ok {

			if !have[k] {
				run("/sbin/route", scopedArgs("delete", k, gw)...)
			}
			delete(scoped.added, k)
		}
	}
	return first
}

func cleanupScoped() {
	routes, err := nics.DefaultRoutes()
	if err != nil {
		return
	}
	unscoped := map[scopedKey]string{}
	for _, r := range routes {
		if !r.Scoped && r.GW != nil && realName.MatchString(r.Name) {
			unscoped[scopedKey{r.Name, r.V6}] = r.GW.String()
		}
	}
	for _, r := range routes {
		k := scopedKey{r.Name, r.V6}
		if gw, ok := unscoped[k]; ok && r.Scoped && r.GW != nil && r.GW.String() == gw {
			run("/sbin/route", scopedArgs("delete", k, gw)...)
		}
	}
}
