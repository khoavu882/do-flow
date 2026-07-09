# Java Coding Rules & Conventions

## Library Priority
1. Project Common libs (highest)
2. Apache Commons
3. Java API (lowest)

## Naming Quick Reference

| Element | Convention | Example |
|---------|-----------|---------|
| Variables, methods, params | lowerCamelCase | `sampleMethod`, `dayCount` |
| Classes, interfaces | UpperCamelCase | `SampleClass`, `ISample` |
| Constants | UPPER_SNAKE_CASE | `SAMPLE_VALUE` |
| Packages | all.lower.case | `test.banking.account` |
| DB tables/cols | lower_snake_case | `tbl_user_account` |

**Language**: English only. No Vietnamese or mixed names.
**Case uniqueness**: Never distinguish names by case alone. ❌ `number`/`Number` → ✅ `carNumber`/`trainNumber`

## Special Class Suffixes
- Exception → `SampleException`
- Interface → `ISample` (prefix I if needed)
- Abstract → `AbstractSample`
- Implementation → `SampleImpl`
- Capability → `Pluggable`, `Runnable` (-able suffix)
- Test class → `SampleClassTest`
- Test suite → `BankingTest`

## Database Naming
| Object | Pattern |
|--------|---------|
| Database | `db_<service>` |
| Schema | `sch_<service>` |
| Table | `tbl_<entity>` |
| Function | `fn_<name>` |
| Index | `idx_<table>_<col>` |
| Foreign Key | `fk_<table>_<ref_table>` |

## Method Naming
| Type | Pattern | Example |
|------|---------|---------|
| Factory | `create{Object}()` | `createUser()` |
| Converter | `to{Object}()` | `toString()` |
| Getter | `get{Property}()` | `getName()` |
| Setter | `set{Property}()` | `setName()` |
| Boolean | `is/can/has/exists` | `isActive()`, `hasStock()` |

- Use paired opposites: `send`/`receive`, `start`/`stop`, `open`/`close`
- No method name = class name (no constructor-like methods)

## Variable Rules
- Booleans: `isAsleep`, `canSpeak`, `hasExpired` (not `isStock` → use `hasStock`)
- Loop counters: `i`, `j`, `k`
- Short scope: abbreviations OK (`br` for BufferedReader)
- Constants: `public static final int MAX_RETRY = 3;`
- One variable per statement: `int age; int count;` not `int age, count;`
- No magic literals (except -1, 0, 1)

## Code Structure Limits
| Element | Recommended | Max |
|---------|------------|-----|
| Method lines | <20 | 150 |
| Class lines | ~600 | 1000 |
| Public methods/class | <30 | — |
| Classes/package | <10 | 20 |
| Line length | 80 chars | — |

## Access & Design
- Default to `private`; use most restrictive access modifier
- Prefer interfaces over concrete types: `List list = new ArrayList()` ✅
- `final` for constants, non-inheritable classes, optimization
- No deprecated APIs (`Calendar.getInstance()` not `new Date().getYear()`)
- Remove unused private methods/variables
- Non-public classes → no public constructors
- Avoid method overloading with same parameter count

## Formatting
- Spaces: after commas, around operators (`=`, `+`, `<=`, `&&`, `>>`)
- No space with `++`/`--`: `a++` not `a ++`
- No redundant parens: `return a + b;` not `return (a + b);`
- Boolean direct: `while(hasStock)` not `while(hasStock == true)`
- Break lines after commas, before low-priority operators

## Imports & Packages
- No `java.lang` imports (implicit)
- Specific imports over wildcards
- Group related imports

## Documentation
- Classes: `@version`, `@author`
- Methods: `@param`, `@return`, `@exception` (as applicable)
- Comments: only for non-obvious logic; no modification history
