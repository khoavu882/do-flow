# Playwright MCP Server

**Purpose**: Real browser automation for E2E testing, visual validation, and accessibility checks

## Triggers
- End-to-end test scenarios requiring real browser interaction
- Visual regression testing and screenshot comparison
- Accessibility validation (ARIA, keyboard navigation, contrast)
- Cross-browser compatibility checks
- Form submission, navigation, and interaction testing

## Choose When
- **Over Chrome DevTools**: For functional test automation, not performance auditing
- **For E2E flows**: Login, checkout, form submission, multi-step user journeys
- **For visual testing**: Screenshot capture, layout validation at breakpoints
- **For accessibility**: ARIA labels, keyboard navigation, focus management
- **Not for**: Performance profiling — use Chrome DevTools for that

## Works Best With
- **Chrome DevTools**: Playwright validates functionality → Chrome DevTools audits performance
- **Sequential**: Sequential designs test strategy → Playwright executes validation

## Examples
```
"test the login flow" → Playwright (E2E browser automation)
"check mobile layout" → Playwright (responsive screenshot at 375px)
"verify form validation" → Playwright (interaction + assertion)
"audit accessibility" → Playwright (ARIA + keyboard navigation checks)
"measure page load time" → Chrome DevTools (performance, not Playwright)
"debug CSS layout issue" → Chrome DevTools (inspector, not Playwright)
```
