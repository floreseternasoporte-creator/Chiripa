#!/usr/bin/env bash
# Vega Platforms — backend de Chiripa en AWS (sin Firebase).
#
# Ejecutar en AWS CloudShell (región us-east-1):
#   bash setup-vega.sh
#
# Crea:
#   1. Tabla DynamoDB `chiripa-kv` (pk/sk, pago por demanda).
#   2. Cognito Identity Pool `vega-platforms` vinculado al User Pool de
#      Drex (la cuenta Vega Platforms): entrar en Chiripa con la misma
#      cuenta de Drex da credenciales AWS para la tabla de Chiripa.
#   3. Rol IAM autenticado con acceso SOLO a la tabla chiripa-kv.
#
# Al final imprime el identityPoolId para pegarlo en chiripa-cloud.js.
set -euo pipefail

REGION="us-east-1"
TABLE="chiripa-kv"
POOL_NAME="vega-platforms"
ROLE_NAME="vega-chiripa-auth-role"
POLICY_NAME="vega-chiripa-dynamo-kv"
USER_POOL_ID="us-east-1_kDSYEBsnY"
USER_POOL_CLIENT_ID="7cm12q14tm12u8b3bnn6ksjqni"
PROVIDER="cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
TABLE_ARN="arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE}"
echo "Cuenta ${ACCOUNT_ID} · región ${REGION}"

# ---------- 1. DynamoDB ----------
if aws dynamodb describe-table --region "$REGION" --table-name "$TABLE" >/dev/null 2>&1; then
  echo "Tabla ${TABLE} ya existe, se conserva."
else
  aws dynamodb create-table --region "$REGION" --table-name "$TABLE" \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "Creando tabla ${TABLE}…"
fi
aws dynamodb wait table-exists --region "$REGION" --table-name "$TABLE"
echo "Tabla ${TABLE}: ACTIVA"

# ---------- 2. Cognito Identity Pool (cuenta Vega Platforms) ----------
POOL_ID="$(aws cognito-identity list-identity-pools --region "$REGION" --max-results 60 \
  --query "IdentityPools[?IdentityPoolName=='${POOL_NAME}'].IdentityPoolId" --output text)"
if [ -z "$POOL_ID" ] || [ "$POOL_ID" = "None" ]; then
  POOL_ID="$(aws cognito-identity create-identity-pool --region "$REGION" \
    --identity-pool-name "$POOL_NAME" --no-allow-unauthenticated-identities \
    --cognito-identity-providers "ProviderName=${PROVIDER},ClientId=${USER_POOL_CLIENT_ID},ServerSideTokenCheck=false" \
    --query IdentityPoolId --output text)"
  echo "Identity Pool creado: ${POOL_ID}"
else
  aws cognito-identity update-identity-pool --region "$REGION" \
    --identity-pool-id "$POOL_ID" --identity-pool-name "$POOL_NAME" \
    --no-allow-unauthenticated-identities \
    --cognito-identity-providers "ProviderName=${PROVIDER},ClientId=${USER_POOL_CLIENT_ID},ServerSideTokenCheck=false" >/dev/null
  echo "Identity Pool ya existía: ${POOL_ID}"
fi

# ---------- 3. Rol IAM autenticado ----------
TRUST_FILE="$(mktemp)"
cat > "$TRUST_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "cognito-identity.amazonaws.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "cognito-identity.amazonaws.com:aud": "${POOL_ID}" },
      "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" }
    }
  }]
}
JSON
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "file://${TRUST_FILE}"
else
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "file://${TRUST_FILE}" >/dev/null
fi
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"

POLICY_FILE="$(mktemp)"
cat > "$POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem"
    ],
    "Resource": "${TABLE_ARN}"
  }]
}
JSON
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" --policy-document "file://${POLICY_FILE}"
rm -f "$TRUST_FILE" "$POLICY_FILE"
echo "Rol ${ROLE_NAME} listo (solo tabla ${TABLE}; sin Scan)."

# ---------- 4. Asignar el rol autenticado al pool ----------
aws cognito-identity set-identity-pool-roles --region "$REGION" \
  --identity-pool-id "$POOL_ID" --roles authenticated="$ROLE_ARN" >/dev/null
echo "Rol autenticado asignado al Identity Pool."

echo ""
echo "================= LISTO ================="
echo "identityPoolId: ${POOL_ID}"
echo "tabla:          ${TABLE} (${REGION})"
echo "userPool:       ${USER_POOL_ID} (cuenta Vega Platforms)"
