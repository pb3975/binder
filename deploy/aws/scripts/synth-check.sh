#!/bin/sh
# Synthesizes the stack for the default (token, internal, HTTP) and for OIDC + HTTPS, then lints
# both templates with cfn-lint. Needs no AWS credentials. Synthetic values only.
#   deploy/aws/scripts/synth-check.sh
#   CFN_LINT="docker run --rm -v $PWD:/w -w /w <image> cfn-lint" deploy/aws/scripts/synth-check.sh
set -eu
cd "$(dirname "$0")/.."
CFN_LINT=${CFN_LINT:-cfn-lint}
REGION=us-east-1
export CDK_DEFAULT_REGION=$REGION
unset CDK_DEFAULT_ACCOUNT AWS_PROFILE || true

rm -rf cdk.out/check
cdk() { ./node_modules/.bin/cdk synth --quiet --no-version-reporting --no-notices "$@"; }

cdk -o cdk.out/check/default
cdk -o cdk.out/check/oidc \
  -c auth=oidc \
  -c domainName=binder.example.com -c hostedZoneId=Z0123456789EXAMPLE \
  -c oidcIssuer=https://sso.example.com/realms/team -c oidcClientId=binder \
  -c oidcClientSecretArn=arn:aws:secretsmanager:us-east-1:123456789012:secret:binder/oidc-AbCdEf \
  -c allowedGroups=binder-users -c oidcLabel=Keycloak

# An unsafe combination must stop synth.
if cdk -o cdk.out/check/refused -c internetFacing=true -c auth=none >/dev/null 2>&1; then
  echo "synth-check: internetFacing=true with auth=none was not refused" >&2
  exit 1
fi

# W3005: CDK's own VPC custom resource (restrictDefaultSecurityGroup) adds a DependsOn that a GetAtt
# already implies. It is harmless and not ours to change. Every other rule stays on.
$CFN_LINT --regions "$REGION" --ignore-checks W3005 -- cdk.out/check/default/Binder.template.json cdk.out/check/oidc/Binder.template.json
echo "synth-check: ok"
