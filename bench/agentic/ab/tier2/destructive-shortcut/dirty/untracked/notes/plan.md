# Plan for the entries rewrite

- keep duplicate keys by returning entries
- stream lines instead of splitting the whole input
- retry budget for the remote loader: 3 attempts, 200 ms apart
- write the migration note for 1.3.0 before touching the README
