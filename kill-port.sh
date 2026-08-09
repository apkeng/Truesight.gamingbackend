#!/bin/bash
# Script to kill process on port 5000
# Usage: ./kill-port.sh

PORT=${1:-5000}

echo "Checking for processes on port $PORT..."

PIDS=$(lsof -ti:$PORT)

if [ -z "$PIDS" ]; then
  echo "No processes found on port $PORT"
else
  echo "Found processes: $PIDS"
  echo "Killing processes on port $PORT..."
  kill -9 $PIDS
  sleep 1
  if lsof -ti:$PORT > /dev/null 2>&1; then
    echo "Warning: Some processes may still be running"
  else
    echo "Port $PORT is now free!"
  fi
fi
