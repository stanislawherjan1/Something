# The public demo

A build of the workspace that needs no server: every `/api/*` and `/auth/*`
call is answered in the browser from sample data, so the whole UI can be
clicked through at **something.md/demo/**. The chat shows conversations but
has no model behind it.

- `npm run dev:demo` — the demo on the Vite dev server (`/demo/`).
- `npm run build:demo` — static build into `dist-demo/`. The landing's build
  (`landing/scripts/build-demo.sh`) runs it and serves it at `/demo/`.
- A normal `npm run build` contains none of this: it is behind
  `import.meta.env.VITE_DEMO`.

| File | What |
|---|---|
| `install.js` | `fetch` and `EventSource` stand-ins, installed before the app mounts |
| `server.js` | The routes, shaped like workspace-api's; writes live for the tab only |
| `flags.js` | `IS_DEMO`, the viewer switch (founder / teammate), the deploy link |
| `ui.jsx` | The demo bar and the "chat is off" note |
| `time.js` | Dates relative to today, so the sample never goes stale |
| `data/cast.js` | Saltmarsh Ceramics and its people (all invented) |
| `data/memory.js` | Memory for each viewer, derived from one list of conversations |
| `data/workspace.js` | Files, chats, tasks, reminders, skills, integrations |

Everything in `data/` is invented and public. Keep it that way: no real
names, businesses or memory, ever.
