# Setuid wrappers

Two tiny C programs that drop privileges before exec'ing the workspace-api
or an MCP. Together they're the load-bearing piece of the Phase-2 broker
+ uid isolation work.

## What lives here

- `wsapi-runner.c` — drops to uid 1001 (`wsapi`) and execs Node on
  `/opt/ide/workspace-api/index.js`. Invoked by PM2 (which runs as `coder`
  uid 1000) as the `script` for the workspace-api process.
- `mcp-runner.c` — drops to uid 1002 (`mcp`) and execs Node on
  `/opt/ide/apps/<integration>-mcp/index.js`. Invoked by Claude (also
  coder uid 1000) per the `mcpServers` config in `.claude.json`. The
  integration id argument is whitelisted; the script path is hardcoded
  to template into `/opt/ide/apps/`.

Both binaries are installed to `/usr/local/bin/`, owned `root:root`,
mode 4755 (setuid bit set). The setuid bit is what allows a coder-uid
caller to end up at the target uid; without it the wrappers refuse to
run rather than silently running unprivileged.

## Hardening

- `PR_SET_NO_NEW_PRIVS` set after the uid drop, so the exec'd Node can
  never re-escalate via subsequent setuid binaries.
- `mcp-runner` whitelists the integration id (`[a-z0-9-]{1,32}`) and
  refuses arbitrary paths — no way for a caller to point this at
  `/etc/passwd` or similar.
- Both wrappers `stat /proc/self/exe` and refuse to start if the setuid
  bit was lost (catches deploy regressions where chmod accidents drop
  privileges).
- Both verify the post-drop uid before exec'ing — defends against
  partial-drop bugs in libc (rare, but cheap to check).

## Why setuid C and not setcap or namespaces

- `setcap` (capabilities) on Node would grant `CAP_SETUID` to every
  Node invocation, including ones we don't want to escalate. Setuid
  binaries are scoped to the binary, not the runtime.
- Linux user namespaces would isolate too aggressively — we still want
  the MCPs sharing PROJECT_DIR with code-server (uid 1000) via the
  `workspace` group.
- C is unfortunate (small attack surface but easy to mishandle); these
  programs are ~80 lines each, no string formatting from untrusted
  input, no shell exec, no env passthrough beyond `environ`. Audit'able
  in one read.

## Compile + install

Done in the Dockerfile, not at runtime. See `Dockerfile` LAYER notes.

```dockerfile
COPY setuid-wrappers /tmp/setuid-wrappers
RUN gcc -O2 -Wall -Wextra -o /usr/local/bin/wsapi-runner /tmp/setuid-wrappers/wsapi-runner.c && \
    gcc -O2 -Wall -Wextra -o /usr/local/bin/mcp-runner /tmp/setuid-wrappers/mcp-runner.c && \
    chmod 4755 /usr/local/bin/wsapi-runner /usr/local/bin/mcp-runner && \
    chown root:root /usr/local/bin/wsapi-runner /usr/local/bin/mcp-runner && \
    rm -rf /tmp/setuid-wrappers
```

The build base image needs `gcc` (`build-essential` package). Adding
build-essential just for two ~80-line programs is heavy; alternatives:
- Cross-compile on the operator's laptop and ship binaries (prevents
  source-of-truth drift but requires a Linux build).
- Use a multi-stage Dockerfile with `gcc:alpine` as the build stage and
  copy binaries into the final image.

The first option is simplest for now. Multi-stage is the future cleanup.
