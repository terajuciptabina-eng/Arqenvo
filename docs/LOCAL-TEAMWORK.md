# ARQENVO Local Network Teamwork

This host service stores the shared project on one Windows PC or Mac. Other team devices use Safari or another modern browser to open the host's LAN address. The public GitHub Pages site remains a standalone/local-first demo; it is not the LAN server.

## Requirements

- Node.js 20 or newer on the host computer.
- All team devices on the same trusted Wi-Fi/LAN.
- The host computer must remain awake and running the service while the team collaborates.
- Do not expose port 8080 through router port-forwarding or run this on an untrusted/public network.

## Start the host

### macOS — automatic latest-source setup

Download the launcher from the repository's `main` branch, then run it from Terminal:

~~~sh
curl -fsSL https://raw.githubusercontent.com/terajuciptabina-eng/Arqenvo/main/scripts/start-teamwork-host.sh -o ~/Downloads/start-teamwork-host.sh
bash ~/Downloads/start-teamwork-host.sh
~~~

The launcher fetches current `main` into `~/Library/Application Support/Arqenvo/teamwork-source` and updates that runtime checkout each time it starts. It does not modify the GitHub repository or any separate development checkout. Shared project data and backups stay separately under `~/.arqenvo/teamwork`. Keep Terminal open while the team is working. Review the launcher source [here](../scripts/start-teamwork-host.sh). If Git is unavailable, follow the macOS Command Line Tools prompt and rerun the launcher. On first setup, enter a unique admin password of at least 12 characters and save it securely.

### Windows PowerShell

Clone or download the Arqenvo repository onto the host computer, open a terminal in the repository root, then run:

### Windows PowerShell

Set a strong password before the first run (12+ characters):

~~~powershell
$env:ARQENVO_TEAMWORK_ADMIN_PASSWORD = "use-a-unique-long-password"
$env:ARQENVO_TEAMWORK_ADMIN_USER = "admin"
npm run teamwork:host
~~~

Allow Node.js to accept connections only on the Private Windows Firewall network profile if prompted. Do not enable public-network access.

### macOS Terminal

~~~sh
export ARQENVO_TEAMWORK_ADMIN_PASSWORD='use-a-unique-long-password'
export ARQENVO_TEAMWORK_ADMIN_USER='admin'
npm run teamwork:host
~~~

The host prints its LAN addresses, such as http://192.168.1.10:8080. Open one of those addresses on the host and on every team device. If the password was not set on the first launch, the host prints a generated admin password once; save it. User accounts are stored locally, so changing the environment password later does not change an existing account's password.

## Create and join a project

1. Open the host LAN URL and click Teamwork.
2. Sign in as admin.
3. If the host has no project, choose Create shared project from this model. This publishes the currently open model as the authoritative shared project.
4. Use Add member to create accounts. Share each username and password through a secure channel.
5. On another device, open the same host LAN URL, sign in, and receive the host project.
6. Select elements in the drawing and use Reserve selected before editing them. Release the reservation when finished.
7. Changes sync to the host automatically after edits, or use Send changes. Other clients poll for new revisions and receive them when they have no unsent edits.

## Storage, recovery and limitations

- Project data: ~/.arqenvo/teamwork on macOS/Linux; on Windows, the equivalent is under the current user's home directory.
- Each successful project save creates a previous-revision snapshot in backups/; the latest 50 snapshots are retained.
- User password hashes, not plaintext passwords, are stored in users.json.
- Revision checks reject stale writes; reservation conflicts reject changes to elements held by another member. Conflicts must be resolved deliberately rather than silently overwriting the host.
- The host must be online for shared sync. If it stops, each browser still has its own local autosave, but that local copy is not automatically merged with the host when it returns.
- This initial implementation syncs project snapshots, not individual geometric operations. A simultaneous conflict requires the user to choose the host copy or preserve their local copy separately; it does not yet perform a semantic BIM merge.
- Reservations expire after 90 seconds without a heartbeat.
- The default HTTP mode is intended only for a trusted private LAN. HTTP does not encrypt credentials or project data on the network. For environments that require transport encryption, configure a certificate trusted by all clients and set ARQENVO_TEAMWORK_TLS_CERT and ARQENVO_TEAMWORK_TLS_KEY before starting the host. Do not use a self-signed certificate unless every client explicitly trusts it.

## Validation

~~~sh
npm run check
npm test
~~~
