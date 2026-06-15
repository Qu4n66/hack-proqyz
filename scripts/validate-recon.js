#!/usr/bin/env node
/**
 * Validate a Phase 0 recon dump.
 *
 * Reads proqyz-inspection-*.json and reports which keys from our
 * selectors map are present in the captured DOM. This catches "I forgot
 * to navigate to the question editor" before the human wastes time
 * filling in selectors that aren't there.
 *
 * Usage:
 *   node scripts/validate-recon.js proqyz-inspection-create-quiz.json
 *   node scripts/validate-recon.js proqyz-inspection-*.json
 */

import { readFile } from "node:fs/promises";
import { Selectors } from "../src/uploader/ui/selectors.js";

/**
 * Pull a representative selector string out of each entry in the
 * Selectors map. For object-valued entries, pick the first selector
 * string. Returns a flat list of probe strings.
 */
function flattenSelectors(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      out.push({ path: prefix + k, value: v });
    } else if (v && typeof v === "object") {
      out.push(...flattenSelectors(v, prefix + k + "."));
    }
  }
  return out;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node scripts/validate-recon.js <inspection.json> [...]");
  process.exit(1);
}

const allProbes = flattenSelectors(Selectors);

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  let data;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    continue;
  }

  // Collect every piece of textual evidence the inspector captured:
  // selector strings, label texts, button texts, names, ids, data-testids.
  const haystack = new Set();
  function add(s) {
    if (typeof s === "string" && s) haystack.add(s);
  }
  for (const i of data.inputs || []) {
    add(i.id);
    add(i.name);
    add(i.label);
    add(i["data-testid"]);
    add(i["data-field"]);
  }
  for (const b of data.buttons || []) {
    add(b.text);
    add(b["data-testid"]);
  }
  for (const r of data.radios || []) {
    add(r.name);
    add(r.value);
    add(r["data-testid"]);
  }
  // Editor types and their DOM markers.
  for (const [k, n] of Object.entries(data.editors || {})) {
    add(k);
  }

  // For each probe selector, check whether any of its key tokens appear
  // in the haystack. This is a soft check — a real selector like
  // `input[name="title"]` will match if the haystack contains "title".
  const matches = [];
  const misses = [];
  for (const { path, value } of allProbes) {
    // Pull out meaningful tokens: data-testid values, name= values,
    // quoted strings, has-text values.
    const tokens = [
      ...(value.match(/data-testid="([^"]+)"/g) || []).map((s) => s.split('"')[1]),
      ...(value.match(/name="([^"]+)"/g) || []).map((s) => s.split('"')[1]),
      ...(value.match(/:has-text\("([^"]+)"\)/g) || []).map((s) => s.split('"')[1]),
      ...(value.match(/\[([a-z-]+)="([^"]+)"\]/g) || []).map((s) => s.split('"')[1]),
    ];
    if (tokens.length === 0) continue;
    const found = tokens.find((t) => haystack.has(t));
    if (found) matches.push({ path, found });
    else misses.push({ path, tokens });
  }

  const total = matches.length + misses.length;
  const pct = total ? Math.round((matches.length / total) * 100) : 0;
  console.log(`  coverage: ${matches.length}/${total} (${pct}%)`);

  if (misses.length) {
    console.log(`  MISSING (${misses.length}):`);
    for (const m of misses.slice(0, 20)) {
      console.log(`    - ${m.path}: looked for ${m.tokens.join(", ")}`);
    }
    if (misses.length > 20) console.log(`    ... and ${misses.length - 20} more`);
  } else {
    console.log("  all probes resolved against this page");
  }
}
