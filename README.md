# BMS V8 WZ To Web

Web catalog viewer for MapleStory WZ export data, focused on documentation and fast browsing.

## Overview

This project transforms exported WZ data into a modern static web interface with:

- Tab navigation for all data groups (`Accessory`, `Mob`, `Npc`, `Skill`, etc.)
- Global search across ID, name and metadata fields
- Advanced filters (`cash`, minimum required level, sorting)
- Card view and table view
- Details panel with parsed `Info` fields and raw exported fields
- Progressive loading for good performance on large datasets

The app is fully static (HTML/CSS/JS), so it can run on localhost and later be deployed to any static hosting provider.

## Project Structure

- `WEB/index.html`: main app shell
- `WEB/styles.css`: visual design and responsive layout
- `WEB/app.js`: data loading, filtering, rendering and state sync
- `WEB/manifest.js`: list of exported data scripts to load
- `WEB/<Tab>/data.js`: exported tab data loaded at runtime

## Run Locally

From the project root:

```bash
cd WEB
python -m http.server 8099
```

Open:

`http://127.0.0.1:8099`

## URL State

The interface syncs filters into query parameters so links can be shared with current state:

- `tab`
- `q`
- `cash`
- `minlvl`
- `sort`
- `view`

## Notes

- Data source is loaded from exported local files (`data.js` per tab).
- No backend required.
- Best workflow is to keep exports updated and refresh the page.
