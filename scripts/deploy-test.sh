#!/usr/bin/env bash
# Deploy a tokener Marketplace template into an AWS account exactly like a buyer would, then verify it.
#
# Usage:
#   ./scripts/deploy-test.sh <template.json> --cert <ACM certificate ARN> [--domain host] [--admin-cidr a.b.c.d/32[,...]]
#                            [--image <ecr uri>] [--product-code <code>] [--stack tokener-test] [--region us-east-1] [--destroy]
#
# Needs AWS CLI credentials for the target account (CAPABILITY_IAM). Prints the outputs, checks /health, the
# admin API with the generated token, model discovery and (if a developer is created) a count_tokens round trip.
set -euo pipefail
TEMPLATE="${1:?template path}"; shift
STACK="tokener-test"; REGION="${AWS_REGION:-us-east-1}"; CERT=""; DOMAIN=""; CIDR=""; IMAGE=""; PRODUCT=""; DESTROY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cert) CERT="$2"; shift ;; --domain) DOMAIN="$2"; shift ;; --admin-cidr) CIDR="$2"; shift ;;
    --image) IMAGE="$2"; shift ;; --product-code) PRODUCT="$2"; shift ;; --stack) STACK="$2"; shift ;; --region) REGION="$2"; shift ;;
    --destroy) DESTROY=1 ;; *) echo "unknown argument $1"; exit 2 ;;
  esac; shift
done
if [ "$DESTROY" = 1 ]; then
  aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION"
  echo "deleting $STACK (DynamoDB tables and the admin secret are retained by design)"; exit 0
fi
[ -n "$CERT" ] || { echo "--cert is required (HTTPS is mandatory)"; exit 2; }
[ -n "$CIDR" ] || CIDR="$(curl -s https://checkip.amazonaws.com)/32"
PARAMS=(ParameterKey=CertificateArn,ParameterValue="$CERT" ParameterKey=AdminAllowedCidrs,ParameterValue="$CIDR" ParameterKey=DesiredCount,ParameterValue=1)
[ -n "$DOMAIN" ] && PARAMS+=(ParameterKey=DomainName,ParameterValue="$DOMAIN")
[ -n "$IMAGE" ] && PARAMS+=(ParameterKey=ContainerImage,ParameterValue="$IMAGE")
[ -n "$PRODUCT" ] && PARAMS+=(ParameterKey=MarketplaceProductCode,ParameterValue="$PRODUCT")

echo "== validate"; aws cloudformation validate-template --template-body "file://$TEMPLATE" --region "$REGION" --query 'Description' --output text
echo "== deploy $STACK in $REGION (admin from $CIDR)"
aws cloudformation deploy --stack-name "$STACK" --region "$REGION" --template-file "$TEMPLATE" --capabilities CAPABILITY_IAM --parameter-overrides "${PARAMS[@]}" --no-fail-on-empty-changeset
echo "== outputs"
aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
LB="$(out LoadBalancerDns)"; SECRET="$(out AdminTokenSecretArn)"
HOST="${DOMAIN:-$LB}"
ADMIN="$(aws secretsmanager get-secret-value --secret-id "$SECRET" --region "$REGION" --query SecretString --output text)"

echo "== health (via load balancer DNS, certificate name may not match yet -> -k)"
for _ in $(seq 1 40); do curl -sk "https://$LB/health" >/dev/null 2>&1 && break; sleep 10; done
curl -sk "https://$LB/health"; echo
echo "== admin API"
curl -sk -H "authorization: Bearer $ADMIN" "https://$LB/admin/api/config" | head -c 300; echo
echo "== diagnostics (store, catalog, Bedrock round trip, Marketplace)"
curl -sk -X POST -H "authorization: Bearer $ADMIN" "https://$LB/admin/api/diagnostics"; echo
echo "== developer token + model discovery"
TOKEN="$(curl -sk -X POST -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"developerId":"deploy-test","dailyBudgetUsd":1}' "https://$LB/admin/api/developers" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
curl -sk -H "authorization: Bearer $TOKEN" "https://$LB/v1/models" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["data"]), "models visible to developers")'
curl -sk -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"ping"}]}' "https://$LB/v1/messages/count_tokens"; echo
curl -sk -o /dev/null -X POST -H "authorization: Bearer $ADMIN" "https://$LB/admin/api/developers/deploy-test/revoke"
cat <<MSG

Deployed. Point a CNAME for ${DOMAIN:-<your hostname>} at $LB, then open https://$HOST/admin/ from $CIDR.
Admin token: aws secretsmanager get-secret-value --secret-id $SECRET --query SecretString --output text
Tear down:   $0 x --stack $STACK --region $REGION --destroy
MSG
