import tseslint from "typescript-eslint";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const scopedNextConfig = nextCoreWebVitals.map((config) => ({
  ...config,
  files: config.files ?? ["apps/web/**/*.{js,jsx,ts,tsx}"],
  settings: {
    ...config.settings,
    next: { ...config.settings?.next, rootDir: "apps/web/" },
    react: { ...config.settings?.react, version: "19.3.0" },
  },
}));

const domainBoundary = {
  files: ["packages/domain/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              "@habit-app/application",
              "@habit-app/infrastructure",
              "@habit-app/contracts",
              "next",
              "next/*",
              "react",
              "react-dom",
              "@aws-sdk/*",
            ],
            message:
              "Domain は Application/Infrastructure/フレームワーク/AWS SDK に依存できません。",
          },
        ],
      },
    ],
  },
};

const applicationBoundary = {
  files: ["packages/application/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              "@habit-app/infrastructure",
              "next",
              "next/*",
              "react",
              "react-dom",
              "@aws-sdk/*",
            ],
            message: "Application は Infrastructure/フレームワーク/AWS SDK に依存できません。",
          },
        ],
      },
    ],
  },
};

const presentationBoundary = {
  files: ["apps/web/src/app/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["@habit-app/domain", "@habit-app/infrastructure"],
            message: "Presentation は Application 経由でアクセスしてください。",
          },
        ],
      },
    ],
  },
};

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**"],
  },
  ...tseslint.configs.recommended,
  ...scopedNextConfig,
  domainBoundary,
  applicationBoundary,
  presentationBoundary,
);
