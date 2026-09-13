#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

echo "Starting JobOps WhatsApp pairing..."
echo "On your phone: WhatsApp -> Settings -> Linked Devices -> Link a Device"
echo
npm run whatsapp:collector
