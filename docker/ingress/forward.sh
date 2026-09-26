#!/bin/sh
# Each FORWARD entry is listen_port:target_host:target_port.
set -eu
for spec in ${FORWARDS}; do
  listen=${spec%%:*}; rest=${spec#*:}; host=${rest%%:*}; port=${rest#*:}
  socat TCP-LISTEN:"$listen",fork,reuseaddr TCP:"$host":"$port" &
done
wait
