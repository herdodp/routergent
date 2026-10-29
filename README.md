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

**Satu aplikasi. Banyak akun. Satu percakapan tak terputus.**

</div>

---

## ▌ `SYS.OVERVIEW`

**RouterGent** adalah router standalone untuk *snapgent connector*. Aplikasi Electron ini menjalankan banyak akun AI sekaligus, memilih node yang siap, dan memindahkan pekerjaan ke node lain secara otomatis saat sebuah node gagal, tanpa mengulang dari awal.

| Modul | Lokasi | Fungsi |
| :-- | :-- | :-- |
| 🧭 **Router** | `src/main/router.js` | Memilih node webview (acak atau dipin), failover otomatis, dan menulis handoff `.txt` agar node pengganti melanjutkan pekerjaan. |
| 🔌 **Bridge** | `src/main/mcp-hub.js` | Port Node dari sisi MCP di `bridge.py`. Satu hub dipakai bersama semua node, jadi otomatis ikut bertambah saat node ditambah. |
| 🖥️ **Node Webview** | `src/renderer` | Satu `<webview>` per akun. Tiap node punya partisi login sendiri (`persist:rg-<node-id>`). |
| 🤖 **Driver** | `src/driver/node-driver.js` | Disuntikkan ke tiap webview setelah content script snapgent. Menerima prompt dari router, menekan Start bila perlu, mengirim prompt lewat `ZSProvider`, merekam progres, lalu melapor selesai atau gagal. |

---

## ▌ `SYS.ARCHITECTURE`

~~~text
                    ┌──────────────────────┐
                    │     PROMPT INDUK     │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │       ROUTER         │  ◄── mode AUTO / PIN
                    │  select · failover   │
                    │  handoff · history   │
                    └───┬──────┬───────┬───┘
                        │      │       │
              ┌─────────▼┐  ┌──▼──────┐ ┌▼─────────┐
              │ NODE  01 │  │ NODE 02 │ │ NODE  N  │   webview + driver
              │ persist: │  │ persist:│ │ persist: │   partisi login terpisah
              │ rg-<id>  │  │ rg-<id> │ │ rg-<id>  │
              └─────┬────┘  └────┬────┘ └────┬─────┘
                    └────────────┼───────────┘
                                 │
                    ┌────────────▼────────────┐
                    │        MCP HUB          │   satu hub, dipakai semua node
                    │   (vscode, dst.)        │
                    └─────────────────────────┘
~~~

---

## ▌ `SYS.BOOT`

~~~bash
cd routergent
npm install
npm start
~~~

### Variabel lingkungan (opsional)

| Variabel | Fungsi | Default |
| :-- | :-- | :-- |
| `ROUTERGENT_EXTENSION_DIR` | Lokasi folder `snapgent-extension` | `../snapgent-extension` |
| `ROUTERGENT_CONFIG` | Lokasi `config.json` berisi `mcpServers` | — |
| `ROUTERGENT_MCP` | Id server MCP yang dimuat, dipisah koma | `vscode` |

---

## ▌ `SYS.FLOW`

```
[1] + Node  ──►  [2] Start agent  ──►  [3] Prompt induk  ──►  [4] Panel percakapan  ──►  [5] Failover
```

1. Klik **+ Node**, pilih provider, login di webview.
2. Klik **Start agent** pada node tersebut. Ulangi untuk akun atau provider lain.
3. Ketik di prompt induk. Mode **Auto** memilih node siap secara acak, atau pin ke satu node.
4. Prompt Anda, balasan node, dan hasil tool tampil di panel percakapan di atas kolom input. Setelah failover, panel tetap menampilkan satu percakapan utuh dengan label node yang menjawab.
5. Jika node yang bekerja gagal (kuota habis, error, macet), router pindah ke node lain dan mengirim ringkasan handoff.

---

## ▌ `SYS.BUILD`

Buat file portable Windows:

~~~bash
npm run dist
~~~

Hasilnya ada di `dist/RouterGent 0.1.0.exe`.

- Build menyertakan `snapgent-extension` dan `vscode_mcp.exe` sebagai `extraResources`. Konfigurasi `package.json` mengambilnya dari `../snapgent-extension` dan `../vscode_mcp.exe`, jadi kedua item itu harus ada di folder induk `routergent` saat build.
- `config.json` tidak disertakan otomatis ke dalam build.
- Jika muncul error symlink `winCodeSign` di Windows, aktifkan Developer Mode, jalankan terminal sebagai Administrator, atau ekstrak arsip `winCodeSign` ke folder cache electron-builder secara manual.

---

## ▌ `SYS.TEST`

~~~bash
npm test
~~~

Tes saat ini mencakup `router.js` (pemilihan node, failover, handoff, riwayat) dan `mcp-hub.js` (pemuatan config dan override). Driver dan integrasi webview belum punya tes otomatis.

---

## ▌ `SYS.WARNINGS`

> ⚠️ Proyek ini masih eksperimental. Batasan yang diketahui:

- **Driver belum diuji di webview sungguhan.** Selector dan deteksi gagal/selesai bergantung pada DOM tiap provider dan perlu diuji per provider.
- **Content script `world: "MAIN"`** (ChatGPT `chatgpt-cm.js`, Qwen `qwen-net.js`) di manifest berjalan pada `document_start`, sedangkan RouterGent menyuntikkannya saat `dom-ready`. Provider tersebut bisa terpengaruh.
- **Webview tersembunyi.** Node yang tidak dipilih disembunyikan oleh UI. Extension snapgent memarkir loop agent saat `document.hidden` bernilai true, jadi `webview-preload.js` memaksa halaman melaporkan dirinya selalu terlihat supaya node latar belakang tetap bekerja. Perlu diverifikasi di webview sungguhan.
- **Chat yang sudah berisi percakapan.** Extension menampilkan "No agent. Open a new chat." dan tidak menawarkan Start. Driver menganggap ini gagal start sehingga router pindah ke node lain. Buka chat baru di node tersebut sebelum menekan Start agent.
- **Server MCP** belum bisa ditambah atau dihapus dari UI; ubah `config.json`.

---

## ▌ `SYS.STRUCTURE`

~~~text
routergent/
├── src/
│   ├── driver/      node-driver.js
│   ├── main/        main.js · router.js · mcp-hub.js
│   ├── preload/     app-preload.js · webview-preload.js
│   └── renderer/    index.html · renderer.js
├── test/            router.test.js · mcp-hub.test.js
└── package.json
~~~

---

<div align="center">

`> END OF TRANSMISSION`

Lisensi: **GPL-3.0-or-later**

</div>
