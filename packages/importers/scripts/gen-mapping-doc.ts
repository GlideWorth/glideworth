/** Regenerates docs/projectionlab-mapping.md from the coverage rules + the synthetic fixture. */
import { writeFileSync } from "node:fs";
import { buildCoverage, collectKeyPaths } from "../src/projectionlab/index.js";
import { renderMappingDoc } from "../src/projectionlab/mapping-doc.js";
import { buildSyntheticExport } from "../test/fixtures/projectionlab-synthetic.js";

const fixture = buildSyntheticExport();
const doc = renderMappingDoc(buildCoverage(collectKeyPaths(fixture)), "4.6.0");
const target = new URL("../docs/projectionlab-mapping.md", import.meta.url);
writeFileSync(target, doc, "utf8");
console.log(`wrote ${target.pathname} (${doc.split("\n").length} lines)`);
