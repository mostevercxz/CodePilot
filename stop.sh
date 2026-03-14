#!/usr/bin/env bash

DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/.codepilot.pid"
PORT=22222

if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "CodePilot stopped (PID $PID)"
  else
    echo "PID $PID not running, cleaning up"
  fi
  rm -f "$PIDFILE"
else
  # Fallback: kill by port
  PIDS=$(lsof -t -i:"$PORT" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    kill $PIDS 2>/dev/null
    echo "Stopped process(es) on port $PORT"
  else
    echo "CodePilot is not running"
  fi
fi
