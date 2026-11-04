# billing-lib

Money arithmetic for invoices and refunds. All amounts are plain numbers in the
currency's major unit, with two decimals.

## Rounding

`lib/round.js` exports `roundHalfUp(value, digits = 2)`. Rounding is half away from
zero: `2.675` becomes `2.68` and `-2.675` becomes `-2.68`. Every module that turns a
computed amount into money goes through it.

## Modules

- `lib/invoice.js` - `lineTotal(line)` and `invoiceTotal(lines, taxRate)`.
- `lib/refund.js` - `refundFor(line, fraction)`, a negative amount for the part of a line that is paid back.
