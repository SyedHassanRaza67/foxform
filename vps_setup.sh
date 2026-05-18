#!/bin/bash
set -e

echo "=== SWAP SETUP ==="
if [ -z "$(swapon --show)" ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "SWAP: Created 2GB swap"
else
  echo "SWAP: Already exists"
fi
free -h

echo ""
echo "=== PM2 STARTUP ==="
pm2 startup systemd -u root --hp /root 2>&1
systemctl enable pm2-root 2>/dev/null || true
pm2 save
echo "PM2 startup configured"

echo ""
echo "=== CHROME DEPS CHECK ==="
dpkg -l | grep -E "libgbm|libnss3|libatk" | awk '{print $2, $3}' | head -5

echo ""
echo "=== FINAL PM2 STATUS ==="
pm2 list

echo ""
echo "=== APP HEALTH ==="
curl -s -o /dev/null -w "Port 5000: HTTP %{http_code}\n" http://127.0.0.1:5000
curl -s -o /dev/null -w "Port 80 (Nginx): HTTP %{http_code}\n" http://127.0.0.1:80

echo ""
echo "=== ALL DONE ==="
