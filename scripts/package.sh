#!/usr/bin/env bash
# Builds dist/tj-record-<version>.zip for the Chrome Web Store (or a policy-installed .crx): only the
# files the extension loads, no tests, docs or git metadata. Fails if a file the manifest or a page
# refers to is missing, or if the default app URL still points at the development preview.
#   scripts/package.sh            # release build
#   scripts/package.sh --allow-dev  # build anyway with the development-preview app URL
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(
  manifest.json
  background.js offscreen.html offscreen.js screen.html screen.js screen.css
  popup.html popup.js popup.css
  logger.js relay.js bridge.js crop.js
  lib/config.js lib/db.js lib/webm-duration.js lib/webm-mux.js
  icons/16.png icons/32.png icons/48.png icons/128.png
)

VERSION=$(node -p "require('./manifest.json').version")

for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
  case "$f" in *.js) node --check "$f" ;; esac
done

# Every local script, stylesheet and icon referenced by a page or the manifest must be packaged.
node - "${FILES[@]}" <<'EOF'
const fs = require('fs');
const files = new Set(process.argv.slice(2));
const refs = [];
const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
refs.push(m.background.service_worker, m.action.default_popup, ...Object.values(m.icons), ...Object.values(m.action.default_icon));
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  if (f.endsWith('.html')) for (const [, r] of text.matchAll(/(?:src|href)="([^"#?:]+)"/g)) refs.push(r);
  if (f.endsWith('.js')) {
    for (const [, r] of text.matchAll(/from '(\.[^']+)'/g)) refs.push(require('path').join(require('path').dirname(f), r));
    for (const [, r] of text.matchAll(/(?:files|js): \[([^\]]+)\]/g)) for (const [, x] of r.matchAll(/'([^']+)'/g)) refs.push(x);
    for (const [, r] of text.matchAll(/getURL\('([^']+\.html)'\)/g)) refs.push(r);
    for (const [, r] of text.matchAll(/url: '([^']+\.html)'/g)) refs.push(r);
  }
}
const missing = [...new Set(refs)].filter((r) => !files.has(r));
if (missing.length) {
  console.error('referenced but not packaged: ' + missing.join(', '));
  process.exit(1);
}
EOF

if grep -E "^export const DEFAULT_APP_URL" lib/config.js | grep -q "env=development" && [ "${1:-}" != "--allow-dev" ]; then
  echo "lib/config.js: DEFAULT_APP_URL still opens the development preview (?env=development)." >&2
  echo "Point it at the released TJ Record app, or pass --allow-dev for an internal build." >&2
  exit 1
fi

mkdir -p dist
OUT="dist/tj-record-$VERSION.zip"
rm -f "$OUT"
zip -q -X "$OUT" "${FILES[@]}"
echo "$OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '), ${#FILES[@]} files)"
