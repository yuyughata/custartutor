# ADR 0002: Guardian session, child mode and grown-up elevation

Status: accepted (M0)

## Context

Children have no accounts (data minimisation under the Nigeria Data Protection Act 2023). A guardian's authenticated
session owns child profiles on a shared device. A child using a parent's phone therefore holds a real guardian JWT.
A client-side-only PIN would protect nothing that matters: with that JWT a child could read transcripts, export or
delete data, or invite a stranger as a tutor. A 4-6 digit PIN has at most 10^6 values and is brute-forceable offline
if its hash is stored or synced anywhere a client can read.

## Decision

- **Child mode is the default** state of the learner app. Learning data flows normally.
- **Grown-up actions** (read tutor transcripts, export or delete data, create invites, remove members, change the PIN,
  billing) require a short-lived **elevation**: `elevate_grownup(device_id, pin)` verifies the PIN **server-side**
  against a bcrypt hash that no client policy can read, with failure counting and exponential lockout. On success
  it writes `grownup_elevations` (about 10 minutes). RLS and RPCs for those actions check
  `private.has_grownup_elevation()`.
- Offline, the PIN gate is a UI-only check against a salted hash with a device-bound pepper in the Keystore. This
  is acceptable because offline there is no server-side data to expose beyond the local cache, and the local cache
  holds no transcripts.
- **Helper mode** (the human teaching assistant) runs in child mode under the guardian session and gets no
  grown-up capability. Helper scripts ship in the grown-up pack.
- **Tutors** are separate authenticated users granted access **per child** (`child_access`), revocable. Invites are
  single-use, hashed, expiring tokens accepted through a `SECURITY DEFINER` RPC. There is no self-join path.
- **Admins** need TOTP; every admin policy and RPC requires `aal2`. `support` and `analyst` roles never see
  household or child rows (analysts get aggregate views, support gets guardian-granted time-boxed access later).
- Offline authorisation is by device: a cached household snapshot with a server-anchored `last_verified`, a
  monotonic max-seen-time check against clock rollback, and a bounded grace window (30 days, tunable). An expired
  JWT blocks sync only, never playback.

## Consequences

More server round trips for sensitive actions, and the grown-up area needs connectivity for the sensitive
subset. In exchange the PIN protects real data, and a compromised child device cannot escalate.
