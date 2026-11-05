import nextConfig from "eslint-config-next";
import tseslint from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";

const eslintConfig = tseslint.config(
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...nextConfig,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "unused-imports": unusedImports,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "unused-imports/no-unused-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/explicit-function-return-type": "warn",
    },
  },
);

export default eslintConfig;
