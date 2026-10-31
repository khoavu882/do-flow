# jobreport

Prints a table of build jobs from a JSON file.

```
node bin/report.js --file jobs.json
node bin/report.js --file jobs.json --verbose
node bin/report.js --file jobs.json --slower-than 5m
```

## Job file

A list of objects:

```json
[
  { "name": "build", "status": "ok", "startedAt": "2026-03-01T10:00:00Z", "durationMs": 3900000 }
]
```

## Options

| Option | Description |
| --- | --- |
| `--file <path>` | Job file to read. Default `jobs.json`. |
| `--verbose` | Add the `started` column. |
| `--slower-than <duration>` | Only jobs that ran longer than this, for example `90s` or `1h30m`. |

## Library

`lib/duration.js` exports `parseDuration(text)`, which turns `1h30m` into milliseconds
and throws a `RangeError` for text it cannot read.
