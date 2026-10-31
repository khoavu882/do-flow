# ratelimit

A small in-process rate limiter. Each key (a user id, an IP address) has its own
token bucket: it holds up to `capacity` tokens and gains `refillPerSec` tokens every
second.

The limiter is being written; see `lib/` for what exists so far.
