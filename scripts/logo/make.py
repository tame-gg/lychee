"""Build every Lychee icon from the pixel grids. Run: python3 make.py <lychee repo root>"""
import os, sys, json
from PIL import Image, ImageDraw
from gen import proc, PAL
HERE = os.path.dirname(os.path.abspath(__file__))
def grid(name): return open(os.path.join(HERE, name)).read().split()
G16, G32, G48 = grid('grid16.txt'), grid('grid32.txt'), proc(48)
CARD, EDGE = (231, 226, 214, 255), (214, 206, 188, 255)

def rgba(c): return tuple(int(PAL[c][i:i+2], 16) for i in (1, 3, 5)) + (255,)
def sprite(rows, scale=1):
    n = len(rows); im = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    for y, r in enumerate(rows):
        for x, c in enumerate(r):
            if c != '.': im.putpixel((x, y), rgba(c))
    return im.resize((n*scale, n*scale), Image.NEAREST)
def grid_for(px):  # the hand-tuned grid that fits a target pixel size best
    return G16 if px < 32 else G32 if px < 48 else G48
def centred(sp, size, dy=0):
    """Paste a sprite so its drawn pixels (not its grid) sit dead centre on a size x size canvas."""
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0)); x0, y0, x1, y1 = sp.getbbox()
    im.paste(sp, ((size - (x1-x0))//2 - x0, (size - (y1-y0))//2 - y0 + dy), sp); return im
def mark(size):
    """Transparent fruit, integer-scaled, centred."""
    g = grid_for(size); return centred(sprite(g, max(1, size // len(g))), size)
def template(size):
    """macOS menu-bar template: the fruit's silhouette in black, with the gold bump highlights and
    the outline either side of the stem knocked out so the stem and leaf still read."""
    g = grid_for(size); s = max(1, size // len(g))
    def keep(r, x, c):
        return c not in 'lh' and not (c == 'K' and 'S' in r[max(0, x-1):x+2])
    rows = [''.join(c if keep(r, x, c) else '.' for x, c in enumerate(r)) for r in g]
    sp = sprite(rows, s); a = sp.split()[3]
    sp = Image.new('RGBA', sp.size, (0, 0, 0, 255)); sp.putalpha(a); return centred(sp, size)
def tile(size):
    """App icon: cream card tile (tame.gg project card) with the fruit; macOS grid 824/1024."""
    if size <= 32: return mark(size)
    ss = 4; S = size*ss; im = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    m = round(S*100/1024); rad = round(S*185/1024)
    d.rounded_rectangle([m, m, S-m, S-m], rad, fill=EDGE)
    b = max(ss, round(S*14/1024))
    d.rounded_rectangle([m+b, m+b, S-m-b, S-m-b], rad-b, fill=CARD)
    im = im.resize((size, size), Image.LANCZOS)
    inner = round(size*(0.67 if size <= 64 else 0.56))
    g = G48 if inner >= 96 else G32 if inner >= 32 else G16
    sp = sprite(g, max(1, inner//len(g)))
    c = centred(sp, size, round(size*0.01)); im.alpha_composite(c); return im
def off(im):
    g = im.convert('LA').convert('RGBA'); a = g.split()[3].point(lambda v: int(v*0.5))
    g.putalpha(a); return g

if __name__ == '__main__':
    root = sys.argv[1] if len(sys.argv) > 1 else '.'
    P = lambda *p: os.path.join(root, *p)
    tile(1024).save(P('build', 'icon.png'))
    tile(512).save(P('resources', 'icon-dark.png'))
    sizes = [16, 24, 32, 48, 64, 128, 256]
    tile(256).save(P('build', 'icon.ico'), sizes=[(s, s) for s in sizes],
                   append_images=[tile(s) for s in sizes])
    big = tile(1024)
    big.save(P('build', 'icon.icns'), append_images=[tile(s) for s in (16, 32, 64, 128, 256, 512)])
    for n in (16, 32, 48, 128):
        mark(n).save(P('extension', 'icons', f'icon-{n}.png'))
    for n in (16, 32):
        off(mark(n)).save(P('extension', 'icons', f'icon-off-{n}.png'))
    # tray / menu-bar icons (Electron picks up the @2x file on its own)
    for n, suffix in ((16, ''), (32, '@2x')):
        mark(n).save(P('resources', f'tray{suffix}.png'))
        template(n).save(P('resources', f'trayTemplate{suffix}.png'))
    print('ok')
