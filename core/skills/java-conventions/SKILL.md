---
name: java-conventions
description: Java coding conventions and naming standards for enterprise financial services projects. Auto-activates when editing Java files.
when_to_use: Trigger automatically for Java code review, Java implementation, Java refactoring, database-related Java changes, or convention checks involving .java files.
user-invocable: false
disable-model-invocation: false
effort: low
---

# Java Coding Conventions

## Library Priority
1. Project Common libs (highest)
2. Apache Commons
3. Java API (lowest)

## Naming
| Element | Convention | Example |
|---------|-----------|---------|
| Variables, methods | lowerCamelCase | `sampleMethod`, `dayCount` |
| Classes, interfaces | UpperCamelCase | `SampleClass`, `ISample` |
| Constants | UPPER_SNAKE_CASE | `SAMPLE_VALUE` |
| Packages | all.lower.case | `test.banking.account` |
| DB tables/cols | lower_snake_case | `tbl_user_account` |

English only. Never distinguish names by case alone.

## Special Suffixes
Exception → `SampleException` | Interface → `ISample` | Abstract → `AbstractSample` | Impl → `SampleImpl` | Test → `SampleClassTest`

## Database Naming
DB: `db_<service>` | Schema: `sch_<service>` | Table: `tbl_<entity>` | Function: `fn_<name>` | Index: `idx_<table>_<col>` | FK: `fk_<table>_<ref>`

## Method Patterns
Factory: `create{Object}()` | Converter: `to{Object}()` | Boolean: `is/can/has/exists` | Paired: `send/receive`, `start/stop`, `open/close`

## Variable Rules
- Booleans: `isAsleep`, `canSpeak`, `hasExpired`
- No magic literals (except -1, 0, 1)
- One variable per statement
- Constants: `public static final`

## Structure Limits
Method: <20 lines (max 150) | Class: ~600 lines (max 1000) | Line: 80 chars

## Access & Design
- Default to `private`; most restrictive modifier
- Prefer interfaces: `List list = new ArrayList()`
- `final` for constants, non-inheritable classes
- No deprecated APIs; remove unused private members
- Specific imports, no wildcards

## Common Defects (Financial Domain)
- Verify field length/type design before DB changes
- Add indexes for query performance
- New fields at END of table (jooq compatibility)
- Check non-null params before WHERE conditions
- Limit `SELECT *` usage
- Check for duplicate partner requests
- Ensure sufficient validation
