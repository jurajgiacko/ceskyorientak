/* Český Krumlov historic old town - ISSprOM-relevant feature pull.
   BBOX order for Overpass QL is (south,west,north,east).
   AOI: 48.80550,14.30410,48.81630,14.32590  (~1.6 km E-W x 1.2 km N-S)
   Endpoint: https://overpass-api.de/api/interpreter  (POST, body = "data=<query>")
   Output: geometry inlined via "out geom" so no separate node lookup is needed. */
[out:json][timeout:180][bbox:48.80550,14.30410,48.81630,14.32590];
(
  /* --- ISSprOM 521/526 buildings, canopies, passages --- */
  way["building"];
  relation["building"];
  way["building:part"];
  way["man_made"="bridge"];
  relation["man_made"="bridge"];

  /* --- ISSprOM 515-518 impassable/crossable walls, fences, hedges --- */
  way["barrier"~"^(wall|fence|hedge|retaining_wall|city_wall|handrail|guard_rail|kerb|bollard|gate|chain)$"];
  node["barrier"~"^(gate|bollard|lift_gate|kissing_gate|stile|block)$"];
  way["historic"="citywalls"];

  /* --- ISSprOM 502-508 paved/unpaved routes, steps, tunnels --- */
  way["highway"~"^(footway|path|pedestrian|steps|track|service|residential|living_street|unclassified|tertiary|secondary|primary|cycleway|corridor)$"];
  way["highway"="steps"];
  way["tunnel"]["highway"];
  way["covered"="yes"]["highway"];

  /* --- ISSprOM 301-312 water --- */
  way["waterway"];
  relation["waterway"];
  way["natural"="water"];
  relation["natural"="water"];

  /* --- ISSprOM 401-421 vegetation / open land --- */
  way["landuse"];
  relation["landuse"];
  way["natural"~"^(wood|scrub|grassland|heath|wetland|scree|cliff|rock|bare_rock|tree_row|water)$"];
  relation["natural"~"^(wood|scrub|grassland|wetland)$"];
  way["leisure"~"^(park|garden|pitch|playground|sports_centre)$"];
  node["natural"="tree"];

  /* --- landmark / castle / cultural --- */
  way["historic"];
  relation["historic"];
  node["historic"];
  way["tourism"="attraction"];

  /* --- ISSprOM 709 out-of-bounds hints & area boundaries --- */
  way["access"~"^(private|no)$"];
  way["man_made"~"^(embankment|pier|tower|wastewater_plant)$"];
);
out geom qt;
