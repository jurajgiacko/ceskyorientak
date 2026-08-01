"""Independent EPSG:4326 -> EPSG:5514 (S-JTSK / Krovak East North) implementation,
checked against the extent ČÚZK's own ArcGIS ImageServer returned for the same input bbox."""
import math

# --- ellipsoids -------------------------------------------------------------
WGS84 = (6378137.0, 1/298.257223563)
BESSEL = (6377397.155, 1/299.1528128)
# proj4 +towgs84=589,76,480,0,0,0,0  (Bessel/S-JTSK -> WGS84); we invert it
DX, DY, DZ = 589.0, 76.0, 480.0

def geod2ecef(lat, lon, h, ell):
    a, f = ell; e2 = f*(2-f)
    sl, cl = math.sin(lat), math.cos(lat)
    N = a/math.sqrt(1-e2*sl*sl)
    return ((N+h)*cl*math.cos(lon), (N+h)*cl*math.sin(lon), (N*(1-e2)+h)*sl)

def ecef2geod(X, Y, Z, ell):
    a, f = ell; e2 = f*(2-f); b = a*(1-f)
    lon = math.atan2(Y, X); p = math.hypot(X, Y)
    lat = math.atan2(Z, p*(1-e2))
    for _ in range(12):
        N = a/math.sqrt(1-e2*math.sin(lat)**2)
        h = p/math.cos(lat) - N
        lat = math.atan2(Z, p*(1-e2*N/(N+h)))
    N = a/math.sqrt(1-e2*math.sin(lat)**2)
    return lat, lon, p/math.cos(lat)-N

def wgs84_to_bessel(lat, lon, h=0.0):
    X, Y, Z = geod2ecef(math.radians(lat), math.radians(lon), h, WGS84)
    return ecef2geod(X-DX, Y-DY, Z-DZ, BESSEL)      # inverse of +towgs84

# --- Krovak forward (EPSG Guidance Note 7-2, coordinate operation method 9819)
LAT_C = math.radians(49.5)      # latitude of projection centre
# 24deg50' GREENWICH (= 42deg30' Ferro). The proj4 +lon_0 is already Greenwich-based,
# so no Ferro offset is applied - adding 17deg40' is the classic mistake here.
LON_0 = math.radians(24.8333333333333)
ALPHA = math.radians(30.2881397527778)   # azimuth of the collinear axis
LAT_P = math.radians(78.5)      # pseudo standard parallel
K_C   = 0.9999

def krovak_en(lat_deg, lon_deg):
    lat, lon = wgs84_to_bessel(lat_deg, lon_deg)[:2]
    # lon stays Greenwich-based
    a, f = BESSEL; e2 = f*(2-f); e = math.sqrt(e2)

    A  = a*math.sqrt(1-e2)/(1-e2*math.sin(LAT_C)**2)
    B  = math.sqrt(1 + e2*math.cos(LAT_C)**4/(1-e2))
    g0 = math.asin(math.sin(LAT_C)/B)
    t0 = (math.tan(math.pi/4 + g0/2)
          * ((1+e*math.sin(LAT_C))/(1-e*math.sin(LAT_C)))**(e*B/2)
          / math.tan(math.pi/4 + LAT_C/2)**B)
    n  = math.sin(LAT_P)
    r0 = K_C*A/math.tan(LAT_P)

    U = 2*(math.atan(t0*math.tan(lat/2+math.pi/4)**B
           / ((1+e*math.sin(lat))/(1-e*math.sin(lat)))**(e*B/2)) - math.pi/4)
    V = B*(LON_0 - lon)
    S = math.asin(math.cos(ALPHA)*math.sin(U) + math.sin(ALPHA)*math.cos(U)*math.cos(V))
    D = math.asin(math.cos(U)*math.sin(V)/math.cos(S))
    theta = n*D
    r = r0*math.tan(math.pi/4 + LAT_P/2)**n / math.tan(S/2 + math.pi/4)**n
    Xp, Yp = r*math.cos(theta), r*math.sin(theta)   # southing, westing
    return -Yp, -Xp                                  # EPSG:5514 easting, northing

# --- verification against ČÚZK's own reprojection ---------------------------
CASES = [
  ("FOREST 2.2km AOI", (14.27636, 48.59091, 14.30624, 48.61069),
   (-776083.38495665544, -1206734.5399277189, -773596.94411314849, -1204248.099084212)),
  ("SPRINT Krumlov AOI", (14.30410, 48.80550, 14.32590, 48.81630),
   (-770832.35304953496, -1183293.6949033211, -768952.23580768728, -1181883.6069719354)),
]
print("bbox corners -> envelope in EPSG:5514, mine vs ČÚZK ArcGIS\n")
for name, (w, s, e_, n_), cuzk in CASES:
    pts = [krovak_en(la, lo) for lo in (w, e_) for la in (s, n_)]
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    mine = (min(xs), min(ys), max(xs), max(ys))
    print(f"  {name}")
    for lbl, m, c in zip(("xmin", "ymin", "xmax", "ymax"), mine, cuzk):
        print(f"    {lbl}: mine={m:16.3f}  cuzk={c:16.3f}   d={m-c:+7.3f} m")
    print()

print("centre-point checks (lon, lat -> X, Y):")
for lbl, lo, la in [("Arena Martinkov", 14.2913, 48.6008),
                    ("Cesky Krumlov centre", 14.3150, 48.8109)]:
    x, y = krovak_en(la, lo)
    print(f"  {lbl:22} {x:12.2f}  {y:13.2f}")
