#!/usr/bin/env node
/**
 * Wheat PDF Builder
 * Converts markdown files in output/ to PDF using md-to-pdf
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const target = process.argv[2];

if (!target) {
  console.error('Usage: node build-pdf.js <markdown-file>');
  console.error('  e.g. node build-pdf.js output/brief.md');
  process.exit(1);
}

if (!fs.existsSync(target)) {
  console.error(`File not found: ${target}`);
  process.exit(1);
}

try {
  execSync(`npx md-to-pdf "${target}"`, { stdio: 'inherit' });
  const pdfPath = target.replace(/\.md$/, '.pdf');
  console.log(`PDF generated: ${pdfPath}`);
} catch (e) {
  console.error('PDF generation failed:', e.message);
  process.exit(1);
}
