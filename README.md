# ORIENŤÁK: VYŠŠÍ BROD

A browser orienteering race simulator built for the **Orienteering World Cup
2026**, Vyšší Brod, Czech Republic, **5–9 August 2026**.
Enervit × Český orientak (ČSOS).

Two real venues:

- **Forest** — Arena Martínkov (48.6008 N, 14.2913 E), Šumava/Lipno foothills.
  Long and Middle distance terrain: granite boulder fields, spruce, marshes,
  steep re-entrants above the Vltava valley.
- **Sprint** — Český Krumlov old town. UNESCO centre, castle complex, the cloak
  bridge, Latrán, náměstí Svornosti.

The map is the game. There is no GPS dot — your position on the map is your own
estimate, and it drifts. Punching a control snaps you back to the truth.

---

## Running it

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:3000.

Production build:

```bash
npm run build
```

The output in `dist/` is a static site — no backend, no accounts, no network.
The game is fully playable offline after first load.

---

## Repository layout

| Path | What lives there |
|---|---|
| `src/core/` | Domain types, geo transforms, capability probing. The contract every subsystem builds against. |
| `src/i18n/` | CZ (primary), EN, SK. No user-visible string may be written literally in a component. |
| `src/store/` | `ScoreStore` implementations. Nothing outside this folder touches `localStorage`. |
| `src/ui/` | Screen shell and transitions. |
| `src/styles/` | Design tokens. All colour is defined in `base.css` and nowhere else. |
| `tools/terrain/` | Offline ČÚZK / OSM ingest → compressed binary in `public/data/`. |
| `tools/imagegen/` | Build-time texture and key-art generation. Never runs at runtime. |
| `tools/blender/` | Headless Blender asset scripts → `public/models/*.glb`. |
| `assets/brand/` | Supplied brand files. **Never AI-generated.** |
| `docs/` | Research, decisions, roadmap, compliance. |

---

## Documentation

| Document | Purpose |
|---|---|
| [ROADMAP.md](docs/ROADMAP.md) | What ships, in what order, and where the MVP line sits |
| [DECISIONS.md](docs/DECISIONS.md) | Every non-obvious engineering call, with reasoning |
| [RESEARCH-SPORT.md](docs/RESEARCH-SPORT.md) | ISOM / ISSprOM specs, control descriptions, race formats, speed model |
| [RESEARCH-GEODATA.md](docs/RESEARCH-GEODATA.md) | ČÚZK and OSM sources, verified endpoints |
| [DATA_LICENCES.md](docs/DATA_LICENCES.md) | Licence terms and required attribution for every data source |
| [NUTRITION_PROTOCOL.md](docs/NUTRITION_PROTOCOL.md) | The real Enervit before/during/after protocol |
| [CLAIMS_TO_REVIEW.md](docs/CLAIMS_TO_REVIEW.md) | EU 1924/2006 compliance — lines needing regulatory sign-off |
| [BRAND.md](docs/BRAND.md) | WCUP26, ČSOS and Enervit identity, and how they co-exist |
| [ASSETS_NEEDED.md](ASSETS_NEEDED.md) | Brand assets we still need from the client |

---

## For the client marketing team

**Changing text.** All copy lives in `src/i18n/cs.json`, `en.json` and `sk.json`.
Edit the value, never the key. Czech is the source of truth; a key missing from
English or Slovak falls back to Czech rather than breaking.

**Brand assets.** Drop supplied files into `assets/brand/`. Enervit logos and
product packshots, WCUP26 and ČSOS marks are **only ever** real supplied files.
Nothing branded is generated. If something is missing it appears as a labelled
placeholder and is listed in [ASSETS_NEEDED.md](ASSETS_NEEDED.md).

**Nutrition copy is regulated.** Any change to text describing an Enervit product
must be checked against [CLAIMS_TO_REVIEW.md](docs/CLAIMS_TO_REVIEW.md) before it
ships. EU Regulation (EC) 1924/2006 governs what may be claimed.

**Deploying.** Every push to `main` deploys automatically. The site is static and
can be hosted anywhere.

---

## Credits and data

Terrain derived from ČÚZK open data and OpenStreetMap. Full attribution and
licence terms in [DATA_LICENCES.md](docs/DATA_LICENCES.md).

Event: [wcup.cz](https://wcup.cz) · ČSOS: [ceskyorientak.cz](https://ceskyorientak.cz)
