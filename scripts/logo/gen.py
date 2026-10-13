"""Lychee logo generator: procedural pixel grids (dumped as text so they can be hand-tuned)."""
import math, sys
PAL = {
 'K': '#5C3E0B', 'd': '#8C6217', 'e': '#AF7F22', 'm': '#C99530', 'g': '#E0AE3F',
 'l': '#E8B84A', 'p': '#F3D58A', 'h': '#F9E7B4',
 'W': '#FFFBF0', 'w': '#F1E8D2', 'v': '#DCCDAA', 'S': '#6B4A12',
}
SKIN = ['d', 'e', 'm', 'g', 'l', 'p', 'h']

def proc(N):
    cx, cy, r = 0.48*N, 0.58*N, 0.385*N
    bx, by, br = cx+0.82*r, cy+0.55*r, 0.58*r   # peeled patch
    P = max(3.0, N/7.5)
    g = [['.']*N for _ in range(N)]
    def fruit(x, y): return (x+.5-cx)**2+(y+.5-cy)**2 <= r*r
    for y in range(N):
        for x in range(N):
            if not fruit(x, y): continue
            X, Y = (x+.5-cx)/r, (y+.5-cy)/r
            if (x+.5-bx)**2+(y+.5-by)**2 <= br*br:
                d = math.hypot(x+.5-bx, y+.5-by)/br
                sx, sy = x+.5-(bx-0.12*r), y+.5-(by-0.12*r)
                if math.hypot(sx, sy*1.3) < 0.11*r: g[y][x] = 'S'; continue
                g[y][x] = 'W' if (X+Y) < 0.95 else ('w' if d > .35 else 'v')
                continue
            z = math.sqrt(max(0, 1-X*X-Y*Y))
            L = (-0.55*X - 0.65*Y + 0.55*z)
            # hex lattice of bumps (Voronoi): seams between bumps go dark
            ds = []
            rr = int((y+.5)/(P*0.87))
            for row in (rr-1, rr, rr+1, rr+2):
                ox = P/2 if row % 2 else 0
                for col in range(int((x-ox)/P)-1, int((x-ox)/P)+3):
                    px_, py_ = col*P+ox, row*P*0.87
                    ds.append((math.hypot(x+.5-px_, y+.5-py_), px_, py_))
            ds.sort()
            d0, pcx, pcy = ds[0]; seam = ds[1][0]-d0
            u, v = (x+.5-pcx)/(P/2), (y+.5-pcy)/(P/2)
            t = 0.42 + 0.55*L - 0.22*(u+v)
            if seam < 0.9: t -= 0.42
            i = max(0, min(len(SKIN)-1, int(round(t*(len(SKIN)-1)))))
            g[y][x] = SKIN[i]
    # outline: skin edge + rim around peeled patch
    out = [row[:] for row in g]
    for y in range(N):
        for x in range(N):
            if g[y][x] == '.': continue
            nb = [(x+1,y),(x-1,y),(x,y+1),(x,y-1)]
            if any(not(0<=a<N and 0<=b<N) or g[b][a]=='.' for a,b in nb): out[y][x]='K'
            elif g[y][x] in SKIN and any(g[b][a] in 'Wwv' for a,b in nb): out[y][x]='d'
    g = out
    # stem + leaf
    sx = int(cx); top = int(cy-r)
    for k in range(1, max(2, int(N*0.11))+1):
        y = top-k+1; x = sx + (k//3)
        if 0 <= y: g[y][x] = 'K'
    # leaf: an ellipse tilted up-right from the stem tip, midrib in 'e'
    ax, ay = sx+0.8, top-0.075*N; Lw, Lh, ang = 0.17*N, 0.085*N, -0.40
    ca, sa = math.cos(ang), math.sin(ang)
    for y in range(N):
        for x in range(N):
            dx, dy = x+.5-(ax+Lw*ca), y+.5-(ay+Lw*sa)
            u = (dx*ca+dy*sa)/Lw; v = (-dx*sa+dy*ca)/Lh
            if u*u+v*v <= 1 and g[y][x]=='.':
                g[y][x] = 'e' if abs(v) < 0.22 and N >= 32 else ('g' if v < 0 else 'm')
    out=[row[:] for row in g]
    for y in range(N):
        for x in range(N):
            if g[y][x] in 'gme' and y < cy-r+1:
                nb=[(x+1,y),(x-1,y),(x,y+1),(x,y-1)]
                if any(not(0<=a<N and 0<=b<N) or g[b][a]=='.' for a,b in nb): out[y][x]='K'
    return [''.join(r) for r in out]

if __name__ == '__main__':
    for row in proc(int(sys.argv[1])): print(row)
