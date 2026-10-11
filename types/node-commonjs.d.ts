// Minimal ambient declarations for the CommonJS globals DoFlow's TypeScript runtime modules use.
// DoFlow runs .ts through Node native type-stripping with ZERO dependencies (no @types/node), so
// the handful of Node globals the `.ts` bodies reference are declared here rather than pulled from
// a devDependency. Kept intentionally narrow: this is not a re-implementation of @types/node, only
// the surface the migrated modules actually touch. Extend it as more modules migrate, not ahead of
// need. See agent-docs/BRIEF_GOAL_DOFLOW.md for the migration roadmap.

declare function require(id: string): any;

declare var module: { exports: any };

declare var process: {
  features?: { typescript?: false | 'strip' | 'transform' };
  env: Record<string, string | undefined>;
  platform: string;
  argv: string[];
  cwd(): string;
};

declare var __dirname: string;
declare var __filename: string;
