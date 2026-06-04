# ADR-0001: Viewer Loopback Relaxation — Treat 0.0.0.0 as Loopback

## Status

Accepted

## Context

The agentmemory viewer server (`src/viewer/server.ts`) has a function `isLoopbackHost()` that determines whether the viewer's bind address is local-only. The current implementation (v0.9.25) recognizes three values as loopback:

```typescript
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}
```

When a non-loopback host is detected, the viewer server requires both `AGENTMEMORY_SECRET` (for inbound bearer token validation) and `VIEWER_ALLOWED_HOSTS` (for Host header allowlisting) before starting. This is a security measure to prevent the viewer from becoming an open relay to the local REST API.

The address `0.0.0.0` is a meta-address that means "all IPv4 interfaces on the local machine." It is not a routable network address — packets cannot be sent _to_ `0.0.0.0` from another machine. Setting `AGENTMEMORY_VIEWER_HOST=0.0.0.0` is semantically equivalent to binding to all local interfaces, of which the loopback interface (`127.0.0.1`) is always one.

Key forces:

- **KodeHold runs in a trusted single-user environment** — the bearer auth requirement adds unnecessary operational friction for local development and self-hosted deployments.
- **Consistency with the REST API** — the agentmemory REST API already binds to `0.0.0.0` in KodeHold's configuration without requiring extra authentication for local access.
- **Non-routable semantics** — `0.0.0.0` cannot be targeted by remote clients; it only affects which local interfaces the server listens on. A process bound to `0.0.0.0` is reachable from the network, but that is true of _any_ bind address — including `127.0.0.1` if the operator has configured NAT or port forwarding. The security boundary is the Host header check, which already applies uniformly.
- **Upstream behavior unchanged** — for users who explicitly bind to a routable address (e.g., a VPC IP or public IP), the existing `AGENTMEMORY_SECRET` + `VIEWER_ALLOWED_HOSTS` requirements remain enforced. This change only relaxes the check for the well-known `0.0.0.0` wildcard address.

## Decision

Add `0.0.0.0` to the `isLoopbackHost()` function so that it returns `true` for all four values: `127.0.0.1`, `::1`, `localhost`, and now `0.0.0.0`.

The implementation change is a single-line addition to the return expression in `src/viewer/server.ts`:

```typescript
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h === "0.0.0.0";
}
```

This means:

1. `AGENTMEMORY_VIEWER_HOST=0.0.0.0` works the same as `AGENTMEMORY_VIEWER_HOST=127.0.0.1` — no bearer auth required.
2. The viewer's `buildAllowedHosts()` function will seed the Host header allowlist from CORS origins (the same loopback path) when the bind is `0.0.0.0`.
3. Non-loopback addresses (e.g., a specific network IP) still require `AGENTMEMORY_SECRET` and `VIEWER_ALLOWED_HOSTS`.

### Rationale

- **0.0.0.0 is not a routable destination** — IETF specifications (RFC 1122 §3.2.1.3) define `0.0.0.0` as "this host on this network." It cannot be used as a source or destination address for network traffic from another host.
- **Operational convenience** — users who want the viewer accessible on all interfaces (e.g., in Docker, Fly.io, or local VM setups) can use `0.0.0.0` without the ceremony of generating and configuring a secret.
- **Minimal risk** — the Host header validation in the viewer proxy (`buildAllowedHosts()` and the per-request check) still applies regardless of bind address. The auth check only gates the _startup_ of the server; the Host header check gates every _request_.

## Consequences

### Positive

- **Reduced friction** — `AGENTMEMORY_VIEWER_HOST=0.0.0.0` "just works" in single-user and containerized deployments without requiring secret management.
- **Consistent behavior** — the REST API and viewer server now have the same posture toward `0.0.0.0`.
- **Minimal diff** — a single-line change with zero new dependencies or configuration surfaces.

### Negative

- **Slightly wider default exposure in shared-host environments** — if someone runs agentmemory on a multi-tenant machine and sets `AGENTMEMORY_VIEWER_HOST=0.0.0.0`, the viewer is reachable from other processes on the same network segment without a bearer token. Mitigation: this scenario (shared host, no Docker network isolation, no secret, and the viewer bound to all interfaces) requires multiple preconditions; the Host header check still blocks spoofed requests.
- **Deviation from upstream** — this change is not in the upstream agentmemory repository. On rebase/upgrade, the modification must be re-applied or maintained as a patch.

### Neutral

- **No impact on existing configurations** — users who already set `AGENTMEMORY_SECRET` and `VIEWER_ALLOWED_HOSTS` are unaffected. Users who rely on the default `127.0.0.1` bind are unaffected.

## See Also

- [ADR-0002: Viewer Security Bypass for Local Development](ADR-0002-viewer-security-bypass.md) — Separately disables the bearer-auth security gate for non-loopback binds. Both ADRs apply independently to the same viewer code path (`src/viewer/server.ts`).
