#!/bin/sh
set -e

echo "==> Running database migrations..."
prisma migrate deploy

echo "==> Starting Gui Chat application..."
exec node server.js
