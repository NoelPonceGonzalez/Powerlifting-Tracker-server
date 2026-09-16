#!/usr/bin/env bash
set -euo pipefail
cd /home/ec2-user/powerlifting-tracker
source ~/.nvm/nvm.sh

# CORS / APP_URL para el preview de Vercel
APP="https://powerlifting-tracker-client-moxhnr0rl-noels-projects-adf0b47f.vercel.app"
EXTRA="https://powerlifting-tracker-client.vercel.app,https://powerlifting-tracker-client-noels-projects-adf0b47f.vercel.app"
if grep -q '^APP_URL=' .env; then
  sed -i "s|^APP_URL=.*|APP_URL=${APP}|" .env
else
  printf '\nAPP_URL=%s\n' "$APP" >> .env
fi
if grep -q '^CORS_ORIGINS=' .env; then
  sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=${APP},${EXTRA}|" .env
else
  printf 'CORS_ORIGINS=%s,%s\n' "$APP" "$EXTRA" >> .env
fi

echo "=== ENV PUBLIC ==="
grep -E '^(NODE_ENV|PORT|APP_URL|CORS_ORIGINS)=' .env || true

# Abrir TCP 3000 (y 80) en el security group si el rol IAM lo permite
TOKEN=$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
echo "=== IAM ROLE ==="
curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/ || echo "NO_IAM"
echo
MAC=$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/network/interfaces/macs/)
echo "MAC=$MAC"
SG=$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" "http://169.254.169.254/latest/meta-data/network/interfaces/macs/${MAC}security-group-ids")
echo "SG=$SG"

if command -v aws >/dev/null 2>&1; then
  echo "aws cli present"
else
  echo "installing aws cli..."
  sudo dnf install -y awscli >/dev/null 2>&1 || sudo yum install -y awscli >/dev/null 2>&1 || echo "AWSCLI_INSTALL_FAIL"
fi

if command -v aws >/dev/null 2>&1 && [[ -n "$SG" ]]; then
  for port in 3000 80; do
    echo "authorize $SG tcp $port"
    aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port "$port" --cidr 0.0.0.0/0 && echo "OPENED $port" || echo "OPEN_FAIL_OR_EXISTS $port"
  done
else
  echo "NO_AWS_OR_NO_SG"
fi

pm2 restart powerlifting
sleep 3
curl -sS -m 5 http://127.0.0.1:3000/health || true
echo
