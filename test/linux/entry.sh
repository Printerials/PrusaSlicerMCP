#!/bin/sh
# Inside the container, as root: start the buses a desktop session would have, unpack the
# repository from stdin into the tester's home, and run the given command there as tester.
set -e
runtime="/run/user/$(id -u tester)"
mkdir -p /run/dbus /cache /home/tester/repo "$runtime"
dbus-daemon --system --fork
chown tester /cache "$runtime"
chmod 700 "$runtime"
tar --warning=no-unknown-keyword -xf - -C /home/tester/repo
printf '%s\n' "$*" > /home/tester/command.sh
chown -R tester /home/tester/repo /home/tester/command.sh
exec su tester -c "export HOME=/home/tester XDG_RUNTIME_DIR=$runtime PRUSASLICER_MCP_TEST_CACHE=/cache; cd /home/tester/repo && exec dbus-run-session -- sh -e /home/tester/command.sh"
