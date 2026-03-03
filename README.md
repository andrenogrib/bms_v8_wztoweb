# BMS V8 WZ Database

Simple web database viewer for MapleStory WZ export data.

## Overview

This project transforms exported WZ data into a simple and functional static web interface with:

- Tab navigation for all data groups (`Accessory`, `Mob`, `Npc`, `Skill`, etc.)
- Global search focused on ID and name
- Clean table for consultation
- Details panel with parsed `Info` fields and raw exported fields
- Cross-reference panels (`Reward` drops and `Map` links)
- Progressive loading for good performance on large datasets

The app is fully static (HTML/CSS/JS), so it can run on localhost and later be deployed to any static hosting provider.

## Project Structure

- `WEB/index.html`: main app shell
- `WEB/styles.css`: visual design and responsive layout
- `WEB/app.js`: data loading, filtering, rendering and state sync
- `WEB/manifest.js`: list of exported data scripts to load
- `WEB/<Tab>/data.js`: exported tab data loaded at runtime
- `WEB/Reward/drop-index.json`: lightweight index used for item/mob drop relation
- `WEB/Map/map-links.json`: lightweight index used for map/mob/npc relation

## Run Locally

From the project root:

```bash
cd WEB
python -m http.server 8099
```

Open:

`http://127.0.0.1:8099`

## URL State

The interface syncs query parameters so links can be shared with current state:

- `tab`
- `q`

## Notes

- Data source is loaded from exported local files (`data.js` per tab).
- No backend required.
- Best workflow is to keep exports updated and refresh the page.

## Reward.img (Drops / Meso / EXP Reference)

If Harepacker UI fails to export `Reward.img`, you can do it by command line in this repo.

### 1. Export `Reward.img` to JSON

From project root:

```powershell
tools\RewardExtractor\bin\Release\net9.0-windows\RewardExtractor.exe REWARD\Reward.img REWARD\Reward.export.json
```

### 2. Normalize and cross data with WEB database

This step links reward drops with mob names/EXP and item names from `WEB/*/data.json`.

```powershell
node tools\reward-normalize.js
```

Generated files:

- `REWARD/Reward.normalized.json`: full structure (mob -> drops with names, prob, min/max, meso, exp)
- `REWARD/Reward.normalized.flat.json`: one row per drop entry (easier to import/query)
- `REWARD/Reward.unknown-items.json`: item IDs not found in current `WEB` export
- `REWARD/Reward.normalized.md`: quick human-readable summary
- `WEB/Reward/drop-index.json`: lightweight index used by the web UI (Mob details panel)

## UI Integration

- In tab `Mob`, selecting a mob now shows **Drops (Reward.img)** in the details panel.
- In item tabs (`Consume`, `Etc`, `Weapon`, etc.), selecting an item now shows **Dropa de** with:
  - monster icon (`ICO`)
  - monster ID
  - mob name
  - chance and quantity
- Data source: `WEB/Reward/drop-index.json`.
- If the file is missing, the panel shows a load error message without breaking the rest of the app.

## MAP Cross (Map <-> Mob/Npc)

Use this to generate map life references from raw `MAP/*.img` and link with `WEB` names/icons.

Prerequisite: keep a local clone of `Harepacker-resurrected` in `tmp_harepacker_clone` (used for MapleLib reference).

### 1. Build extractor

```powershell
dotnet build tools\MapCrossBuilder\MapCrossBuilder.csproj -c Release
```

### 2. Generate map link index

```powershell
dotnet run --project tools\MapCrossBuilder\MapCrossBuilder.csproj -c Release -- MAP WEB WEB\Map\map-links.json
```

Generated file:

- `WEB/Map/map-links.json`: map contents and reverse index
  - `maps`: map -> mobs + npcs
  - `mobs`: mob -> maps
  - `npcs`: npc -> maps

### UI behavior

- In tabs `Map*`: selecting a map shows **Conteudo do mapa** (mobs + NPCs).
- In tab `Mob`: selecting a mob shows **Aparece em mapas**.
- In tab `Npc`: selecting an NPC shows **Aparece em mapas**.
- Entries are clickable for quick navigation across related records.
