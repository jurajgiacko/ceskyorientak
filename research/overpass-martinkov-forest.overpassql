/* Arena Martínkov forest AOI - ISOM-relevant feature pull.
   AOI (S,W,N,E): 48.59091,14.27636,48.61069,14.30624   (~2.2 x 2.2 km)
   Endpoint: https://overpass-api.de/api/interpreter   (POST, body = "data=<query>") */
[out:json][timeout:180][bbox:48.59091,14.27636,48.61069,14.30624];
(
  way["highway"~"^(track|path|footway|service|residential|unclassified|tertiary|secondary|cycleway|bridleway)$"];
  way["landuse"~"^(forest|meadow|farmland|grass|orchard|village_green|residential|quarry)$"];
  way["natural"~"^(wood|scrub|water|wetland|grassland|heath|scree|cliff|rock|tree_row)$"];
  relation["natural"~"^(wood|water|wetland)$"];
  way["waterway"~"^(stream|river|ditch|drain|canal)$"];
  way["building"];
  way["barrier"~"^(fence|wall|hedge)$"];
  node["natural"~"^(tree|spring|rock|peak|saddle)$"];
  node["tourism"~"^(viewpoint|information|picnic_site)$"];
);
out geom qt;
