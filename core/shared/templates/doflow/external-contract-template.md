# [Vendor/Service Name] Contract

> An `external-contract:` target for `/do-execute-plan --scaffold`. Points a `plan.md` task's
> `depends-on:` value (a genuine external dependency with no local repo — a vendor API, a SaaS
> integration) at this doc instead of leaving it silently skipped. `## Methods` and `## Types` are required — a doc missing either fails
> the compliance check with an explicit warning, not a silent skip. `## Webhook` is optional; omit
> the whole section if this dependency never pushes data back. Grammar inside every section is
> identical to the generic-pseudocode fallback notation in
> `skills/do-execute-plan/scaffold.md` — one notation for both, nothing new to learn.
>
> The generated frame lands in `agent-docs/doflow/<slug>/scaffold/contracts/<service>/`, alongside
> the rest of that run's scaffold rather than in a `contracts/` directory of its own.

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
