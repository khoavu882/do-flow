# [Vendor/Service Name] Contract

> A `contract-doc:` target for `/do-execute-plan --contracts`. Points a `plan.md` task's
> `depends-on:` value (a genuine external dependency with no local repo — a vendor API, a SaaS
> integration) at this doc instead of leaving it silently skipped. `## Methods` and `## Types` are
> required — a doc missing either fails `--contracts`'s compliance check with an explicit warning,
> not a silent skip. `## Webhook` is optional; omit the whole section if this dependency never
> pushes data back. Grammar inside every section is identical to `--contracts`'s own
> generic-pseudocode fallback notation (`core/skills/do-execute-plan/contracts.md`) — one notation
> for both, nothing new to learn.

## Methods

```text
interface [Vendor]Client {
  [method1]([param1]: [Param1Type], [param2]: [Param2Type]): [Return1Type]
  [method2]([param1]: [Param1Type]): [Return2Type]
}
```

## Types

```text
type [Name] = { [field1]: [type1], [field2]: [type2] }
```

## Webhook

[Optional — delete this section entirely if this dependency never calls back into your system.]

```text
type [Name] = { [field1]: [type1], [field2]: [type2] }
```
