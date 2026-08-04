# How a body that belongs to somebody else is placed

Everything in this file is about ONE question: at this instant, where do we draw a
thing the local player does not control? It is deliberately separate from the frame
cost model, because none of it is about how long a frame takes. A client holding a
locked 60 can still draw an opponent as a sewing machine, and a client at 6fps can
draw one gliding.

## The three eras

**1. Frozen.** Every remote body was drawn at its last snapshot position, full stop.
Between snapshots it did not move at all; on each snapshot it teleported the whole
32ms of travel. `scripts/test-motion-continuity.mjs` was written for this and named
the statistic CARRY: how far the render target advances over one snapshot interval,
divided by how far the body really travels in one. Frozen scores 0.00. Measured
0.16m per snapshot at a bot's walking speed — 57 pixels at the range he was walking.

**2. Dead-reckoned, from when the packet landed.** Carry went to 1.00 and the
sewing machine went away. What replaced it was the CORRECTION. The arithmetic was

    p(t) = p_snapshot + v_snapshot × (t − whenThatPacketLANDED)

which is a ray anchored on ARRIVAL. Two things then step the drawn position every
time a snapshot lands:

* the second-order error — the body turned or accelerated, so the ray was never
  going to end where the next sample says it is; and, much larger,
* the ARRIVAL JITTER — a snapshot that comes 60ms after its predecessor instead of
  32ms leaves the ray extrapolated 28ms of travel past one interval of real motion,
  and the new sample yanks it back inside one frame.

Carry reads 1.00 through all of it, which is why this era survived a suite that was
written to catch the previous one.

**3. Interpolated, on the server's timeline.** `src/client/network/RemoteInterpolation.ts`.
Samples are stamped with the SERVER time they describe and kept in a 24-deep ring
per body; the renderer asks for a position at a render time on that same timeline
and gets it from the two samples that bracket it. Nothing in the answer is a
function of when a packet landed, so arrival jitter cannot move a body — it can
only change how much history is available, and there is a delay held in hand for
exactly that.

## The pieces

**The clock is servoed, not set.** Estimating "what server time is it now" from
arrivals is jittery, and using that estimate directly would put the jitter back.
Instead a local clock is advanced by real elapsed time and its RATE is dilated
within ±12% toward `newest − delay`. Render time is therefore continuous and
monotonic by construction, and every drawn position inherits both properties. Only
a disagreement past `HARD_SNAP_S` re-anchors it, which should mean a join or a
reconnect and nothing else.

**The clock is clamped to `newest + MAX_EXTRAPOLATION_S`.** A frame on the target
machine can run for over a second, and no snapshot can be applied inside a
synchronous frame — the message callback cannot run. A free-running clock therefore
outruns its data by the whole length of the stall, and the next advance saw an error
past the hard-snap threshold and re-anchored BACKWARDS. Measured 15 times in a 60s
window before the clamp; every one of those was every remote body in the world
teleporting at once. Parking the clock a bounded distance past its newest sample
costs nothing — nothing is being drawn during the stall — and leaves the hard snap
to do its one real job.

**The delay adapts.** It starts at 1.5 snapshot intervals and tracks
`1.5 × interval + 2.5 × jitter`, both measured, bounded to [1, 6] intervals, and
slewed rather than stepped. A clean wire pays ~52ms; a 60ms-jitter wire widens the
window instead of starving.

**History takes EVERY hot snapshot.** `NetworkClient` coalesces hots to one per
animation frame before they are applied, which is right for a merge — four
superseded merges are four wasted ones — and wrong for a history. At 180ms a frame,
which is what the target machine does, four of every five samples never existed as
far as the buffer was concerned, and it measured the CLIENT's frame rate as the
SERVER's snapshot rate: a 178ms interval against a real 32ms, inflating the render
delay six-fold. `onHotHistory` fires on arrival, before the coalescing, and costs
six float writes per body.

**A pirate aboard a ship is buffered in the SHIP's frame.** Interpolating his world
position and then drawing him against the hull on the screen would slide him along
the planking by the hull's own travel over the delay — half a metre on a ship under
sail, and a straight regression of the deck weld. What has to be continuous is where
he is STANDING, so that is what the ring holds; `Game.getPlayerRenderPosition`
composes it back against `readShipRenderPose`, the same composition the weld already
relied on. The frame id travels with each sample and the ring refuses to interpolate
across a change of frame, so a boarding is never lerped through.

**Sharks need no velocity.** `HotSharkState` is id/position/rotation/health/
attackState/attackTimer — there is no velocity field, which is why nothing could
carry a shark between snapshots and why they staircased worst of anything in the
game. Two bracketing samples ARE the server's own velocity, so the fix costs the
wire nothing.

## What is NOT interpolated, and why

* **The local player.** His motion, his aim and his one-shot actions are predicted.
  Adding a delay to any of them would be adding latency to the only thing in the
  game the player feels directly. He keeps the dead-reckoning branch.
* **Cannon flight.** A ballistic arc from a real velocity is not a guess; it is the
  same closed form the server integrates. It is drawn as such.
* **Shots in flight.** Same argument, and they are the fastest thing on the screen.

## The instruments

`scripts/test-remote-interpolation.mjs` — the bench. Pure arithmetic, milliseconds
to run, on a packet stream whose jitter is CHOSEN. Grades the buffer against a model
of era 2 fed the identical packets, and asserts that the old arithmetic FAILS the
bar the new one is held to: a gate whose bar the thing it replaced can clear is a
gate that cannot fail. Also covers the clock's monotonicity, the delay's adaptation
in both directions, the frame-change refusal, the extrapolation cap, a stuttering
frame cadence up to 900ms, and a 1.4s stalled frame.

`scripts/test-remote-smoothness.mjs` — the live reading. Reconstructs the drawn path
at ~108Hz by calling the renderer's own placement functions on a timer, so it sees a
32ms event on a rasteriser that draws at 6fps. Flips `setRemoteInterpolation` every
4.5s, so both arms are measured on the same walker, the same bot fleet and the same
wire, and asserts that the OFF arm fails.

Its metric is VELOCITY CONTINUITY and nothing else:

    unexplained = | step_i − (step_{i−1} / dt_{i−1}) × dt_i |

how far the body moved beyond carrying on at the speed it had. It is deliberately
not graded against the entity's `velocity` field: sharks have none, and a buffered
body is drawn where it was a delay ago, so differencing it against the velocity it
has NOW charges the metric for the delay instead of for a discontinuity.

**What it will not grade, and this matters.** A body ashore is placed by the buffer
and the clock and nothing else, so its path can be sampled as fast as you like. A
body on a DECK is composed against the drawn hull, and a SWIMMER's height is pulled
onto the Gerstner surface off the ocean clock — both written once per FRAME. Sampled
at 108Hz on a 6fps rasteriser, a per-frame quantity is frozen for 170ms and then
steps, and the reading says more about SwiftShader than about anything under test.
Those populations are counted and printed, never graded.
