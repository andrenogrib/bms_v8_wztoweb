#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const DEFAULTS = {
  rewardJsonPath: path.join(ROOT, "REWARD", "Reward.export.json"),
  webDir: path.join(ROOT, "WEB"),
  outDir: path.join(ROOT, "REWARD"),
};

main();

function main() {
  const rewardJsonPath = asAbs(process.argv[2] || DEFAULTS.rewardJsonPath);
  const webDir = asAbs(process.argv[3] || DEFAULTS.webDir);
  const outDir = asAbs(process.argv[4] || DEFAULTS.outDir);

  if (!fs.existsSync(rewardJsonPath)) {
    fail(`Reward export not found: ${rewardJsonPath}`);
  }
  if (!fs.existsSync(webDir)) {
    fail(`WEB directory not found: ${webDir}`);
  }

  const reward = readJson(rewardJsonPath);
  const manifest = readManifest(path.join(webDir, "manifest.js"));
  const mobRows = readJson(path.join(webDir, "Mob", "data.json"));
  const itemIndex = buildItemIndex(manifest, webDir);
  const mobIndex = buildMobIndex(mobRows);

  const result = normalizeReward(reward, mobIndex, itemIndex);
  const generatedAt = new Date().toISOString();
  const payload = {
    meta: {
      generatedAt,
      rewardJsonPath: normalizePathForOutput(rewardJsonPath),
      mobDataPath: normalizePathForOutput(path.join(webDir, "Mob", "data.json")),
      totalRewardMobs: result.totalRewardMobs,
      matchedMobCount: result.matchedMobCount,
      unmatchedMobCount: result.unmatchedMobCount,
      totalDropEntries: result.totalDropEntries,
      totalItemDrops: result.totalItemDrops,
      totalMesoDrops: result.totalMesoDrops,
      unknownItemIdCount: result.unknownItemIdCount,
    },
    mobs: result.mobs,
    unknownItemIds: result.unknownItemIds,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const outJson = path.join(outDir, "Reward.normalized.json");
  const outFlat = path.join(outDir, "Reward.normalized.flat.json");
  const outMd = path.join(outDir, "Reward.normalized.md");
  const outUnknown = path.join(outDir, "Reward.unknown-items.json");
  const webDropIndexPath = path.join(webDir, "Reward", "drop-index.json");

  writeJson(outJson, payload);
  writeJson(outFlat, result.flatRows);
  writeJson(outUnknown, result.unknownItemIds);
  fs.writeFileSync(outMd, buildMarkdown(payload), "utf8");
  writeJson(webDropIndexPath, buildWebDropIndex(payload));

  console.log("Reward normalization completed.");
  console.log(`- ${normalizePathForOutput(outJson)}`);
  console.log(`- ${normalizePathForOutput(outFlat)}`);
  console.log(`- ${normalizePathForOutput(outUnknown)}`);
  console.log(`- ${normalizePathForOutput(outMd)}`);
  console.log(`- ${normalizePathForOutput(webDropIndexPath)}`);
  console.log("");
  console.log("Summary:");
  console.log(`- Reward mobs: ${result.totalRewardMobs}`);
  console.log(`- Mob matched: ${result.matchedMobCount}`);
  console.log(`- Entries: ${result.totalDropEntries} (${result.totalItemDrops} items, ${result.totalMesoDrops} mesos)`);
  console.log(`- Unknown item IDs: ${result.unknownItemIdCount}`);
}

function normalizeReward(reward, mobIndex, itemIndex) {
  const mobKeys = Object.keys(reward).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const mobs = [];
  const flatRows = [];
  const unknownItemCount = new Map();

  let matchedMobCount = 0;
  let unmatchedMobCount = 0;
  let totalDropEntries = 0;
  let totalItemDrops = 0;
  let totalMesoDrops = 0;

  for (const rewardMobKey of mobKeys) {
    const node = reward[rewardMobKey];
    if (!node || typeof node !== "object") {
      continue;
    }

    const mobId = normalizeMobId(stripMobPrefix(rewardMobKey));
    const mob = mobIndex.get(mobId) || null;
    if (mob) {
      matchedMobCount += 1;
    } else {
      unmatchedMobCount += 1;
    }

    const dropKeys = Object.keys(node)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    const drops = [];

    for (const idx of dropKeys) {
      const entry = node[idx];
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const rawItem = readWzValue(entry.item);
      const rawMeso = readWzValue(entry.money);
      const rawProb = asText(readWzValue(entry.prob)).trim();
      const rawMin = readWzValue(entry.min);
      const rawMax = readWzValue(entry.max);
      const rawPremium = readWzValue(entry.premium);
      const rawPeriod = readWzValue(entry.period);
      const rawDateExpire = readWzValue(entry.dateExpire);

      const itemId = toNumberOrNull(rawItem) === null ? null : normalizeItemId(rawItem);
      const meso = toNumberOrNull(rawMeso);
      const min = toNumberOrNull(rawMin);
      const max = toNumberOrNull(rawMax);
      const premium = toNumberOrNull(rawPremium);
      const period = toNumberOrNull(rawPeriod);
      const dateExpire = toNumberOrNull(rawDateExpire);
      const prob = parseProb(rawProb);

      const itemMeta = itemId ? itemIndex.get(itemId) || null : null;
      if (itemId && !itemMeta) {
        unknownItemCount.set(itemId, (unknownItemCount.get(itemId) || 0) + 1);
      }

      const type = itemId ? "item" : "meso";
      if (type === "item") {
        totalItemDrops += 1;
      } else {
        totalMesoDrops += 1;
      }
      totalDropEntries += 1;

      const drop = {
        index: Number(idx),
        type,
        itemId,
        itemName: itemMeta ? itemMeta.name : null,
        itemTab: itemMeta ? itemMeta.tab : null,
        meso,
        min,
        max,
        probRaw: rawProb || null,
        prob,
        premium,
        period,
        dateExpire,
      };
      drops.push(drop);

      flatRows.push({
        mobId,
        mobName: mob ? mob.name : null,
        mobLevel: mob ? mob.level : null,
        mobExp: mob ? mob.exp : null,
        ...drop,
      });
    }

    const itemCount = drops.filter((d) => d.type === "item").length;
    const mesoCount = drops.length - itemCount;
    const unknownCount = drops.filter((d) => d.type === "item" && d.itemName == null).length;

    mobs.push({
      rewardKey: rewardMobKey,
      mobId,
      mobName: mob ? mob.name : null,
      mobLevel: mob ? mob.level : null,
      mobExp: mob ? mob.exp : null,
      mobMaxHp: mob ? mob.maxHp : null,
      drops,
      summary: {
        total: drops.length,
        itemDrops: itemCount,
        mesoDrops: mesoCount,
        unknownItemDrops: unknownCount,
      },
    });
  }

  const unknownItemIds = Array.from(unknownItemCount.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en", { numeric: true }))
    .map(([itemId, count]) => ({ itemId, count }));

  return {
    totalRewardMobs: mobKeys.length,
    matchedMobCount,
    unmatchedMobCount,
    totalDropEntries,
    totalItemDrops,
    totalMesoDrops,
    unknownItemIdCount: unknownItemIds.length,
    unknownItemIds,
    mobs,
    flatRows,
  };
}

function buildMobIndex(mobRows) {
  const index = new Map();
  if (!Array.isArray(mobRows)) {
    return index;
  }
  for (const row of mobRows) {
    const id = normalizeMobId(row && row.id);
    if (!id) {
      continue;
    }
    const name = asText((row && row.name) || (row && row.fields && row.fields.Name) || "").trim() || null;
    const infoRaw = asText(row && row.fields && row.fields.Info);
    const info = parseInfoMap(infoRaw);
    index.set(id, {
      id,
      name,
      level: parseNumber(info["info.level"]),
      exp: parseNumber(info["info.exp"]),
      maxHp: parseNumber(info["info.maxHP"]),
    });
  }
  return index;
}

function buildItemIndex(manifest, webDir) {
  const index = new Map();
  const srcList = Array.isArray(manifest) ? manifest : [];
  for (const src of srcList) {
    const jsonPath = path.join(webDir, asText(src).replace(/\.js$/i, ".json"));
    if (!fs.existsSync(jsonPath)) {
      continue;
    }
    const rows = readJson(jsonPath);
    if (!Array.isArray(rows)) {
      continue;
    }
    for (const row of rows) {
      const idRaw = asText((row && row.id) || "").trim();
      if (!/^\d+$/.test(idRaw)) {
        continue;
      }
      const normalized = normalizeItemId(idRaw);
      if (!normalized) {
        continue;
      }
      if (index.has(normalized)) {
        continue;
      }
      const name = asText((row && row.name) || (row && row.fields && row.fields.Name) || "").trim();
      const tab = asText((row && row.tab) || "").trim();
      if (!name) {
        continue;
      }
      index.set(normalized, { id: normalized, name, tab: tab || null });
    }
  }
  return index;
}

function buildMarkdown(payload) {
  const meta = payload.meta;
  const mobs = payload.mobs || [];
  const lines = [];

  lines.push("# Reward Normalized Summary");
  lines.push("");
  lines.push(`Generated at: ${meta.generatedAt}`);
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- Reward mobs: ${meta.totalRewardMobs}`);
  lines.push(`- Matched mobs in WEB/Mob: ${meta.matchedMobCount}`);
  lines.push(`- Unmatched mobs in WEB/Mob: ${meta.unmatchedMobCount}`);
  lines.push(`- Total entries: ${meta.totalDropEntries}`);
  lines.push(`- Item entries: ${meta.totalItemDrops}`);
  lines.push(`- Meso entries: ${meta.totalMesoDrops}`);
  lines.push(`- Unknown item IDs: ${meta.unknownItemIdCount}`);
  lines.push("");
  lines.push("## Sample");
  lines.push("");
  lines.push("| Mob ID | Mob Name | Level | EXP | Entries |");
  lines.push("| --- | --- | ---: | ---: | ---: |");

  const sample = mobs
    .slice()
    .sort((a, b) => a.mobId.localeCompare(b.mobId, "en", { numeric: true }))
    .slice(0, 25);
  for (const m of sample) {
    lines.push(
      `| ${m.mobId} | ${sanitizeMd(m.mobName || "-")} | ${valueOrDash(m.mobLevel)} | ${valueOrDash(m.mobExp)} | ${m.summary.total} |`
    );
  }

  if (meta.unknownItemIdCount > 0) {
    lines.push("");
    lines.push("## Unknown Item IDs (Top 30)");
    lines.push("");
    lines.push("| Item ID | Count |");
    lines.push("| --- | ---: |");
    for (const row of (payload.unknownItemIds || []).slice(0, 30)) {
      lines.push(`| ${row.itemId} | ${row.count} |`);
    }
  }

  return lines.join("\n") + "\n";
}

function buildWebDropIndex(payload) {
  const mobs = {};
  const items = {};

  for (const mob of payload.mobs || []) {
    if (!mob || !mob.mobId || !Array.isArray(mob.drops) || !mob.drops.length) {
      continue;
    }

    const mobDrops = [];
    for (const drop of mob.drops) {
      const compactMobDrop = compactWebDrop(drop);
      mobDrops.push(compactMobDrop);

      if (drop.type !== "item" || !drop.itemId) {
        continue;
      }

      const itemId = drop.itemId;
      if (!Object.prototype.hasOwnProperty.call(items, itemId)) {
        items[itemId] = {
          itemId,
          itemName: drop.itemName || null,
          itemTab: drop.itemTab || null,
          drops: [],
        };
      }

      items[itemId].drops.push(
        compactItemDropRow({
          mobId: mob.mobId,
          mobName: mob.mobName || null,
          mobLevel: mob.mobLevel,
          mobExp: mob.mobExp,
          ...drop,
        })
      );
    }

    mobs[mob.mobId] = mobDrops;
  }

  for (const itemId of Object.keys(items)) {
    items[itemId].drops.sort((a, b) => {
      const ap = Number(a.prob);
      const bp = Number(b.prob);
      if (Number.isFinite(ap) && Number.isFinite(bp) && ap !== bp) {
        return bp - ap;
      }
      return String(a.mobId).localeCompare(String(b.mobId), "en", { numeric: true });
    });
  }

  return {
    meta: {
      generatedAt: payload.meta.generatedAt,
      rewardMobs: payload.meta.totalRewardMobs,
      matchedMobs: payload.meta.matchedMobCount,
      entryCount: payload.meta.totalDropEntries,
      itemIndexCount: Object.keys(items).length,
      source: payload.meta.rewardJsonPath,
    },
    mobs,
    items,
  };
}

function compactWebDrop(drop) {
  const out = {
    index: drop.index,
    type: drop.type,
  };
  if (drop.itemId) out.itemId = drop.itemId;
  if (drop.itemName) out.itemName = drop.itemName;
  if (drop.itemTab) out.itemTab = drop.itemTab;
  if (drop.meso !== null) out.meso = drop.meso;
  if (drop.min !== null) out.min = drop.min;
  if (drop.max !== null) out.max = drop.max;
  if (drop.probRaw) out.probRaw = drop.probRaw;
  if (drop.prob !== null) out.prob = drop.prob;
  if (drop.premium !== null) out.premium = drop.premium;
  if (drop.period !== null) out.period = drop.period;
  if (drop.dateExpire !== null) out.dateExpire = drop.dateExpire;
  return out;
}

function compactItemDropRow(row) {
  const out = {
    mobId: row.mobId,
    mobName: row.mobName || null,
  };
  if (row.mobLevel !== null) out.mobLevel = row.mobLevel;
  if (row.mobExp !== null) out.mobExp = row.mobExp;
  if (row.index !== null) out.index = row.index;
  if (row.probRaw) out.probRaw = row.probRaw;
  if (row.prob !== null) out.prob = row.prob;
  if (row.min !== null) out.min = row.min;
  if (row.max !== null) out.max = row.max;
  if (row.premium !== null) out.premium = row.premium;
  if (row.period !== null) out.period = row.period;
  if (row.dateExpire !== null) out.dateExpire = row.dateExpire;
  return out;
}

function parseInfoMap(infoRaw) {
  const map = {};
  if (!infoRaw) {
    return map;
  }
  const chunks = String(infoRaw).split(",");
  for (const chunk of chunks) {
    const token = chunk.trim();
    if (!token) {
      continue;
    }
    const eq = token.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim();
    if (!key) {
      continue;
    }
    map[key] = value;
  }
  return map;
}

function parseProb(value) {
  const text = asText(value);
  if (!text) {
    return null;
  }
  const match = text.match(/(-?\d+(?:\.\d+)?)/g);
  if (!match || !match.length) {
    return null;
  }
  const last = Number(match[match.length - 1]);
  return Number.isFinite(last) ? last : null;
}

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readWzValue(node) {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(node, "_value")) {
    return node._value;
  }
  return null;
}

function stripMobPrefix(key) {
  const text = asText(key).trim();
  return text.startsWith("m") ? text.slice(1) : text;
}

function normalizeMobId(id) {
  const raw = asText(id).trim();
  if (!/^\d+$/.test(raw)) {
    return raw || null;
  }
  return raw.padStart(7, "0");
}

function normalizeItemId(id) {
  const raw = asText(id).trim();
  if (!/^\d+$/.test(raw)) {
    return raw || null;
  }
  if (raw.length >= 8) {
    return raw;
  }
  return raw.padStart(8, "0");
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  const text = readText(manifestPath);
  const match = text.match(/=\s*(\[[\s\S]*\])\s*;?\s*$/);
  if (!match) {
    return [];
  }
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function readText(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return text.replace(/^\uFEFF/, "");
}

function asText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function valueOrDash(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function sanitizeMd(text) {
  return asText(text).replace(/\|/g, "\\|");
}

function asAbs(p) {
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

function normalizePathForOutput(p) {
  return path.relative(ROOT, p).replace(/\\/g, "/") || ".";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
