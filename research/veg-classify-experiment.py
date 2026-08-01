import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
R = '/Users/jurajgiacko/Projects/ceskyorientak/research/raw/'

dtm = np.array(Image.open(R+'dmr5g_forest.tif'), dtype=np.float32)
dsm = np.array(Image.open(R+'dmp1g_forest.tif'), dtype=np.float32)
rgb = np.array(Image.open(R+'ortofoto_forest.png').convert('RGB'), dtype=np.float32)/255.0
chm = dsm - dtm
r, g, b = rgb[:,:,0], rgb[:,:,1], rgb[:,:,2]
print('shapes', dtm.shape, rgb.shape[:2])

eps = 1e-6
GLI  = (2*g - r - b)/(2*g + r + b + eps)          # Green Leaf Index
ExG  = 2*g - r - b                                 # Excess Green
VARI = (g - r)/(g + r - b + eps)
lum  = 0.299*r + 0.587*g + 0.114*b

def boxstd(a, k=5):
    """local std via integral images, window k x k"""
    p  = np.pad(a, k//2, mode='reflect').astype(np.float64)
    c1 = np.pad(np.cumsum(np.cumsum(p, 0), 1),   ((1,0),(1,0)))
    c2 = np.pad(np.cumsum(np.cumsum(p*p, 0), 1), ((1,0),(1,0)))
    def win(c):
        return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k])
    n = k*k
    m  = win(c1)/n
    v  = win(c2)/n - m*m
    return np.sqrt(np.clip(v, 0, None)).astype(np.float32)

rough = boxstd(chm, 5)      # canopy roughness, 5px ~ 11 m window
print('\n--- index distributions (percentiles 1/5/25/50/75/95/99) ---')
for name, a in [('CHM', chm), ('GLI', GLI), ('ExG', ExG), ('VARI', VARI), ('lum', lum), ('rough(CHM,5)', rough)]:
    print(f'  {name:14}', np.percentile(a, [1,5,25,50,75,95,99]).round(3))

# --- separability check: does GLI separate the known open field from forest? ---
tall = chm > 12
openg = chm < 1.0
print('\n--- GLI / lum by CHM class (mean +- std) ---')
for lbl, m in [('CHM<1  (open)', openg), ('1-3    (low veg)', (chm>=1)&(chm<3)),
               ('3-12   (thicket/young)', (chm>=3)&(chm<12)), ('>12    (mature)', tall)]:
    if m.sum() == 0: continue
    print(f'  {lbl:24} n={m.sum():>8}  GLI={GLI[m].mean():+.3f}+-{GLI[m].std():.3f}  '
          f'lum={lum[m].mean():.3f}  rough={rough[m].mean():5.2f}')

# --- candidate ISOM classifier ---
# runnability is understory density, NOT canopy height:
#  - mature high canopy, smooth  -> open forest, fast     -> WHITE
#  - mid canopy, rough, green    -> young/dense thicket   -> GREEN
#  - low canopy + high greenness -> scrub                 -> GREEN/FIGHT
#  - low canopy + low greenness  -> field / road / rock   -> YELLOW / OPEN
CL = np.zeros(chm.shape, np.uint8)   # 0 unset
OPEN_LAND, ROUGH_OPEN, WHITE, G25, G50, FIGHT = 1, 2, 3, 4, 5, 6
veg = GLI > 0.02

CL[(chm < 0.5)] = OPEN_LAND
CL[(chm < 0.5) & veg & (rough > 0.25)] = ROUGH_OPEN
CL[(chm >= 0.5) & (chm < 2.0)] = G25
CL[(chm >= 2.0) & (chm < 5.0)] = FIGHT
CL[(chm >= 5.0) & (chm < 12.0) & (rough >= 1.6)] = G50
CL[(chm >= 5.0) & (chm < 12.0) & (rough < 1.6)] = G25
CL[(chm >= 12.0) & (rough < 2.2)] = WHITE
CL[(chm >= 12.0) & (rough >= 2.2) & (rough < 3.4)] = G25
CL[(chm >= 12.0) & (rough >= 3.4)] = G50

names = {1:'open land (yellow/white)', 2:'rough open (yellow, rough)', 3:'WHITE forest (runnable)',
         4:'GREEN 25% (slow run)', 5:'GREEN 50% (walk)', 6:'DARK GREEN (fight)'}
print('\n--- classified area shares (forest AOI, 2.49 x 2.49 km) ---')
tot = CL.size
for k in sorted(names):
    print(f'  {k} {names[k]:30} {100*(CL==k).sum()/tot:6.2f}%')
np.save('/tmp/CL.npy', CL)

# colour preview in ISOM-ish palette
pal = {0:(255,0,255),1:(255,190,80),2:(255,220,140),3:(255,255,255),
       4:(197,241,197),5:(140,220,140),6:(60,175,60)}
out = np.zeros(CL.shape+(3,), np.uint8)
for k,c in pal.items(): out[CL==k] = c
Image.fromarray(out).resize((800,800), Image.NEAREST).save('/tmp/prev_class.png')
print('\nwrote /tmp/prev_class.png')
