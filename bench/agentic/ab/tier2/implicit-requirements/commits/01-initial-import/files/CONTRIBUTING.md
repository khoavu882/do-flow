# Contributing

Thanks for helping out. Run `node --test` before you push; it needs Node 22 or newer
and nothing else.

## How the code is laid out

- `bin/cli.js` picks the command and is the only place that prints errors.
- `lib/commands/` has one file per command.
- `lib/dates.js` and `lib/errors.js` hold the shared pieces described below.

## Conventions

**A new option is not done until people can find it.** Add a row to the Options
table of its command in the README and a line under "Unreleased" in
CHANGELOG.md in the same change.

**Anything a user can get wrong on the command line is a `UsageError`**
(`lib/errors.js`). `bin/cli.js` turns it into a one line `error: ...` message on
stderr and exit code 2. A raw exception from a helper should never reach the
user as a stack trace.

**Do not call `new Date(userInput)`.** `lib/dates.js` decides what a bare date
means and how bad values fail. Ranges are inclusive at both ends, as in
`list --until`.

**Every option comes with a test** in `test/` that fails without the option. We
have merged tests that passed against a stub before, and it was not fun.
