# Ddraw — Collaborative Canvas

A high-performance, real-time multiplayer drawing application. Designed for seamless collaboration, ddraw combines a custom-built low-level drawing engine with modern reactive UI.

![Svelte 5](https://img.shields.io/badge/Svelte-5-ff3e00)
![Rust/WASM](https://img.shields.io/badge/Rust-WASM-black)
![WebSockets](https://img.shields.io/badge/WebSockets-Protobuf-blue)
![Vite](https://img.shields.io/badge/Vite-5.0-646CFF)
![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB)

##  Core Features

- ** Real-time Low Latency** - Collaborative drawing powered by WebSockets and Binary Protocol Buffer Compression.
- ** Professional Ink Engine** - Smooth, pressure-sensitive calligraphic strokes via the `perfect-freehand` library.
- ** Specialized Tools**
  - **Brush & Flow Pen:** Customizable stamping and smoothing.
  - **Ink Tool:** Tapered, high-quality vector-like strokes.
  - **Selection + Homography:** Perspective transformations using Delaunay triangulation.
  - **Shape Tools:** Rectangles, circles, and straight lines.
  - **Image Brushes:** Support for GIMP brushes (.gbr/.gih) and standard image formats.
- ** Multi-Layer Support** - Photoshop-style layering with real-time blending modes.
- ** Direct Messaging** - A dedicated E2EE-ready messenger service for private 1-1 communication.
- ** Time Machine** - Replay engine to view drawing history.
- ** WASM Acceleration** - Rust modules for computationally expensive operations like Stackblur and brush hardness ramps.
- ** Native Desktop App** - Windows support via Tauri 2.0 with a custom system tray and optimized performance.

## Technical Architecture

### Drawing Engine (Vanilla JS)
The core canvas logic is decoupled from the UI framework for maximum performance. It uses a custom **TileGrid** system to track dirty regions, minimizing compositing overhead during large-scale collaborative sessions.

### UI & State (Svelte 5)
Modern Svelte 5 `$state` runes manage the global application state, providing reactive and efficient UI updates for overlays, settings, and the messenger system.

### Real-time Sync
A robust sync coordinator handles late-joiners by electing an existing user as a "provider," transferring the current canvas state while buffering incoming drawing events to prevent state divergence.

### Performance Stack
- **Rust/WebAssembly:** Handles pixel-level manipulations (blurs, hardness masks) at near-native speeds.
- **Protocol Buffers:** Binary message serialization for minimal network overhead.
- **Dirty Rect Tracking:** Avoids re-rendering the entire canvas by only updating changed tiles.
- **Tauri Core:** Provides a lightweight, secure native wrapper for the desktop application.

## Getting Started

### Prerequisites

- **Node.js** >= 18.0.0
- **MongoDB** (Local or Atlas)
- **Rust & wasm-pack** (To build the image processing modules and Tauri app)

### Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Build WASM Modules**
   ```bash
   npm run wasm
   ```

3. **Environment Variables**
   Create a `.env` file or use the defaults provided in the app.
   ```env
   VITE_WS_SERVER_URL=ws://localhost:8000
   MONGODB_URI=mongodb://127.0.0.1:27017
   PORT=8000
   ```

4. **Start Web Development**
   ```bash
   # Starts frontend, WebSocket server, and Messenger service
   npm run dev
   ```

## Desktop Application (Tauri)

Ddraw can be run as a native Windows application using Tauri 2.0.

### Development Mode
To launch the desktop app in development mode (includes hot-reloading and web devtools):
```bash
npm run tauri:dev
```

### Building the Installer
To generate a production-ready Windows installer (`.msi` or `.exe`):
```bash
npm run tauri:build
```
The resulting installers will be located in `src-tauri/target/release/bundle/`.

> **Note:** The production build uses the configuration in `.env.production` to connect to your hosted backend (e.g., Koyeb).

## Project Structure

- `src/canvas/` - The core drawing engine and TileGrid system.
- `src/tools/` - Implementation of various drawing tools.
- `src/sync/` - Client-side synchronization and event buffering.
- `src/messenger/` - Svelte components for the direct messaging UI.
- `wasm_src/` - Rust source code for WASM image processing.
- `src-tauri/` - Rust source code and configuration for the desktop app.
- `server/` - Node.js servers (WebSocket, Auth, Messenger).
- `public/` - Static assets and ProtoBuf definitions.

## Scripts

| Command | Action |
|---------|--------|
| `npm run dev` | Run development environment (Concurrent Vite + Server) |
| `npm run build` | Build for production |
| `npm run wasm` | Rebuild Rust/WASM modules |
| `npm run tauri:dev` | Start the native desktop app in development mode |
| `npm run tauri:build` | Build the standalone Windows installer |
| `npm run server` | Start only the primary WebSocket/Room server |
| `npm run messenger` | Start the Direct Messaging service |

## License

Distributed under the MIT License. See `LICENSE` for more information.
