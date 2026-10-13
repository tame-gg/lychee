"""Lychee logo generator: procedural pixel grids (dumped as text so they can be hand-tuned)."""
import math, sys
PAL = {
 # shell outline, then the red-pink skin ramp (dark seam -> pink)
 'K': '#3A1016', 'r': '#7E1A2C', 'R': '#B4283F', 'P': '#D9435A', 'q': '#EE7085',
 # gold: highlights on the bumps (l, h) and the stem (d, e)
 'd': '#8C6217', 'e': '#AF7F22', 'm': '#C99530', 'g': '#E0AE3F',
 'l': '#E8B84A', 'p': '#F3D58A', 'h': '#F9E7B4', 'S': '#6B4A12',
 # leaf
 'n': '#3E6B1F', 'N': '#6FA234', 'L': '#9CC84A',
}
SKIN = ['r', 'R', 'P', 'q']

def proc(N):
    cx, cy, r = N/2, 0.58*N, 0.375*N
    P = max(3.0, N/7.0)                      # bump pitch
    k = max(8, round(2*math.pi*r/P))         # bumps around the rim
    amp = 0.035*r                            # how far each bump stands proud of the rim
    def rim(x, y):
        a = math.atan2(y-cy, x-cx)
        return r + amp*max(0.0, math.cos(k*a))**2
    g = [['.']*N for _ in range(N)]
    for y in range(N):
        for x in range(N):
            px, py = x+.5, y+.5
            if math.hypot(px-cx, py-cy) > rim(px, py): continue
            X, Y = (px-cx)/r, (py-cy)/r
            z = math.sqrt(max(0, 1-X*X-Y*Y))
            L = (-0.55*X - 0.65*Y + 0.55*z)
            # hex lattice of bumps (Voronoi): seams between bumps go dark
            ds = []
            rr = int(py/(P*0.87))
            for row in (rr-1, rr, rr+1, rr+2):
                ox = P/2 if row % 2 else 0
                for col in range(int((x-ox)/P)-1, int((x-ox)/P)+3):
                    bx, by = col*P+ox, row*P*0.87
                    ds.append((math.hypot(px-bx, py-by), bx, by))
            ds.sort()
            d0, bx, by = ds[0]; seam = ds[1][0]-d0
            u, v = (px-bx)/(P/2), (py-by)/(P/2)
            t = 0.30 + 0.62*L - 0.25*(u+v)
            if seam < 0.9: t -= 0.45
            if t > 0.95 and u+v < -0.2 and L > 0.35: g[y][x] = 'h' if t > 1.15 else 'l'; continue
            g[y][x] = SKIN[max(0, min(len(SKIN)-1, int(round(t*(len(SKIN)-1)))))]
    # outline
    out = [row[:] for row in g]
    for y in range(N):
        for x in range(N):
            if g[y][x] == '.': continue
            nb = [(x+1,y),(x-1,y),(x,y+1),(x,y-1)]
            if any(not(0<=a<N and 0<=b<N) or g[b][a]=='.' for a,b in nb): out[y][x]='K'
    g = out
    # stem: a short brown twig leaning right, then a pointed leaf off its tip (outlined)
    top = cy - r
    sw = 1 if N < 32 else 2
    tx, ty = cx + 0.04*N, top - (0.09 if N < 40 else 0.10)*N              # stem tip
    for y in range(N):
        for x in range(N):
            if g[y][x] != '.' or not (ty-0.5 <= y+.5 <= top+1): continue
            f = (top - (y+.5))/(top-ty)            # 0 at the fruit, 1 at the tip
            sx0 = cx - sw/2 + f*(tx-cx)
            if sx0 <= x+.5 < sx0 + sw + (1 if N >= 32 else 0): g[y][x] = 'e' if x+.5 < sx0+1 and sw > 1 else 'S'
    Lw, Lh, ang = 0.17*N, 0.075*N, -0.32
    ca, sa = math.cos(ang), math.sin(ang)
    lx, ly = tx + Lw*ca + 0.3, ty + Lw*sa + 0.035*N
    for y in range(N):
        for x in range(N):
            dx, dy = x+.5-lx, y+.5-ly
            u = (dx*ca+dy*sa)/Lw; v = (-dx*sa+dy*ca)/Lh
            if abs(u) <= 1 and abs(v) <= (1-u*u) and g[y][x] == '.':
                g[y][x] = 'n' if abs(v) < 0.18 and N >= 32 else ('L' if v < -0.3 else 'N')
    out = [row[:] for row in g]
    for y in range(N):
        for x in range(N):
            if g[y][x] in 'nNLSe' and y < top:
                nb = [(x+1,y),(x-1,y),(x,y+1),(x,y-1)]
                if any(not(0<=a<N and 0<=b<N) or g[b][a]=='.' for a,b in nb): out[y][x]='K'
    # centre the drawing in the grid (bounding box), so every size sits dead centre
    ys = [y for y in range(N) if any(c != '.' for c in out[y])]
    xs = [x for x in range(N) if any(out[y][x] != '.' for y in range(N))]
    oy, ox = (N-1-ys[-1]-ys[0])//2, (N-1-xs[-1]-xs[0])//2
    out = [
        [out[y-oy][x-ox] if 0 <= y-oy < N and 0 <= x-ox < N else '.' for x in range(N)] for y in range(N)]
    return [''.join(r) for r in out]

if __name__ == '__main__':
    for row in proc(int(sys.argv[1])): print(row)
