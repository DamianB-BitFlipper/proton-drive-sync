# FAQ

## Authentication Hangs

Sometimes, keyrings on Linux do not run when headless. The following instructions are for `gnome-keyring-daemon`, but other keyrings may require similar treatment.

To get this working:

1. Install dbus-x11:

   ```bash
   sudo apt install dbus-x11
   ```

2. Create `~/.keyring_init.sh` with the following content:

   ```bash
   #!/bin/bash

   ENV_FILE="$HOME/.keyring_env"

   function start_new_keyring {
       # 1. Start DBus (Silent)
       eval $(dbus-launch --sh-syntax)

       # 2. Start Keyring & Unlock with 'secret' (Silent)
       # We redirect stderr (2) to /dev/null to kill the "discover_other_daemon" message
       eval $(echo -n "secret" | gnome-keyring-daemon --login --daemonize 2>/dev/null)
       eval $(gnome-keyring-daemon --start 2>/dev/null)

       # 3. Save variables
       echo "export DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS'" > "$ENV_FILE"
       echo "export SSH_AUTH_SOCK='$SSH_AUTH_SOCK'" >> "$ENV_FILE"
       echo "export GNOME_KEYRING_PID='$GNOME_KEYRING_PID'" >> "$ENV_FILE"
       echo "export DBUS_SESSION_BUS_PID='$DBUS_SESSION_BUS_PID'" >> "$ENV_FILE"
   }

   # MAIN LOGIC
   if [ -f "$ENV_FILE" ]; then
       source "$ENV_FILE"
       # Check if the process ID in the file is actually still running
       if ! kill -0 "$GNOME_KEYRING_PID" 2>/dev/null; then
           # Process is dead, but file exists (Stale). Restart.
           start_new_keyring
       fi
   else
       # No file exists. Start fresh.
       start_new_keyring
   fi
   ```

3. Add the following to your `.bashrc`:

   ```bash
   source "$HOME/.keyring_init.sh"
   ```
