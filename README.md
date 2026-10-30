<div align="center">

```
██████╗  ██████╗ ██╗   ██╗████████╗███████╗██████╗  ██████╗ ███████╗███╗   ██╗████████╗
██╔══██╗██╔═══██╗██║   ██║╚══██╔══╝██╔════╝██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
██████╔╝██║   ██║██║   ██║   ██║   █████╗  ██████╔╝██║  ███╗█████╗  ██╔██╗ ██║   ██║
██╔══██╗██║   ██║██║   ██║   ██║   ██╔══╝  ██╔══██╗██║   ██║██╔══╝  ██║╚██╗██║   ██║
██║  ██║╚██████╔╝╚██████╔╝   ██║   ███████╗██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝
```

### `> MULTI-NODE AI ROUTER // AUTO-FAILOVER // SHARED HANDOFF MEMORY`

![version](https://img.shields.io/badge/version-0.1.0-00f0ff?style=for-the-badge&labelColor=0a0e1a)
![electron](https://img.shields.io/badge/Electron-33-9d4edd?style=for-the-badge&logo=electron&logoColor=white&labelColor=0a0e1a)
![platform](https://img.shields.io/badge/platform-Windows-00ff9c?style=for-the-badge&logo=windows&logoColor=white&labelColor=0a0e1a)
![license](https://img.shields.io/badge/license-GPL--3.0-ff2e97?style=for-the-badge&labelColor=0a0e1a)
![status](https://img.shields.io/badge/status-experimental-ffb800?style=for-the-badge&labelColor=0a0e1a)

**One app. Many accounts. One unbroken conversation.**

</div>

---

## ▌ `SYS.OVERVIEW`

**RouterGent** is a standalone router for the *snapgent connector*. This Electron app runs several AI accounts at once, picks a ready node for each prompt, and automatically hands the work over to another node when one fails, so the task continues instead of starting over.

| Module | Location | Purpose |
| :-- | :-- | :-- |
| 🧭 **Router** | `src/main/router.js` | Selects a webview node (random or pinned), performs automatic failover, and writes a `.txt` handoff so the replacement node continues the work. |
| 🔌 **Bridge** | `src/main/mcp-hub.js` | Node port of the MCP side of `bridge.py`. One hub is shared by all nodes, so new nodes get it automatically. |
| 🖥️ **Webview Node** | `src/renderer` | One `<webview>` per account. Each node has its own login partition (`persist:rg-<node-id>`). |
| 🤖 **Driver** | `src/driver/node-driver.js` | Injected into each webview after the snapgent content script. Receives prompts from the router, presses Start when needed, sends the prompt through `ZSProvider`, records progress, and reports done or failed. |

---

## ▌ `SYS.ARCHITECTURE`

~~~text
                    ┌──────────────────────┐
                    │    PARENT PROMPT     │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │       ROUTER         │  ◄── AUTO / PIN mode
                    │  select · failover   │
                    │  handoff · history   │
                    └───┬──────┬───────┬───┘
                        │      │       │
              ┌─────────▼┐  ┌──▼──────┐ ┌▼─────────┐
              │ NODE  01 │  │ NODE 02 │ │ NODE  N  │   webview + driver
              │ persist: │  │ persist:│ │ persist: │   separate login partitions
              │ rg-<id>  │  │ rg-<id> │ │ rg-<id>  │
              └─────┬────┘  └────┬────┘ └────┬─────┘
                    └────────────┼───────────┘
                                 │
                    ┌────────────▼────────────┐
                    │        MCP HUB          │   one hub, shared by all nodes
                    │   (vscode, etc.)        │
                    └─────────────────────────┘
~~~

---

## ▌ `SYS.BOOT`

~~~bash
cd routergent
npm install
npm start
~~~

### Environment variables (optional)

| Variable | Purpose | Default |
| :-- | :-- | :-- |
| `ROUTERGENT_EXTENSION_DIR` | Location of the `snapgent-extension` folder | `resources/snapgent-extension` |
| `ROUTERGENT_CONFIG` | Location of `config.json` containing `mcpServers` | `resources/config.json` |
| `ROUTERGENT_MCP` | Comma-separated ids of the MCP servers to load | `vscode` |

---

## ▌ `SYS.FLOW`

```
[1] + Node  ──►  [2] Start agent  ──►  [3] Parent prompt  ──►  [4] Conversation panel  ──►  [5] Failover
```

1. Click **+ Node**, choose a provider, and log in inside the webview.
2. Click **Start agent** on that node. Repeat for other accounts or providers.
3. Type in the parent prompt. **Auto** mode picks a ready node at random, or you can pin a single node.
4. Your prompt, the node replies, and tool results appear in the conversation panel above the input. After a failover the panel still shows one continuous conversation, labeled with the node that answered.
5. If the working node fails (quota exhausted, error, stuck), the router switches to another node and sends it a handoff summary.

---

## ▌ `SYS.BUILD`

Build a Windows portable executable:

~~~bash
npm run dist
~~~

The output is `dist/RouterGent 0.1.0.exe`.

- **Self-contained resources.** Everything the build needs lives in `resources/`: `snapgent-extension/`, `vscode_mcp.exe`, and a minimal `config.json` that only declares the `vscode` server. `package.json` bundles all three as `extraResources`, so nothing is read from the parent folder. To update the extension or the MCP server, replace the copies in `resources/`.
- The `vscode` command in `config.json` is always overridden at runtime with the bundled `vscode_mcp.exe`, so no absolute paths are needed.
- **Windows `winCodeSign` symlink error.** If extraction fails with "A required privilege is not held by the client", either enable Developer Mode, run the terminal as Administrator, or extract the `winCodeSign` archive manually into the electron-builder cache folder. The two macOS symlinks that fail to extract are not needed for Windows builds.

---

## ▌ `SYS.TEST`

~~~bash
npm test
~~~

Current tests cover `router.js` (node selection, failover, handoff, history) and `mcp-hub.js` (config loading and overrides). The driver and webview integration have no automated tests yet.

---

## ▌ `SYS.WARNINGS`

> ⚠️ This project is experimental. Known limitations:

- **The driver has not been tested in a real webview.** Selectors and done/failed detection depend on each provider's DOM and must be verified per provider.
- **`world: "MAIN"` content scripts** (ChatGPT `chatgpt-cm.js`, Qwen `qwen-net.js`) run at `document_start` in the manifest, while RouterGent injects them at `dom-ready`. Those providers may be affected.
- **Hidden webviews.** Nodes that are not selected are hidden by the UI. The snapgent extension parks its agent loop while `document.hidden` is true, so `webview-preload.js` forces the page to report that it is always visible to keep background nodes working. This needs verification in a real webview.
- **Chats that already contain a conversation.** The extension shows "No agent. Open a new chat." and does not offer Start. The driver treats this as a failed start, so the router moves to another node. Open a new chat on that node before pressing Start agent.
- **MCP servers** cannot be added or removed from the UI yet; edit `config.json`.

---

## ▌ `SYS.STRUCTURE`

~~~text
routergent/
├── src/
│   ├── driver/      node-driver.js
│   ├── main/        main.js · router.js · mcp-hub.js
│   ├── preload/     app-preload.js · webview-preload.js
│   └── renderer/    index.html · renderer.js
├── resources/       snapgent-extension/ · vscode_mcp.exe · config.json
├── test/            router.test.js · mcp-hub.test.js
└── package.json
~~~

---

<div align="center">

`> END OF TRANSMISSION`

License: **GPL-3.0-or-later**

</div>
