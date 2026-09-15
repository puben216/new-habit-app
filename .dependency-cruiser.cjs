/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "循環依存を禁止する。",
      from: {},
      to: { circular: true },
    },
    {
      name: "domain-independence",
      severity: "error",
      comment: "Domain は Application/Infrastructure/apps に依存できない。",
      from: { path: "^packages/domain" },
      to: { path: "^(packages/application|packages/infrastructure|apps)" },
    },
    {
      name: "application-no-infrastructure",
      severity: "error",
      comment: "Application は Infrastructure/apps に依存できない。",
      from: { path: "^packages/application" },
      to: { path: "^(packages/infrastructure|apps)" },
    },
    {
      name: "no-web-to-workers",
      severity: "error",
      comment: "apps/web と apps/workers は互いに依存しない。",
      from: { path: "^apps/web" },
      to: { path: "^apps/workers" },
    },
    {
      name: "no-workers-to-web",
      severity: "error",
      from: { path: "^apps/workers" },
      to: { path: "^apps/web" },
    },
  ],
  options: {
    exclude: {
      path: "packages/infrastructure/src/generated",
    },
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.base.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
