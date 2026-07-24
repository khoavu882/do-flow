# Chrome DevTools MCP Server

**Purpose**: Real-time browser inspection, performance auditing, and frontend debugging

## Triggers
- Performance auditing and Core Web Vitals measurement
- Layout issues, CSS debugging, rendering problems
- Network analysis, slow request identification
- Console errors and JavaScript debugging
- Memory leak investigation and heap profiling

## Choose When
- **Over Playwright**: For performance metrics, not functional testing
- **For debugging**: Real-time inspection of live browser state
- **For performance**: Lighthouse audits, network waterfall, CPU profiling
- **For layout**: CSS computed styles, box model inspection, repaint analysis
- **Not for**: Automated E2E flows — use Playwright for that

## Works Best With
- **Playwright**: Chrome DevTools audits performance → Playwright validates functionality
- **Sequential**: Chrome DevTools surfaces bottlenecks → Sequential analyzes root causes

## Examples
```
"why is this page slow?" → Chrome DevTools (Lighthouse + network waterfall)
"debug layout shift on mobile" → Chrome DevTools (CLS analysis, CSS inspection)
"find memory leak" → Chrome DevTools (heap snapshot, allocation timeline)
"check console errors" → Chrome DevTools (console log capture)
"run E2E test flow" → Playwright (functional automation, not DevTools)
```
