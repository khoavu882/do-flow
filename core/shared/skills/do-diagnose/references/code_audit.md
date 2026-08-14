# Code Audit & Security Analysis Reference

Domain guidelines for proactive quality and security audits:

## Audit Domains
- **Quality**: Function length, cyclomatic complexity, DRY violations, error handling completeness.
- **Security**: Secret detection, SQL/command injection vulnerabilities, unvalidated input sanitization, authorization bypasses.
- **Performance**: Algorithmic complexity hotspots, memory leaks, unindexed database queries, redundant rendering.
- **Architecture**: Cyclic dependencies, boundary leaks, layer violations.

## Severity Ratings
- **Critical**: Remote execution, data corruption, hardcoded secrets.
- **High**: Functional correctness breakage, unhandled promise rejections, auth omissions.
- **Medium**: Maintainability debt, high complexity, performance degradation.
- **Low**: Code formatting, comment rot, naming conventions.
