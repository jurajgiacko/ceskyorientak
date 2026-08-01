# blender-mcp setup

Optional interactive add-on. It lets Claude Code drive a **running Blender GUI**
session over a socket — useful for exploratory modelling and inspection.

It is **not** how this project's assets are built. The authoritative,
reproducible pipeline is the headless one in [`tools/blender/`](../tools/blender/README.md),
which is committed as code and needs no GUI and no MCP server. Treat
blender-mcp as a scratchpad; anything worth keeping should end up as a script
under `tools/blender/assets/`.

## What is already done

| Step | State |
|---|---|
| `uv` / `uvx` installed | done — `~/.local/bin/uvx`, v0.12.1 (`~/.local/bin` is already on `PATH` via `~/.zshrc`) |
| `blender-mcp` package resolves | verified — PyPI v1.6.5, console script `blender-mcp` → `blender_mcp.server:main` |
| Add-on downloaded | done — [`tools/blender/blender-mcp/addon.py`](../tools/blender/blender-mcp/addon.py) (from `ahujasid/blender-mcp@main`) |
| MCP server registered | done — [`.mcp.json`](../.mcp.json) in the project root |
| Blender installed | done — `/Applications/Blender.app` (4.5.12 LTS) |

`.mcp.json` contains exactly what the upstream README specifies:

```json
{
  "mcpServers": {
    "blender": {
      "command": "uvx",
      "args": ["blender-mcp"]
    }
  }
}
```

## Remaining manual steps (GUI — you must do these yourself)

These cannot be automated: they require the Blender user interface.

1. **Open Blender** (`/Applications/Blender.app`, or from Launchpad).

2. **Install the add-on**
   - `Edit ▸ Preferences… ▸ Add-ons`
   - Click the **▾ dropdown in the top-right of the Add-ons panel** and choose
     **Install from Disk…** (in Blender 4.2+ this moved out of the old
     `Install…` button).
   - Select:
     ```
     /Users/jurajgiacko/Projects/ceskyorientak/tools/blender/blender-mcp/addon.py
     ```

3. **Enable it** — tick the checkbox next to **Interface: Blender MCP**.

4. *(Recommended)* Expand the add-on's preferences and check the
   **Allow Telemetry** setting. It defaults to **off**; with it on, the add-on
   uploads prompts, code snippets and viewport screenshots to its authors.
   Leaving it off is the private choice.

5. **Open the side panel in the 3D viewport**
   - Hover over the 3D viewport and press **`N`** (or `View ▸ Sidebar`).
   - Select the **BlenderMCP** tab down the right-hand edge.

6. **Click “Connect to MCP server”** in that panel.
   The add-on starts a listener on `localhost:9876` and the button changes to
   “Disconnect from MCP server”. Leave Blender open — the connection only lives
   as long as this Blender session does.

7. **Restart Claude Code.** MCP servers are read at startup, so the `blender`
   tools will not appear in the current session no matter what you do in
   Blender. After restarting, approve the new server when prompted (project
   `.mcp.json` servers require approval on first use).

## Verifying it works

After restarting Claude Code with Blender open and connected, ask for something
that requires the live session, e.g. *"use the blender MCP to list the objects
in the current scene"*. If the tools are missing, check in order:

| Symptom | Cause |
|---|---|
| No `blender` tools at all | Claude Code was not restarted, or the project `.mcp.json` server was not approved |
| Tools present, calls time out | Blender is not running, or “Connect to MCP server” was not clicked |
| `uvx: command not found` in MCP logs | The launching process lacks `~/.local/bin` on `PATH` — replace `"command": "uvx"` in `.mcp.json` with the absolute path `/Users/jurajgiacko/.local/bin/uvx` |
| Port already in use | A previous Blender session still holds `localhost:9876`; quit it |

Run `claude mcp list` (or `/mcp` in an interactive session) to see the server's
connection state.

## Notes and caveats

- **One Blender at a time.** The add-on binds a fixed port (`9876`); a second
  Blender instance will fail to start its server.
- **Version skew.** The add-on's own `bl_info` version is `1.2` while the PyPI
  server is `1.6.5`. They are released from the same repo but versioned
  separately. If tools start erroring after an upstream update, re-download
  `addon.py` from `main` and re-install it:
  ```sh
  curl -fsSL -o tools/blender/blender-mcp/addon.py \
    https://raw.githubusercontent.com/ahujasid/blender-mcp/main/addon.py
  ```
- **Third-party asset services.** The panel exposes Poly Haven, Sketchfab,
  Hyper3D Rodin and Tencent Hunyuan3D integrations. They are all opt-in and all
  require API keys. None of them are needed for this project, and assets pulled
  from them would carry licence obligations the headless pipeline does not —
  leave them off unless you have a specific reason.
- **`uvx` downloads on first run.** The very first `uvx blender-mcp` resolves
  and caches ~37 packages; expect a few seconds of delay before the server is
  responsive.
