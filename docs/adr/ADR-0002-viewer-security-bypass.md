# ADR-0002: Viewer Security Bypass for Local Development

## Status

Accepted

## Context

### Upstream Behavior (agentmemory v0.9.25)

Commit `f40631e` ("fix(viewer): allow non-loopback bind via AGENTMEMORY_VIEWER_HOST") introduced a security gate in `src/viewer/server.ts`: when the viewer host (set via `AGENTMEMORY_VIEWER_HOST`) is not a loopback address, the server enforces **two** requirements before starting:

1. **`AGENTMEMORY_SECRET` must be set** — used for `Authorization: Bearer` token validation on every `/agentmemory/*` request proxied through the viewer (timing-safe compare via `src/auth.ts`).
2. **`VIEWER_ALLOWED_HOSTS` must have at least one entry** — explicit Host header allowlist to prevent DNS rebinding attacks when the listening socket is reachable from the network.

The relevant code block (lines 217–229 of `src/viewer/server.ts`):

```typescript
if (!isLoopbackHost(host)) {
  if (!secret) {
    throw new ViewerConfigError(
      `AGENTMEMORY_VIEWER_HOST=${host} requires AGENTMEMORY_SECRET ...`,
    );
  }
  if (readAllowedHostsOverride().length === 0) {
    throw new ViewerConfigError(
      `AGENTMEMORY_VIEWER_HOST=${host} requires VIEWER_ALLOWED_HOSTS ...`,
    );
  }
  inboundSecret = secret;
}
```

When `inboundSecret` is non-null, the request handler also validates every inbound request against the bearer token (lines 301–311):

```typescript
if (
  inboundSecret !== null &&
  !requireInboundBearer(req.headers.authorization, inboundSecret)
) {
  res.writeHead(401, { ... });
  res.end("unauthorized");
  return;
}
```

### KodeHold Deployment Context

KodeHold runs agentmemory in a **single-user local development environment** on a trusted network (typically a LAN or VPN). The viewer is accessed from:

- The local machine (loopback)
- Other devices on the local network (e.g., `192.168.1.x`)
- A reverse proxy or DNS name on the trusted network

The upstream security checks are designed for **multi-tenant deployments** (e.g., Fly.io, public cloud) where the viewer's bearer-authorized proxy could be reached by untrusted clients. In KodeHold's environment, these checks add configuration friction:

- Setting `AGENTMEMORY_SECRET` requires generating, storing, and providing a secret token on every viewer access
- The built-in viewer's unlock dialog (requiring the bearer token) adds a UX step for every session
- Neither adds meaningful security when the network is already trusted

### Relationship to ADR-0001

This ADR is **separate from and complementary to** ADR-0001 (Loopback Relaxation). ADR-0001 makes `0.0.0.0` semantically equivalent to `127.0.0.1` for the purposes of loopback detection, which would not bypass the security gate — the security check specifically applies to non-loopback binds. This ADR bypasses the security check **entirely** for all non-loopback binds, regardless of whether `0.0.0.0` is treated as loopback.

Both are applied independently; neither depends on the other.

## Decision

We **replace the conditional guard** with a no-op `if (false)` to disable the non-loopback security gate:

**Change applied (compiled dist):**

```diff
- if (!isLoopbackHost(host)) {
+ if (false) {
```

This means:

1. The viewer starts successfully with `AGENTMEMORY_VIEWER_HOST` set to any address, including `0.0.0.0` (all interfaces), without requiring `AGENTMEMORY_SECRET`.
2. `inboundSecret` remains `null`, so the per-request bearer token check is also skipped.
3. **`VIEWER_ALLOWED_HOSTS` is NOT bypassed** — the Host header allowlist (lines 245–249 of `server.ts`) remains active and is evaluated on every request. This provides basic Host header filtering as a defense-in-depth measure.
4. The change is applied to the **compiled dist files** (`dist/index.mjs` and `dist/src-fQOMXeCp.mjs`) via a patch file at `patches/agentmemory-viewer-bind-0.9.25.patch` in the KodeHold repository.

### Patch Mechanism

The patch is maintained as:

```bash
# patches/agentmemory-viewer-bind-0.9.25.patch
# Applied to: /usr/local/lib/node_modules/@agentmemory/agentmemory/dist/
sudo patch -p1 -d /usr/local/lib/node_modules/@agentmemory/agentmemory/dist \
  < patches/agentmemory-viewer-bind-0.9.25.patch
```

**Limitation:** The patch targets compiled JavaScript in `node_modules`. On `npm update` or reinstall of agentmemory, the patch must be reapplied. There is no automated reapplication — the operator must reapply manually after upgrades.

## Consequences

### Positive

1. **Reduced configuration burden** — No need to generate, store, and present `AGENTMEMORY_SECRET` for local development.
2. **Simplified viewer access** — No bearer token unlock dialog on first viewer load.
3. **Host header filtering preserved** — `VIEWER_ALLOWED_HOSTS` still provides basic protection against unexpected Host headers (e.g., DNS rebinding from within the trusted network).
4. **Transparent user experience** — Same behavior as the loopback-only viewer but accessible from other devices on the network.

### Negative

1. **No bearer auth** — Any client that can reach the viewer port can proxy requests to the local REST API. In a multi-user or untrusted network, this would be a vulnerability. For KodeHold's single-user trusted-network deployment, this risk is accepted.
2. **Patch fragility** — The change is applied to compiled dist files, not source. Every agentmemory version upgrade requires manual reapplication. If the upstream source changes the code path structure, the patch may fail to apply cleanly and require updating.
3. **Divergence from upstream** — KodeHold now runs a modified version of agentmemory's viewer server. Troubleshooting viewer issues requires awareness that the security path has been altered.
4. **Not upstreamable** — This change is specific to KodeHold's deployment model and should not be contributed upstream, where the security gate is the correct default.

### Risk Assessment

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| Network attacker proxies through viewer | Low (trusted LAN) | High (full REST API access) | `VIEWER_ALLOWED_HOSTS` still constrains Host headers; network segmentation limits exposure |
| Patch breaks on upgrade | Medium | Medium | Patch file is versioned in `patches/`; upgrade notes remind operator to reapply |
| Patch silently fails to apply | Low | Low | Operator verifies with `grep -n 'if (false)' dist/index.mjs` | 
