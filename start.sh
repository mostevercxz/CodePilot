#!/usr/bin/env bash
set -e

PORT=22222
HOST=0.0.0.0
DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/.codepilot.pid"
LOGFILE="$DIR/.codepilot.log"

# Check if already running
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "CodePilot is already running (PID $(cat "$PIDFILE")), port $PORT"
  exit 0
fi

cd "$DIR"
echo "Starting CodePilot on $HOST:$PORT ..."
nohup npx next dev -p "$PORT" -H "$HOST" > "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"
echo "CodePilot started (PID $!, log: $LOGFILE)"
echo "Open http://localhost:$PORT"
