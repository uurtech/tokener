#!/usr/bin/env bash
# Build a tokener release for AWS Marketplace: tests, container image, CloudFormation template, checks.
#
# Usage:
#   ./scripts/release.sh [--push] [--bump patch|minor|major]
#
# Environment (required for --push; otherwise the image is only built locally):
#   MARKETPLACE_ECR_REPO     e.g. 709825985650.dkr.ecr.us-east-1.amazonaws.com/<seller>/tokener
#   MARKETPLACE_PRODUCT_CODE product code from the Marketplace Management Portal
#   AWS_REGION               region of the Marketplace ECR repository (default us-east-1)
#
# Output: dist/release/<version>/  (template, checksums, image reference, release notes stub)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUSH=0; BUMP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=1 ;;
    --bump) BUMP="$2"; shift ;;
    *) echo "unknown argument $1"; exit 2 ;;
  esac
  shift
done
REGION="${AWS_REGION:-us-east-1}"
REPO="${MARKETPLACE_ECR_REPO:-}"
PRODUCT="${MARKETPLACE_PRODUCT_CODE:-}"
if [ "$PUSH" = 1 ] && { [ -z "$REPO" ] || [ -z "$PRODUCT" ]; }; then
  echo "--push needs MARKETPLACE_ECR_REPO and MARKETPLACE_PRODUCT_CODE"; exit 2
fi

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

cd "$ROOT/gateway"
if [ -n "$BUMP" ]; then step "Version bump ($BUMP)"; npm version "$BUMP" --no-git-tag-version >/dev/null; fi
VERSION="$(node -p "require('./package.json').version")"
OUT="$ROOT/dist/release/$VERSION"; mkdir -p "$OUT"
echo "tokener $VERSION"

step "Gateway: install, build, unit tests, smoke"
npm ci --silent
npm run build --silent
npm test --silent
AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-AKIARELEASESMOKE000}" AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-release-smoke}" npm run smoke --silent | tail -1
echo "prod dependency audit:"; npm audit --omit=dev --audit-level=high

step "Container image (linux/amd64)"
IMAGE_LOCAL="tokener:$VERSION"
docker buildx build --progress=quiet --platform linux/amd64 --build-arg "VERSION=$VERSION" -t "$IMAGE_LOCAL" --load .
docker image inspect "$IMAGE_LOCAL" --format 'size={{.Size}} arch={{.Architecture}} version={{index .Config.Labels "org.opencontainers.image.version"}}'
echo "runtime check:"
CID="$(docker run -d --rm -p 0:8080 -e STORE=sqlite -e ADMIN_TOKEN=release -e AWS_REGION="$REGION" -e MODEL_CATALOG_ENABLED=0 -e AWS_ACCESS_KEY_ID=AKIATEST -e AWS_SECRET_ACCESS_KEY=test "$IMAGE_LOCAL")"
PORT="$(docker port "$CID" 8080/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$PORT/health"; echo
curl -sf -o /dev/null "http://127.0.0.1:$PORT/admin/" && echo "admin console: ok"
docker stop "$CID" >/dev/null

IMAGE_REF="$IMAGE_LOCAL"
if [ "$PUSH" = 1 ]; then
  step "Push to Marketplace ECR"
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${REPO%%/*}" >/dev/null
  docker tag "$IMAGE_LOCAL" "$REPO:$VERSION"
  docker push "$REPO:$VERSION" | tail -1
  IMAGE_REF="$REPO:$VERSION"
fi

step "CloudFormation template"
cd "$ROOT/infra"
npm ci --silent
mkdir -p dist
npx cdk synth -c marketplace=1 -c "image=$IMAGE_REF" --json tokener-marketplace 2>dist/synth.log > "$OUT/tokener-marketplace.template.json"
if [ -n "$PRODUCT" ]; then
  # Bake the product code into the parameter default so buyers never have to type it.
  node -e "
    const fs=require('fs'); const f='$OUT/tokener-marketplace.template.json'; const t=JSON.parse(fs.readFileSync(f,'utf8'));
    t.Parameters.MarketplaceProductCode.Default='$PRODUCT'; fs.writeFileSync(f, JSON.stringify(t,null,1));"
fi
node scripts/check-template.mjs "$OUT/tokener-marketplace.template.json"
if [ -x .venv/bin/cfn-lint ]; then .venv/bin/cfn-lint --non-zero-exit-code error "$OUT/tokener-marketplace.template.json" && echo "cfn-lint: ok (warnings allowed)"; else echo "cfn-lint: skipped (python3 -m venv infra/.venv && infra/.venv/bin/pip install cfn-lint)"; fi

step "Release artefacts"
(cd "$OUT" && shasum -a 256 tokener-marketplace.template.json > SHA256SUMS)
cat > "$OUT/RELEASE.md" <<MD
# tokener $VERSION

- Image: \`$IMAGE_REF\`
- Template: \`tokener-marketplace.template.json\` (sha256 in SHA256SUMS)
- Product code: ${PRODUCT:-<not baked; set MARKETPLACE_PRODUCT_CODE>}
- Built: $(date -u +%Y-%m-%dT%H:%M:%SZ)

## Changes
$(awk "/^## \[?$VERSION/{f=1;next} /^## /{f=0} f" "$ROOT/CHANGELOG.md" 2>/dev/null || echo "- see CHANGELOG.md")
MD
ls -la "$OUT"
echo
echo "Next: upload $OUT/tokener-marketplace.template.json to the listing's S3 bucket and add version $VERSION in the Marketplace Management Portal."
