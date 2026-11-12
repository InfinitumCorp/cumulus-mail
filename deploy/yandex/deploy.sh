#!/usr/bin/env bash
# Build, push and roll out the Russia copy to a Yandex Cloud Serverless Container.
# Read docs/deploy/yandex-ru.md first. Nothing here holds a secret: secrets are
# Lockbox references. Requires: docker, yc (logged in to the right cloud/folder).
#
#   REGISTRY_ID=crp...  SA_ID=aje...  LOCKBOX_ID=e6q...  ./deploy/yandex/deploy.sh
set -euo pipefail

: "${REGISTRY_ID:?Container Registry id (yc container registry list)}"
: "${SA_ID:?service account id that can pull images and read the Lockbox secret}"
: "${LOCKBOX_ID:?Lockbox secret id holding BETTER_AUTH_SECRET, DATABASE_URL, MAIL_BLOB_KEY, MAIL_S3_*, CRON_SECRET}"
CONTAINER_NAME="${CONTAINER_NAME:-cumulus-mail-ru}"
TAG="${TAG:-$(git rev-parse --short HEAD)}"
IMAGE="cr.yandex/${REGISTRY_ID}/cumulus-mail-ru:${TAG}"
ENV_FILE="$(dirname "$0")/ru.env.example"

echo "Folder: $(yc config get folder-id)  Image: ${IMAGE}"
read -r -p "Deploy this image to ${CONTAINER_NAME} in that folder? [y/N] " ok
[ "${ok}" = "y" ] || { echo "Stopped."; exit 1; }

docker build -t "${IMAGE}" .
yc container registry configure-docker >/dev/null
docker push "${IMAGE}"

yc serverless container get --name "${CONTAINER_NAME}" >/dev/null 2>&1 \
  || yc serverless container create --name "${CONTAINER_NAME}"

# Plain (non-secret) settings from the example file: KEY=VALUE lines only.
env_args=()
while IFS= read -r line; do
  [[ "${line}" =~ ^[A-Z_][A-Z0-9_]*= ]] && env_args+=(--environment "${line}")
done < "${ENV_FILE}"

secret_args=()
for key in BETTER_AUTH_SECRET DATABASE_URL MAIL_BLOB_KEY MAIL_S3_ACCESS_KEY_ID MAIL_S3_SECRET_ACCESS_KEY CRON_SECRET; do
  secret_args+=(--secret "environment-variable=${key},id=${LOCKBOX_ID},key=${key}")
done

yc serverless container revision deploy \
  --container-name "${CONTAINER_NAME}" \
  --image "${IMAGE}" \
  --service-account-id "${SA_ID}" \
  --cores 1 --memory 1GB --core-fraction 100 \
  --concurrency 16 --execution-timeout 60s \
  "${env_args[@]}" "${secret_args[@]}"

echo "Deployed ${IMAGE}. Health: GET /api/auth/get-session must answer 200."
