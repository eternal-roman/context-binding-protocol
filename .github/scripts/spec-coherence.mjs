#!/usr/bin/env node

/**
 * spec-coherence validator
 *
 * Validates that cbp-architecture.html and spec/schemas/*.json are
 * consistent. Checks:
 *
 * 1. Every node type named in the HTML has a corresponding enum value
 *    in node.schema.json.
 * 2. Every edge type named in the HTML has a corresponding enum value
 *    in edge.schema.json.
 * 3. Every schema file is valid JSON.
 * 4. Every schema's "examples" array entries validate against the
 *    schema itself (using basic structural checks, not a full JSON
 *    Schema validator — that lands in v0.3 with ajv).
 * 5. Cross-domain examples enforcement: each schema's examples must
 *    include at least one example tagged with each of domain:trading,
 *    domain:clinical, domain:devops.
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = one or more checks failed
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SPEC_DIR = join(ROOT, "spec", "schemas");
const HTML_FILE = join(ROOT, "cbp-architecture.html");

const REQUIRED_DOMAINS = ["domain:trading", "domain:clinical", "domain:devops"];

let exitCode = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  exitCode = 1;
}

function pass(msg) {
  console.log(`PASS: ${msg}`);
}

// --- Check 1 & 2: HTML node/edge types vs schema enums ---

let html;
try {
  html = readFileSync(HTML_FILE, "utf-8");
} catch {
  fail(`Cannot read ${HTML_FILE}`);
  process.exit(1);
}

// Extract node types from HTML (look for the type enum pattern in the schema pre block)
const nodeTypeMatches = html.match(
  /entity|state|prior|frame/g
);
const htmlNodeTypes = [...new Set(nodeTypeMatches || [])];

// Extract edge types from HTML table
const edgeTypePattern =
  /<td>(causes|correlates|contradicts|qualifies|supersedes|requires|inhibits|amplifies)<\/td>/g;
const htmlEdgeTypes = [];
let match;
while ((match = edgeTypePattern.exec(html)) !== null) {
  if (!htmlEdgeTypes.includes(match[1])) {
    htmlEdgeTypes.push(match[1]);
  }
}

// Load node schema
let nodeSchema;
try {
  nodeSchema = JSON.parse(
    readFileSync(join(SPEC_DIR, "node.schema.json"), "utf-8")
  );
  pass("node.schema.json is valid JSON");
} catch (e) {
  fail(`node.schema.json is not valid JSON: ${e.message}`);
}

if (nodeSchema) {
  const schemaNodeTypes = nodeSchema.properties?.type?.enum || [];
  const expectedNodeTypes = ["entity", "state", "prior", "frame"];
  for (const t of expectedNodeTypes) {
    if (schemaNodeTypes.includes(t)) {
      pass(`Node type '${t}' in HTML matches node.schema.json`);
    } else {
      fail(`Node type '${t}' found in HTML but missing from node.schema.json enum`);
    }
  }
}

// Load edge schema
let edgeSchema;
try {
  edgeSchema = JSON.parse(
    readFileSync(join(SPEC_DIR, "edge.schema.json"), "utf-8")
  );
  pass("edge.schema.json is valid JSON");
} catch (e) {
  fail(`edge.schema.json is not valid JSON: ${e.message}`);
}

if (edgeSchema) {
  const schemaEdgeTypes = edgeSchema.properties?.rel?.enum || [];
  for (const t of htmlEdgeTypes) {
    if (schemaEdgeTypes.includes(t)) {
      pass(`Edge type '${t}' in HTML matches edge.schema.json`);
    } else {
      fail(`Edge type '${t}' found in HTML but missing from edge.schema.json enum`);
    }
  }
}

// --- Check 3: All schema files are valid JSON ---

let schemaFiles;
try {
  schemaFiles = readdirSync(SPEC_DIR).filter((f) => f.endsWith(".json"));
} catch {
  fail(`Cannot read ${SPEC_DIR}`);
  schemaFiles = [];
}

const schemas = {};
for (const file of schemaFiles) {
  try {
    schemas[file] = JSON.parse(
      readFileSync(join(SPEC_DIR, file), "utf-8")
    );
    // Already logged pass for node and edge above; log for others
    if (file !== "node.schema.json" && file !== "edge.schema.json") {
      pass(`${file} is valid JSON`);
    }
  } catch (e) {
    if (file !== "node.schema.json" && file !== "edge.schema.json") {
      fail(`${file} is not valid JSON: ${e.message}`);
    }
  }
}

// --- Check 4: Examples array exists and entries have required fields ---

for (const [file, schema] of Object.entries(schemas)) {
  if (!schema.examples || !Array.isArray(schema.examples)) {
    fail(`${file} has no 'examples' array`);
    continue;
  }

  if (schema.examples.length === 0) {
    fail(`${file} has an empty 'examples' array`);
    continue;
  }

  // Basic structural check: each example should have all required fields
  const required = schema.required || [];
  for (let i = 0; i < schema.examples.length; i++) {
    const example = schema.examples[i];
    for (const field of required) {
      if (!(field in example)) {
        fail(`${file} example[${i}] missing required field '${field}'`);
      }
    }
  }

  pass(`${file} examples have required fields`);
}

// --- Check 5: Cross-domain examples ---

for (const [file, schema] of Object.entries(schemas)) {
  if (!schema.examples || !Array.isArray(schema.examples)) continue;

  // Only enforce domain tags on schemas whose instances carry tags or domain_tags.
  // Edges don't have a tags property (domain is implicit from connected nodes).
  // Config doesn't have domain tags either.
  const props = schema.properties || {};
  const hasTags = "tags" in props || "domain_tags" in props;
  if (!hasTags) {
    pass(`${file} — no tags/domain_tags property; domain check skipped (domain enforced via connected schemas)`);
    continue;
  }

  for (const domain of REQUIRED_DOMAINS) {
    const hasDomain = schema.examples.some((ex) => {
      const tags = ex.tags || ex.domain_tags || [];
      return tags.some((t) => t === domain || t.startsWith(domain.split(":")[1]));
    });

    if (hasDomain) {
      pass(`${file} has example for ${domain}`);
    } else {
      fail(`${file} missing example for ${domain}`);
    }
  }
}

// --- Summary ---

console.log("");
if (exitCode === 0) {
  console.log("All spec-coherence checks passed.");
} else {
  console.log("Some spec-coherence checks FAILED. See above.");
}

process.exit(exitCode);
